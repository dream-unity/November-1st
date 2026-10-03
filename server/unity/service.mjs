import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  readUnityConfig,
  serviceError,
  hash,
  CONTRACT_VERSION,
} from './config.mjs';
import {
  canonical,
  signCapability,
  verifyCapability,
  encryptContext,
  decryptContext,
} from './crypto.mjs';
import { createRedisLedger } from './ledger.mjs';
import { createOpenAIProvider } from './provider.mjs';
import {
  CANON_VERSION,
  COVERAGE,
  CORE_HASH,
  lookupKnowledge,
} from './knowledge.mjs';
import { schemas, toolDefinitions } from './contracts.mjs';
import { assertValid, validateTool } from './validate.mjs';
import { readJSON, sendJSON, sendError, startEvents } from './http.mjs';

const SCOPES = ['unity:voice:create', 'unity:text', 'unity:knowledge'];
const characterCount = (text) => Array.from(text).length;
const byteCount = (value) =>
  Buffer.byteLength(
    typeof value === 'string' ? value : JSON.stringify(value),
    'utf8',
  );
const textKey = (inviteId, turnId) => `turn:${inviteId}:${turnId}`;
const contextBinding = (inviteId, turnId) => `${inviteId}:${turnId}`;
function assertMemories(memories) {
  if (
    memories.length > 6 ||
    new Set(memories.map((m) => m.id)).size !== memories.length ||
    memories.reduce(
      (sum, m) =>
        sum +
        characterCount(m.title || '') +
        characterCount(m.text || '') +
        characterCount(m.label || ''),
      0,
    ) > 2500
  )
    throw serviceError('INVALID_INPUT', 400);
}
function assertMemoryProposal(args, memories) {
  const p = args.proposal;
  const records = new Map(memories.map((m) => [m.id, m]));
  if (p.operation === 'update_node') {
    const node = records.get(p.nodeId);
    if (node?.recordType !== 'node' || node.revision !== p.expectedRevision)
      throw serviceError('TOOL_NOT_AUTHORIZED', 409);
  }
  if (p.operation === 'update_edge') {
    const edge = records.get(p.edgeId);
    if (edge?.recordType !== 'edge' || edge.revision !== p.expectedRevision)
      throw serviceError('TOOL_NOT_AUTHORIZED', 409);
  }
  if (p.operation === 'create_edge') {
    const from = records.get(p.from);
    const to = records.get(p.to);
    if (
      p.from === p.to ||
      from?.recordType !== 'node' ||
      to?.recordType !== 'node' ||
      from.revision !== p.fromRevision ||
      to.revision !== p.toRevision
    )
      throw serviceError('TOOL_NOT_AUTHORIZED', 409);
  }
}

/** Finite real service; injection is for tests, never an automatic hosted mock. */
export function createUnityService({
  env = process.env,
  fetchImpl = fetch,
  ledger: suppliedLedger,
  provider: suppliedProvider,
  clock = () => Date.now(),
} = {}) {
  let config;
  try {
    config = readUnityConfig(env);
  } catch {
    config = { enabled: env.UNITY_AI_ENABLED === '1', ready: false };
  }
  const ledger =
    suppliedLedger ||
    (config.cleanupReady
      ? createRedisLedger({
          url: config.redisUrl,
          token: config.redisToken,
          fetchImpl,
        })
      : null);
  const provider =
    suppliedProvider ||
    (config.key
      ? createOpenAIProvider({
          key: config.key,
          fetchImpl,
          tools: toolDefinitions.tools,
        })
      : null);
  const running = new Map(); // Cancellation aid only; authorization/quotas remain shared.
  const ready = () => {
    if (!config.ready || !ledger || !provider)
      throw serviceError('SERVICE_NOT_READY', 503);
  };
  const originOf = (req) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string') throw serviceError('ORIGIN_REQUIRED', 403);
    try {
      if (new URL(origin).origin !== origin) throw new Error();
    } catch {
      throw serviceError('ORIGIN_NOT_ALLOWED', 403);
    }
    return origin;
  };
  const capability = (kind, origin, data, seconds) =>
    signCapability(
      {
        kind,
        iss: 'dream-unity',
        aud: 'unity-preview',
        origin,
        exp: clock() + seconds * 1000,
        ...data,
      },
      config.signingKey,
    );
  async function authenticate(req, scope) {
    ready();
    const origin = originOf(req);
    const auth = String(req.headers.authorization || '');
    if (!auth.startsWith('Bearer ')) throw serviceError('ACCESS_DENIED', 401);
    const claim = verifyCapability(auth.slice(7), config.signingKey, {
      kind: 'access',
      origin,
      now: clock(),
    });
    if (
      !claim.scopes?.includes(scope) ||
      !config.invites.some((item) => item.id === claim.inviteId) ||
      (await ledger.get(`revoked:invite:${claim.inviteId}`)) ||
      (await ledger.get(`revoked:token:${claim.jti}`))
    )
      throw serviceError('ACCESS_DENIED', 401);
    return { ...claim, origin };
  }
  const safetyId = (inviteId) => hash(`unity:${inviteId}`);
  const turnRecord = (inviteId, turnId, state, version) => ({
    version,
    status: state.status,
    encrypted: encryptContext(
      state,
      config.encryptionKey,
      contextBinding(inviteId, turnId),
    ),
  });
  const readTurn = (inviteId, turnId, record) =>
    decryptContext(
      record.encrypted,
      config.encryptionKey,
      contextBinding(inviteId, turnId),
    );
  async function activeTurn(inviteId, state) {
    const active = await ledger.get(
      `conversation:${inviteId}:${state.request.conversationId}`,
    );
    return (
      active?.turnId === state.request.turnId &&
      active.turnEpoch === state.request.turnEpoch &&
      active.consentEpoch === state.request.consentEpoch &&
      active.memoryRevision === state.request.memoryRevision
    );
  }
  async function setConversation(inviteId, request) {
    const name = `conversation:${inviteId}:${request.conversationId}`;
    for (let attempt = 0; attempt < 4; attempt++) {
      const prior = await ledger.get(name);
      if (
        prior &&
        (request.turnEpoch <= prior.turnEpoch ||
          request.consentEpoch < prior.consentEpoch ||
          request.memoryRevision < prior.memoryRevision)
      )
        throw serviceError('TURN_SUPERSEDED', 409);
      const next = {
        version: (prior?.version || 0) + 1,
        turnId: request.turnId,
        turnEpoch: request.turnEpoch,
        consentEpoch: request.consentEpoch,
        memoryRevision: request.memoryRevision,
      };
      const changed = prior
        ? await ledger.compareAndSwap(name, prior.version, next, 900)
        : await ledger.putIfAbsent(name, next, 900);
      if (changed) {
        if (prior) {
          running.get(textKey(inviteId, prior.turnId))?.abort();
          const oldKey = textKey(inviteId, prior.turnId);
          const old = await ledger.get(oldKey);
          if (old)
            await ledger.compareAndSwap(
              oldKey,
              old.version,
              { version: old.version + 1, status: 'cancelled' },
              900,
            );
        }
        return;
      }
    }
    throw serviceError('TURN_CONFLICT', 409);
  }

  async function access(req, res, body) {
    ready();
    assertValid(schemas.access, body);
    const origin = originOf(req);
    // Socket identity only: caller X-Forwarded-For is never a fresh quota identity.
    const identity = hash(req.socket?.remoteAddress || 'shared-proxy');
    if (
      !(await ledger.rateLimit({
        key: `access:${identity}`,
        limit: 12,
        windowSeconds: 60,
      }))
    )
      throw serviceError('ACCESS_RATE_LIMITED', 429, true);
    const codeHash = Buffer.from(hash(body.inviteCode), 'hex');
    const invite = config.invites.find((item) =>
      timingSafeEqual(Buffer.from(item.hash, 'hex'), codeHash),
    );
    if (!invite || (await ledger.get(`revoked:invite:${invite.id}`)))
      throw serviceError('ACCESS_DENIED', 401);
    const jti = randomUUID();
    const expiresAt = clock() + 900000;
    const accessToken = capability(
      'access',
      origin,
      { inviteId: invite.id, jti, scopes: SCOPES },
      900,
    );
    sendJSON(res, 200, {
      version: 1,
      accessToken,
      expiresAt: new Date(expiresAt).toISOString(),
      scopes: SCOPES,
      limits: config.limits,
      canonVersion: CANON_VERSION,
    });
  }

  async function realtime(req, res, body) {
    const auth = await authenticate(req, 'unity:voice:create');
    assertValid(schemas.realtimeStart, body);
    assertMemories(body.consentedMemories);
    if (body.canonVersion !== CANON_VERSION)
      throw serviceError('CANON_VERSION_MISMATCH', 409);
    const now = clock();
    const sessionId = randomUUID();
    const bodyHash = hash(canonical(body));
    const admission = await ledger.admitVoice({
      inviteId: auth.inviteId,
      attemptId: body.attemptId,
      bodyHash,
      sessionId,
      nowMs: now,
      limits: config.limits,
    });
    if (admission.status === 'conflict')
      throw serviceError('IDEMPOTENCY_CONFLICT', 409);
    if (admission.status === 'limited')
      throw serviceError('VOICE_QUOTA_REACHED', 429);
    if (admission.status === 'duplicate') {
      if (admission.record.status !== 'ready')
        throw serviceError('CREATION_UNCONFIRMED', 409);
      return sendJSON(
        res,
        200,
        decryptContext(
          admission.record.result,
          config.encryptionKey,
          `voice:${auth.inviteId}:${body.attemptId}`,
        ),
      );
    }
    if (
      admission.status !== 'admitted' ||
      admission.record?.status !== 'starting' ||
      admission.record.inviteId !== auth.inviteId ||
      admission.record.attemptId !== body.attemptId ||
      admission.record.sessionId !== sessionId ||
      admission.record.bodyHash !== bodyHash
    )
      throw serviceError('SERVICE_NOT_READY', 503);
    let created;
    try {
      created = await provider.createRealtime({
        sdp: body.sdp,
        locale: body.locale,
        memories: body.consentedMemories,
        safetyId: safetyId(auth.inviteId),
        signal: AbortSignal.timeout(30000),
      });
      const result = {
        version: 1,
        sessionId,
        transport: { type: 'webrtc', sdp: created.sdp },
        closeToken: capability(
          'close',
          auth.origin,
          { inviteId: auth.inviteId, sessionId },
          5400,
        ),
        clientDeadlineAt: new Date(now + 720000).toISOString(),
        canonVersion: CANON_VERSION,
        actionSchemaVersion: CONTRACT_VERSION,
        limits: config.limits,
      };
      await ledger.commitVoice({
        inviteId: auth.inviteId,
        attemptId: body.attemptId,
        sessionId,
        record: {
          ...admission.record,
          status: 'ready',
          callId: created.callId,
          result: encryptContext(
            result,
            config.encryptionKey,
            `voice:${auth.inviteId}:${body.attemptId}`,
          ),
        },
      });
      if (res.destroyed) {
        try {
          await provider.hangup(created.callId, AbortSignal.timeout(10000));
          await ledger.releaseVoice({ inviteId: auth.inviteId, sessionId });
        } catch {
          /* Reservation remains held; cleanup was unconfirmed. */
        }
        return;
      }
      sendJSON(res, 201, result);
    } catch (error) {
      const callId = created?.callId || error.callId;
      if (callId) {
        try {
          await provider.hangup(callId, AbortSignal.timeout(10000));
          await ledger.releaseVoice({ inviteId: auth.inviteId, sessionId });
        } catch {
          /* Retain reservation on unknown teardown. */
        }
      } else if (error.definitiveNoCall) {
        await ledger.put(
          `attempt:${auth.inviteId}:${body.attemptId}`,
          { ...admission.record, status: 'rejected' },
          5400,
        );
        await ledger.releaseVoice({ inviteId: auth.inviteId, sessionId });
      }
      // A missing Location can leave an unknown live call. Never refund/reissue it.
      throw error;
    }
  }

  async function close(req, res, body) {
    // Operator disable blocks creation but must still allow owned cleanup.
    if (!config.cleanupReady || !ledger || !provider)
      throw serviceError('SERVICE_NOT_READY', 503);
    assertValid(schemas.sessionClose, body);
    const origin = originOf(req);
    const claim = verifyCapability(body.closeToken, config.signingKey, {
      kind: 'close',
      origin,
      now: clock(),
    });
    if (claim.sessionId !== body.sessionId)
      throw serviceError('ACCESS_DENIED', 401);
    const record = await ledger.get(`session:${body.sessionId}`);
    if (!record || record.inviteId !== claim.inviteId)
      throw serviceError('SESSION_UNAVAILABLE', 404);
    if (record.status === 'closed')
      return sendJSON(res, 200, { version: 1, status: 'already_closed' });
    try {
      await provider.hangup(record.callId, AbortSignal.timeout(10000));
      await ledger.put(
        `session:${body.sessionId}`,
        { ...record, status: 'closed' },
        5400,
      );
      await ledger.put(
        `attempt:${record.inviteId}:${record.attemptId}`,
        { ...record, status: 'closed' },
        5400,
      );
      await ledger.releaseVoice({
        inviteId: record.inviteId,
        sessionId: body.sessionId,
      });
      sendJSON(res, 200, { version: 1, status: 'closed' });
    } catch {
      sendJSON(res, 202, { version: 1, status: 'closing_unconfirmed' });
    }
  }

  async function executeText(inviteId, record, state, req, res) {
    const name = textKey(inviteId, state.request.turnId);
    const send = startEvents(res);
    const controller = new AbortController();
    running.set(name, controller);
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    let emittedText = '';
    let usage = null;
    try {
      while (state.round < 3) {
        if (!(await activeTurn(inviteId, state)) || controller.signal.aborted)
          throw serviceError('TURN_SUPERSEDED', 409);
        // Reserve each round in the versioned shared turn before a provider call.
        const runningState = {
          ...state,
          status: 'running',
          round: state.round + 1,
        };
        const nextRecord = turnRecord(
          inviteId,
          state.request.turnId,
          runningState,
          record.version + 1,
        );
        if (
          !(await ledger.compareAndSwap(name, record.version, nextRecord, 900))
        )
          throw serviceError('TURN_SUPERSEDED', 409);
        record = nextRecord;
        state = runningState;
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(45000),
        ]);
        const response = await provider.text({
          input: state.input,
          memories: state.request.consentedMemories,
          safetyId: safetyId(inviteId),
          signal,
          onDelta: (text) => {
            if (!controller.signal.aborted) {
              emittedText += text;
              send('text.delta', { turnId: state.request.turnId, text });
            }
          },
        });
        const current = await ledger.get(name);
        if (
          current?.version !== record.version ||
          !(await activeTurn(inviteId, state)) ||
          controller.signal.aborted
        )
          throw serviceError('TURN_SUPERSEDED', 409);
        usage = {
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
        };
        const calls = response.output.filter(
          (item) => item.type === 'function_call',
        );
        if (calls.length > 1)
          throw serviceError('PROVIDER_INVALID_RESPONSE', 502);
        if (!calls.length) {
          await ledger.compareAndSwap(
            name,
            record.version,
            { version: record.version + 1, status: 'complete' },
            900,
          );
          send('turn.complete', {
            turnId: state.request.turnId,
            text: emittedText,
            usage,
          });
          res.end();
          return;
        }
        const call = calls[0];
        let args;
        try {
          args = JSON.parse(call.arguments);
        } catch {
          throw serviceError('INVALID_TOOL_CALL', 502);
        }
        if (
          !validateTool(call.name, args).valid ||
          typeof call.call_id !== 'string' ||
          call.call_id.length > 256
        )
          throw serviceError('INVALID_TOOL_CALL', 502);
        if (call.name === 'propose_memory')
          assertMemoryProposal(args, state.request.consentedMemories);
        if (state.round >= 3) throw serviceError('TOOL_BUDGET_EXHAUSTED', 409);
        const nextInput = [...state.input, ...response.output];
        if (byteCount(nextInput) > 128 * 1024)
          throw serviceError('CONTEXT_LIMIT_REACHED', 413);
        if (call.name === 'lookup_knowledge') {
          const result = lookupKnowledge({
            ...args,
            canonVersion: CANON_VERSION,
          });
          state = {
            ...state,
            input: [
              ...nextInput,
              {
                type: 'function_call_output',
                call_id: call.call_id,
                output: JSON.stringify(result),
              },
            ],
          };
          continue;
        }
        const actionId = randomUUID();
        const action = {
          version: 1,
          sessionId: state.request.conversationId,
          turnId: state.request.turnId,
          requestId: actionId,
          routeEpoch: state.request.routeEpoch,
          consentEpoch: state.request.consentEpoch,
          memoryRevision: state.request.memoryRevision,
          tool: { name: call.name, args },
        };
        assertValid(schemas.actionRequest, action);
        const binding = {
          inviteId,
          turnId: state.request.turnId,
          actionId,
          originatingRequestId: state.request.requestId,
          providerCallId: call.call_id,
          name: call.name,
          argsHash: hash(canonical(args)),
          contextHash: hash(canonical(nextInput)),
          round: state.round,
          consentEpoch: state.request.consentEpoch,
          memoryRevision: state.request.memoryRevision,
        };
        const continuationToken = capability(
          'continuation',
          state.origin,
          binding,
          900,
        );
        const waiting = {
          ...state,
          status: 'waiting',
          input: nextInput,
          pending: { ...binding, continuationToken, action },
        };
        if (
          !(await ledger.compareAndSwap(
            name,
            record.version,
            turnRecord(
              inviteId,
              state.request.turnId,
              waiting,
              record.version + 1,
            ),
            900,
          ))
        )
          throw serviceError('TURN_SUPERSEDED', 409);
        send('action.request', {
          turnId: state.request.turnId,
          action,
          actionId,
          continuationToken,
        });
        res.end();
        return;
      }
      throw serviceError('TOOL_BUDGET_EXHAUSTED', 409);
    } catch (error) {
      const current = await ledger.get(name).catch(() => null);
      if (current?.version === record.version)
        await ledger
          .compareAndSwap(
            name,
            record.version,
            { version: record.version + 1, status: 'cancelled' },
            900,
          )
          .catch(() => {});
      const code = controller.signal.aborted
        ? 'TURN_CANCELLED'
        : error.code ||
          (error.name === 'TimeoutError' ? 'TURN_TIMEOUT' : 'TURN_UNAVAILABLE');
      send('turn.error', {
        turnId: state.request.turnId,
        code,
        message: code,
        retryable: Boolean(error.retryable),
      });
      res.end();
    } finally {
      if (running.get(name) === controller) running.delete(name);
      req.off('aborted', disconnected);
      res.off('close', disconnected);
    }
  }

  async function turns(req, res, body) {
    const auth = await authenticate(req, 'unity:text');
    assertValid(schemas.textTurn, body);
    const name = textKey(auth.inviteId, body.turnId);
    if (body.kind === 'cancel') {
      running.get(name)?.abort();
      const record = await ledger.get(name);
      if (record)
        await ledger.compareAndSwap(
          name,
          record.version,
          { version: record.version + 1, status: 'cancelled' },
          900,
        );
      return sendJSON(res, 200, {
        version: 1,
        turnId: body.turnId,
        status: 'cancelled',
      });
    }
    if (body.kind === 'start') {
      assertMemories(body.consentedMemories);
      if (byteCount(body.message) > 8192 || byteCount(body.history) > 24576)
        throw serviceError('BODY_TOO_LARGE', 413);
      const admission = await ledger.reserveTextTurn({
        inviteId: auth.inviteId,
        turnId: body.turnId,
        bodyHash: hash(canonical(body)),
        nowMs: clock(),
        limits: config.limits,
      });
      if (admission.status === 'limited')
        throw serviceError('TEXT_QUOTA_REACHED', 429);
      if (admission.status !== 'admitted')
        throw serviceError(
          admission.status === 'conflict'
            ? 'IDEMPOTENCY_CONFLICT'
            : 'TURN_ALREADY_STARTED',
          409,
        );
      await setConversation(auth.inviteId, body);
      const state = {
        status: 'ready',
        origin: auth.origin,
        request: body,
        round: 0,
        input: [
          ...body.history.map((m) => ({ role: m.role, content: m.content })),
          {
            role: 'user',
            content: `Current app state (data): ${JSON.stringify(body.uiContext)}\nUser intention: ${body.message}`,
          },
        ],
      };
      const record = turnRecord(auth.inviteId, body.turnId, state, 1);
      if (!(await ledger.putIfAbsent(name, record, 900)))
        throw serviceError('TURN_ALREADY_STARTED', 409);
      return executeText(auth.inviteId, record, state, req, res);
    }
    const record = await ledger.get(name);
    if (!record?.encrypted || record.status !== 'waiting')
      throw serviceError('CONTINUATION_UNAVAILABLE', 409);
    const state = readTurn(auth.inviteId, body.turnId, record);
    const claim = verifyCapability(body.continuationToken, config.signingKey, {
      kind: 'continuation',
      origin: auth.origin,
      now: clock(),
    });
    const pending = state.pending;
    const fields = [
      'inviteId',
      'turnId',
      'actionId',
      'originatingRequestId',
      'providerCallId',
      'name',
      'argsHash',
      'contextHash',
      'round',
      'consentEpoch',
      'memoryRevision',
    ];
    if (
      !pending ||
      fields.some((key) => claim[key] !== pending[key]) ||
      claim.inviteId !== auth.inviteId ||
      body.actionId !== pending.actionId ||
      body.result.requestId !== pending.actionId ||
      body.result.routeEpoch !== pending.action.routeEpoch ||
      !(await activeTurn(auth.inviteId, state))
    )
      throw serviceError('CONTINUATION_MISMATCH', 409);
    let nextRequest = state.request;
    if (
      ['navigate', 'return_to_previous'].includes(pending.name) &&
      body.result.status === 'applied' &&
      body.result.observedState &&
      body.result.observedState.destination !==
        state.request.uiContext.destination
    ) {
      // The receipt still echoes its original action epoch. Only this exact
      // authenticated, bound navigation result advances the NEXT action epoch.
      // Never take a caller/model-supplied increment or an unrelated tool state.
      if (!Number.isSafeInteger(state.request.routeEpoch + 1))
        throw serviceError('ROUTE_EPOCH_EXHAUSTED', 409);
      nextRequest = {
        ...state.request,
        routeEpoch: state.request.routeEpoch + 1,
        uiContext: body.result.observedState,
      };
    }
    const nextState = {
      ...state,
      request: nextRequest,
      status: 'ready',
      pending: null,
      input: [
        ...state.input,
        {
          type: 'function_call_output',
          call_id: pending.providerCallId,
          output: JSON.stringify(body.result),
        },
      ],
    };
    if (byteCount(nextState.input) > 128 * 1024)
      throw serviceError('CONTEXT_LIMIT_REACHED', 413);
    const nextRecord = turnRecord(
      auth.inviteId,
      body.turnId,
      nextState,
      record.version + 1,
    );
    if (!(await ledger.compareAndSwap(name, record.version, nextRecord, 900)))
      throw serviceError('CONTINUATION_USED', 409);
    return executeText(auth.inviteId, nextRecord, nextState, req, res);
  }

  return async function unityMiddleware(req, res, next) {
    const pathname = (req.url || '/').split('?')[0];
    const routes = {
      '/access': [schemas.access, 2048, access],
      '/realtime': [schemas.realtimeStart, 65536, realtime],
      '/sessions/close': [schemas.sessionClose, 2048, close],
      '/turns': [schemas.textTurn, 65536, turns],
    };
    let body;
    try {
      if (pathname === '/status' && ['GET', 'HEAD'].includes(req.method)) {
        return sendJSON(res, 200, {
          version: 1,
          enabled: Boolean(config.enabled),
          ready: Boolean(config.ready),
          access: 'invite',
          voiceConfigured: Boolean(config.key),
          textConfigured: Boolean(config.key),
          canonVersion: CANON_VERSION,
          actionSchemaVersion: CONTRACT_VERSION,
          coverage: COVERAGE,
          coreHash: CORE_HASH,
          reason: config.ready ? null : 'SERVICE_NOT_READY',
          limits: config.limits || {},
        });
      }
      if (pathname === '/knowledge' && req.method === 'POST') {
        const auth = await authenticate(req, 'unity:knowledge');
        body = await readJSON(req, 4096);
        assertValid(schemas.knowledgeRequest, body);
        if (
          !(await ledger.rateLimit({
            key: `knowledge:${auth.inviteId}`,
            limit: 60,
            windowSeconds: 60,
          }))
        )
          throw serviceError('KNOWLEDGE_RATE_LIMITED', 429, true);
        return sendJSON(res, 200, lookupKnowledge(body));
      }
      const route = routes[pathname];
      if (!route) throw serviceError('API_ROUTE_NOT_FOUND', 404);
      if (req.method !== 'POST') throw serviceError('METHOD_NOT_ALLOWED', 405);
      body = await readJSON(req, route[1]);
      assertValid(route[0], body);
      await route[2](req, res, body);
    } catch (error) {
      sendError(res, error, body?.requestId);
    }
  };
}
