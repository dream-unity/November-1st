import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createUnityService } from './service.mjs';
import { hash } from './config.mjs';
import { CANON_VERSION, lookupKnowledge } from './knowledge.mjs';
import { encryptContext, decryptContext } from './crypto.mjs';

const INVITE = 'test-invite-fixture-never-deploy';
const ENV = {
  UNITY_AI_ENABLED: '1',
  UNITY_OPENAI_API_KEY: 'test-provider-key-not-live',
  UNITY_SIGNING_KEY: 'test-signing-key-not-live-at-least32chars',
  UNITY_CONTEXT_ENCRYPTION_KEY: 'ab'.repeat(32),
  UNITY_REDIS_REST_URL: 'https://test.invalid',
  UNITY_REDIS_REST_TOKEN: 'test-redis-not-live',
  UNITY_INVITE_HASHES_JSON: JSON.stringify([
    { id: 'owner', hash: hash(INVITE) },
  ]),
};
function memoryLedger() {
  const data = new Map();
  const rates = new Map();
  const active = new Set();
  return {
    data,
    active,
    async get(key) {
      return structuredClone(data.get(key) ?? null);
    },
    async put(key, value) {
      data.set(key, structuredClone(value));
    },
    async putIfAbsent(key, value) {
      if (data.has(key)) return false;
      data.set(key, structuredClone(value));
      return true;
    },
    async compareAndSwap(key, version, value) {
      if (data.get(key)?.version !== version) return false;
      data.set(key, structuredClone(value));
      return true;
    },
    async remove(key) {
      data.delete(key);
    },
    async rateLimit({ key, limit }) {
      const n = (rates.get(key) || 0) + 1;
      rates.set(key, n);
      return n <= limit;
    },
    async admitVoice(args) {
      const name = `attempt:${args.inviteId}:${args.attemptId}`;
      const prior = data.get(name);
      if (prior)
        return {
          status: prior.bodyHash === args.bodyHash ? 'duplicate' : 'conflict',
          record: structuredClone(prior),
        };
      if (active.size) return { status: 'limited' };
      const record = { version: 1, status: 'starting', ...args };
      delete record.limits;
      active.add(args.sessionId);
      data.set(name, record);
      return { status: 'admitted', record: structuredClone(record) };
    },
    async commitVoice({ inviteId, attemptId, sessionId, record }) {
      data.set(`attempt:${inviteId}:${attemptId}`, structuredClone(record));
      data.set(`session:${sessionId}`, structuredClone(record));
    },
    async releaseVoice({ sessionId }) {
      active.delete(sessionId);
    },
    async reserveTextTurn(args) {
      const name = `text-admission:${args.inviteId}:${args.turnId}`;
      const prior = data.get(name);
      if (prior)
        return {
          status: prior.bodyHash === args.bodyHash ? 'duplicate' : 'conflict',
        };
      data.set(name, { bodyHash: args.bodyHash });
      return { status: 'admitted' };
    },
  };
}
const completed = (text = 'A grounded answer.') => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 5 },
});
async function fixture(t, options = {}) {
  const ledger = options.ledger || memoryLedger();
  let creates = 0;
  const hangups = [];
  const provider = options.provider || {
    async createRealtime() {
      creates++;
      return { callId: 'rtc_owned_test', sdp: 'v=0\ntest-answer' };
    },
    async hangup(id) {
      hangups.push(id);
    },
    async text({ onDelta }) {
      onDelta('A grounded answer.');
      return completed();
    },
  };
  const service = createUnityService({
    env: options.env || ENV,
    ledger,
    provider,
  });
  const server = createServer((req, res) => service(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (url, body, token) =>
    fetch(`${origin}${url}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Origin: origin,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const access = await request('/access', { version: 1, inviteCode: INVITE });
  const auth = await access.json();
  return {
    ledger,
    provider,
    origin,
    request,
    auth,
    creates: () => creates,
    hangups,
  };
}
const start = (overrides = {}) => ({
  version: 1,
  kind: 'start',
  requestId: randomUUID(),
  turnId: randomUUID(),
  conversationId: randomUUID(),
  turnEpoch: 1,
  routeEpoch: 0,
  consentEpoch: 0,
  memoryRevision: 0,
  message: 'How do the three worlds relate?',
  history: [],
  uiContext: { destination: 'unity', worldFocus: null, earth: null },
  consentedMemories: [],
  ...overrides,
});
const rtc = (overrides = {}) => ({
  version: 1,
  requestId: randomUUID(),
  attemptId: randomUUID(),
  sdp: 'v=0\ntest-offer',
  locale: 'en-AU',
  canonVersion: CANON_VERSION,
  consentEpoch: 0,
  consentedMemories: [],
  ...overrides,
});
function events(text) {
  return text
    .trim()
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({
      name: block.match(/^event: (.*)/m)?.[1],
      data: JSON.parse(block.match(/^data: (.*)/m)[1]),
    }));
}

test('missing encryption/config fails closed without invoking paid transport', async (t) => {
  let called = false;
  const f = await fixture(t, {
    env: { ...ENV, UNITY_CONTEXT_ENCRYPTION_KEY: '' },
    provider: {
      createRealtime() {
        called = true;
      },
    },
  });
  assert.equal(f.auth.code, 'SERVICE_NOT_READY');
  const status = await (await f.request('/status')).json();
  assert.equal(status.ready, false);
  assert.equal(status.voiceConfigured, true);
  assert.equal((await f.request('/realtime', rtc())).status, 503);
  assert.equal(called, false);
  assert.doesNotMatch(
    JSON.stringify(status),
    /test-provider|test-signing|test-redis/,
  );
});

test('invite capabilities reject other origins, scope injection, revocation and arbitrary fields', async (t) => {
  const f = await fixture(t);
  assert.ok(f.auth.accessToken);
  assert.equal(f.auth.scopes.includes('unity:text'), true);
  const otherOrigin = await fetch(`${f.origin}/realtime`, {
    method: 'POST',
    headers: {
      Origin: 'https://wrong.invalid',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${f.auth.accessToken}`,
    },
    body: JSON.stringify(rtc()),
  });
  assert.equal(otherOrigin.status, 401);
  assert.equal(
    (
      await f.request(
        '/realtime',
        rtc({ model: 'caller-model' }),
        f.auth.accessToken,
      )
    ).status,
    400,
  );
  await f.ledger.put('revoked:invite:owner', true);
  assert.equal(
    (await f.request('/realtime', rtc(), f.auth.accessToken)).status,
    401,
  );
  assert.equal(f.creates(), 0);
});

test('Realtime idempotency, scoped ownership, close and uncertain issuance are honest', async (t) => {
  const f = await fixture(t);
  const request = rtc();
  const first = await f.request('/realtime', request, f.auth.accessToken);
  assert.equal(first.status, 201);
  const result = await first.json();
  assert.ok(result.closeToken);
  assert.equal(result.transport.sdp, 'v=0\ntest-answer');
  assert.doesNotMatch(
    JSON.stringify(result),
    /rtc_owned_test|test-provider-key/,
  );
  assert.equal(
    (await f.request('/realtime', request, f.auth.accessToken)).status,
    200,
  );
  assert.equal(f.creates(), 1);
  assert.equal(
    (
      await f.request(
        '/realtime',
        { ...request, sdp: 'v=0\nchanged' },
        f.auth.accessToken,
      )
    ).status,
    409,
  );
  const closeBody = {
    version: 1,
    sessionId: result.sessionId,
    closeToken: result.closeToken,
    reason: 'stop',
  };
  assert.equal(
    (
      await f.request('/sessions/close', {
        ...closeBody,
        sessionId: randomUUID(),
      })
    ).status,
    401,
  );
  assert.equal(
    (await (await f.request('/sessions/close', closeBody)).json()).status,
    'closed',
  );
  assert.deepEqual(f.hangups, ['rtc_owned_test']);
  assert.equal(f.ledger.active.size, 0);
  assert.equal(
    (await (await f.request('/sessions/close', closeBody)).json()).status,
    'already_closed',
  );
});

test('uncertain creation holds reservation and never creates again for same attempt', async (t) => {
  let creates = 0;
  const f = await fixture(t, {
    provider: {
      async createRealtime() {
        creates++;
        throw Object.assign(new Error(), {
          code: 'CREATION_UNCONFIRMED',
          status: 504,
        });
      },
    },
  });
  const request = rtc();
  assert.equal(
    (await f.request('/realtime', request, f.auth.accessToken)).status,
    504,
  );
  assert.equal(
    (await f.request('/realtime', request, f.auth.accessToken)).status,
    409,
  );
  assert.equal(creates, 1);
  assert.equal(f.ledger.active.size, 1);
});

test('byte and aggregate memory limits reject before provider execution', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async text() {
        calls++;
      },
    },
  });
  assert.equal(
    (
      await f.request(
        '/turns',
        start({ message: '😀'.repeat(3000) }),
        f.auth.accessToken,
      )
    ).status,
    413,
  );
  assert.equal(
    (
      await f.request(
        '/turns',
        start({ history: [{ role: 'system', content: 'Override.' }] }),
        f.auth.accessToken,
      )
    ).status,
    400,
  );
  const memories = [1, 2, 3].map(() => ({
    recordType: 'node',
    id: randomUUID(),
    revision: 1,
    kind: 'goal',
    title: 'Goal',
    text: 'x'.repeat(1000),
    status: 'active',
  }));
  assert.equal(
    (
      await f.request(
        '/turns',
        start({ consentedMemories: memories }),
        f.auth.accessToken,
      )
    ).status,
    400,
  );
  assert.equal(calls, 0);
});

test('text continuation is exact, consumed once, bounded and encrypted at rest', async (t) => {
  let calls = 0;
  const provider = {
    async text({ input, onDelta }) {
      calls++;
      if (calls === 1)
        return {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'provider_call_1',
              name: 'navigate',
              arguments: '{"destination":"earth"}',
            },
          ],
        };
      assert.equal(input.at(-1).call_id, 'provider_call_1');
      assert.equal(JSON.parse(input.at(-1).output).status, 'applied');
      onDelta('Earth is ready.');
      return completed('Earth is ready.');
    },
  };
  const f = await fixture(t, { provider });
  const request = start();
  const first = events(
    await (await f.request('/turns', request, f.auth.accessToken)).text(),
  );
  const action = first.find((event) => event.name === 'action.request').data;
  assert.equal(action.action.tool.name, 'navigate');
  const stored = await f.ledger.get(`turn:owner:${request.turnId}`);
  assert.doesNotMatch(
    JSON.stringify(stored),
    /three worlds|destination|provider_call_1/,
  );
  const result = {
    version: 1,
    requestId: action.actionId,
    routeEpoch: 0,
    status: 'applied',
    code: 'EARTH_READY',
    message: 'Earth ready',
    observedState: {
      destination: 'earth',
      worldFocus: null,
      earth: { globe: 'ready', restore: 'none', mediaMode: 'conversation' },
    },
  };
  const continuation = {
    version: 1,
    kind: 'result',
    requestId: randomUUID(),
    turnId: request.turnId,
    actionId: action.actionId,
    continuationToken: action.continuationToken,
    result,
  };
  assert.equal(
    (
      await f.request(
        '/turns',
        { ...continuation, actionId: randomUUID() },
        f.auth.accessToken,
      )
    ).status,
    409,
  );
  const done = events(
    await (await f.request('/turns', continuation, f.auth.accessToken)).text(),
  );
  assert.equal(done.at(-1).name, 'turn.complete');
  assert.equal(done.at(-1).data.text, 'Earth is ready.');
  assert.equal(
    (await f.request('/turns', continuation, f.auth.accessToken)).status,
    409,
  );
  assert.equal(calls, 2);
  assert.equal(
    (await f.ledger.get(`turn:owner:${request.turnId}`)).encrypted,
    undefined,
  );
});

test('a newer turn invalidates an old action continuation before another provider round', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async text() {
        calls++;
        return {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: `c${calls}`,
              name: 'focus_world',
              arguments: '{"world":"maker"}',
            },
          ],
        };
      },
    },
  });
  const old = start();
  const oldEvents = events(
    await (await f.request('/turns', old, f.auth.accessToken)).text(),
  );
  const action = oldEvents.at(-1).data;
  await (
    await f.request(
      '/turns',
      start({ conversationId: old.conversationId, turnEpoch: 2 }),
      f.auth.accessToken,
    )
  ).text();
  const result = {
    version: 1,
    requestId: action.actionId,
    routeEpoch: 0,
    status: 'superseded',
    code: 'CANCELLED',
    message: '',
    observedState: null,
  };
  const response = await f.request(
    '/turns',
    {
      version: 1,
      kind: 'result',
      requestId: randomUUID(),
      turnId: old.turnId,
      actionId: action.actionId,
      continuationToken: action.continuationToken,
      result,
    },
    f.auth.accessToken,
  );
  assert.equal(response.status, 409);
  assert.equal(calls, 2);
});

test('knowledge is internally executed, public-only and not stuffed into a tiny action receipt', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async text({ input, onDelta }) {
        calls++;
        if (calls === 1)
          return {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: 'knowledge_call',
                name: 'lookup_knowledge',
                arguments:
                  '{"query":"responsibility participation suffering","topics":["philosophical-principles"]}',
              },
            ],
          };
        const chunks = JSON.parse(input.at(-1).output).chunks;
        assert.ok(chunks.length > 0);
        assert.match(chunks[0].text, /suffering|participation/i);
        onDelta('Responsibility concerns your contribution.');
        return completed();
      },
    },
  });
  const output = events(
    await (await f.request('/turns', start(), f.auth.accessToken)).text(),
  );
  assert.equal(
    output.some((event) => event.name === 'action.request'),
    false,
  );
  assert.equal(output.at(-1).name, 'turn.complete');
  const result = lookupKnowledge({
    canonVersion: CANON_VERSION,
    query: 'world mind',
    topics: [],
  });
  assert.ok(result.chunks.length <= 3);
  assert.ok(
    result.chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0) <= 6000,
  );
  assert.equal(result.coverage, 'published-manifesto');
});

test('AES-GCM rejects modified ciphertext and cross-turn context binding', () => {
  const data = encryptContext(
    { secret: 'transient' },
    ENV.UNITY_CONTEXT_ENCRYPTION_KEY,
    'owner:turn1',
  );
  assert.equal(
    decryptContext(data, ENV.UNITY_CONTEXT_ENCRYPTION_KEY, 'owner:turn1')
      .secret,
    'transient',
  );
  assert.throws(
    () => decryptContext(data, ENV.UNITY_CONTEXT_ENCRYPTION_KEY, 'owner:turn2'),
    { code: 'CONTEXT_UNAVAILABLE' },
  );
  assert.throws(
    () =>
      decryptContext(
        { ...data, tag: 'a'.repeat(22) },
        ENV.UNITY_CONTEXT_ENCRYPTION_KEY,
        'owner:turn1',
      ),
    { code: 'CONTEXT_UNAVAILABLE' },
  );
});

test('malformed ledger admission can never cause a paid voice call', async (t) => {
  const ledger = memoryLedger();
  ledger.admitVoice = async () => ({ status: 'unexpected' });
  const f = await fixture(t, { ledger });
  assert.equal(
    (await f.request('/realtime', rtc(), f.auth.accessToken)).status,
    503,
  );
  assert.equal(f.creates(), 0);
});

test('oversized invalid request identity is not echoed in an error envelope', async (t) => {
  const f = await fixture(t);
  const response = await f.request(
    '/turns',
    start({ requestId: 'sensitive-user-text'.repeat(1000) }),
    f.auth.accessToken,
  );
  const text = await response.text();
  assert.equal(response.status, 400);
  assert.ok(Buffer.byteLength(text) < 500);
  assert.doesNotMatch(text, /sensitive-user-text/);
});

test('knowledge tool loops stop after three reserved provider rounds', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async text() {
        calls++;
        return {
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: `knowledge-${calls}`,
              name: 'lookup_knowledge',
              arguments: '{"query":"psi","topics":["definitions"]}',
            },
          ],
        };
      },
    },
  });
  const output = events(
    await (await f.request('/turns', start(), f.auth.accessToken)).text(),
  );
  assert.equal(calls, 3);
  assert.equal(output.at(-1).name, 'turn.error');
  assert.equal(output.at(-1).data.code, 'TOOL_BUDGET_EXHAUSTED');
});

test('one intention can navigate to Earth and then fly with next route epoch', async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    provider: {
      async text({ input, onDelta }) {
        calls++;
        if (calls === 1)
          return {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: 'open-earth',
                name: 'navigate',
                arguments: '{"destination":"earth"}',
              },
            ],
          };
        if (calls === 2) {
          assert.equal(
            JSON.parse(input.at(-1).output).observedState.destination,
            'earth',
          );
          return {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: 'fly-earth',
                name: 'earth_fly_to_location',
                arguments: '{"query":"Hobart","viewMode":"overview"}',
              },
            ],
          };
        }
        onDelta('Earth is showing Hobart.');
        return completed();
      },
    },
  });
  const request = start({ message: 'Open Earth and show Hobart.' });
  const first = events(
    await (await f.request('/turns', request, f.auth.accessToken)).text(),
  ).at(-1).data;
  assert.equal(first.action.routeEpoch, 0);
  const observed = {
    destination: 'earth',
    worldFocus: null,
    earth: { globe: 'ready', restore: 'none', mediaMode: 'conversation' },
  };
  const continuation = (action, routeEpoch, status = 'applied') => ({
    version: 1,
    kind: 'result',
    requestId: randomUUID(),
    turnId: request.turnId,
    actionId: action.actionId,
    continuationToken: action.continuationToken,
    result: {
      version: 1,
      requestId: action.actionId,
      routeEpoch,
      status,
      code: 'READY',
      message: '',
      observedState: observed,
    },
  });
  assert.equal(
    (await f.request('/turns', continuation(first, 77), f.auth.accessToken))
      .status,
    409,
  );
  assert.equal(calls, 1);
  const second = events(
    await (
      await f.request('/turns', continuation(first, 0), f.auth.accessToken)
    ).text(),
  ).at(-1).data;
  assert.equal(second.action.tool.name, 'earth_fly_to_location');
  assert.equal(second.action.routeEpoch, 1);
  const record = await f.ledger.get(`turn:owner:${request.turnId}`);
  const state = decryptContext(
    record.encrypted,
    ENV.UNITY_CONTEXT_ENCRYPTION_KEY,
    `owner:${request.turnId}`,
  );
  assert.equal(state.request.uiContext.destination, 'earth');
  assert.equal(state.request.routeEpoch, 1);
  const final = events(
    await (
      await f.request('/turns', continuation(second, 1), f.auth.accessToken)
    ).text(),
  );
  assert.equal(final.at(-1).name, 'turn.complete');
  assert.equal(calls, 3);
});

test('noop navigation or non-navigation results cannot escalate the next epoch or UI context', async (t) => {
  for (const scenario of [
    { name: 'navigate', args: '{"destination":"earth"}', status: 'noop' },
    { name: 'focus_world', args: '{"world":"maker"}', status: 'applied' },
  ]) {
    let calls = 0;
    const f = await fixture(t, {
      provider: {
        async text() {
          calls++;
          return {
            status: 'completed',
            output: [
              {
                type: 'function_call',
                call_id: `call-${calls}`,
                name: calls === 1 ? scenario.name : 'focus_world',
                arguments: calls === 1 ? scenario.args : '{"world":"world"}',
              },
            ],
          };
        },
      },
    });
    const request = start();
    const first = events(
      await (await f.request('/turns', request, f.auth.accessToken)).text(),
    ).at(-1).data;
    const result = {
      version: 1,
      requestId: first.actionId,
      routeEpoch: 0,
      status: scenario.status,
      code: 'DONE',
      message: '',
      observedState: {
        destination: 'earth',
        worldFocus: 'maker',
        earth: { globe: 'ready', restore: 'none', mediaMode: 'conversation' },
      },
    };
    const second = events(
      await (
        await f.request(
          '/turns',
          {
            version: 1,
            kind: 'result',
            requestId: randomUUID(),
            turnId: request.turnId,
            actionId: first.actionId,
            continuationToken: first.continuationToken,
            result,
          },
          f.auth.accessToken,
        )
      ).text(),
    ).at(-1).data;
    assert.equal(second.action.routeEpoch, 0);
    const record = await f.ledger.get(`turn:owner:${request.turnId}`);
    const state = decryptContext(
      record.encrypted,
      ENV.UNITY_CONTEXT_ENCRYPTION_KEY,
      `owner:${request.turnId}`,
    );
    assert.equal(state.request.uiContext.destination, 'unity');
    assert.equal(state.request.uiContext.worldFocus, null);
  }
});
