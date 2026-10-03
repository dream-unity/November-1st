import { CHANNEL, validateMessage, createRateGate } from './protocol.js';
import { validateSnapshot } from './snapshot.js';

/** The child accepts capabilities only from its real, approved parent window. */
export function installEarthBridge({
  windowRef = window,
  origins = ['https://dreamunity.one'],
  buildCommit,
  runtimeFactory,
  mediaFactory,
  now = () => performance.now(),
  randomUUID = () => crypto.randomUUID(),
  commandTimeoutMs = 4500,
  mediaTimeoutMs = 8000,
}) {
  let bridgeId = null,
    epoch = null,
    origin = null,
    active = false,
    disposed = false;
  let runtime = null,
    starting = null,
    lastSnapshot = null,
    runtimeDisposal = null;
  let readiness = {
    app: 'waiting',
    globe: 'not-started',
    restore: 'none',
    providers: [],
  };
  const receipts = new Map(),
    fingerprints = new Map(),
    inflight = new Map(),
    mediaWaiters = new Map();
  const inboundRate = createRateGate(30, now),
    statusRate = createRateGate(4, now);
  const capabilities = {
    tools: [
      'earth_fly_to_location',
      'earth_fly_to_coordinates',
      'earth_zoom_to_globe',
      'earth_set_layer_visibility',
      'earth_set_visual_style',
      'earth_open_feed',
      'earth_get_view',
    ],
    suspension: false,
    mediaPreflight: true,
  };
  const send = (
    kind,
    payload,
    requestId = randomUUID(),
    targetEpoch = epoch,
  ) => {
    if (
      disposed ||
      !bridgeId ||
      !origin ||
      (kind === 'STATUS' && !statusRate())
    )
      return;
    const message = {
      channel: CHANNEL,
      version: 1,
      bridgeId,
      epoch: targetEpoch,
      requestId,
      kind,
      payload,
    };
    if (!validateMessage(message, 'child')) return;
    windowRef.parent.postMessage(message, origin);
    return message;
  };
  const fail = (request, code, message, retryable = false) =>
    send('FAILED', { code, message, retryable }, request.requestId);
  function retain(key, message) {
    if (!message) return;
    receipts.set(key, message);
    if (receipts.size > 128) {
      const oldest = receipts.keys().next().value;
      receipts.delete(oldest);
      fingerprints.delete(oldest);
    }
  }
  function cancelWork() {
    for (const operation of inflight.values())
      operation.controller?.abort('Host activity changed');
    for (const waiter of mediaWaiters.values()) waiter.finish(false);
    runtime?.cancel?.();
  }
  const media = mediaFactory({
    requestFocus(reason) {
      if (!active || disposed || !bridgeId) return Promise.resolve(false);
      const requestId = randomUUID(),
        targetEpoch = epoch;
      return new Promise((resolve) => {
        let timer;
        const finish = (granted) => {
          clearTimeout(timer);
          mediaWaiters.delete(requestId);
          resolve(granted && active && epoch === targetEpoch && !disposed);
        };
        mediaWaiters.set(requestId, { finish, epoch: targetEpoch });
        timer = setTimeout(() => finish(false), mediaTimeoutMs);
        send('MEDIA_FOCUS_REQUEST', { reason }, requestId);
      });
    },
  });
  capabilities.mediaPreflight = media.mediaPreflight === true;
  const snapshot = () => {
    const current = runtime?.snapshot?.();
    if (current && validateSnapshot(current)) lastSnapshot = current;
    return lastSnapshot;
  };
  const disposeRuntime = () => {
    if (!runtime) return Promise.resolve();
    runtimeDisposal ||= Promise.resolve().then(() => runtime.destroy?.());
    return runtimeDisposal;
  };
  const result = (request, status, code, message) => ({
    status,
    code,
    message,
    snapshot: snapshot(),
  });

  async function receive(event) {
    if (
      disposed ||
      windowRef.parent === windowRef ||
      event.source !== windowRef.parent ||
      !origins.includes(event.origin) ||
      !inboundRate() ||
      !validateMessage(event.data, 'parent')
    )
      return;
    const request = event.data;
    if (request.kind === 'INIT') {
      if (
        bridgeId &&
        (request.bridgeId !== bridgeId ||
          event.origin !== origin ||
          request.epoch !== epoch)
      )
        return;
      if (!bridgeId) {
        bridgeId = request.bridgeId;
        origin = event.origin;
        epoch = request.epoch;
      }
      send('HELLO', { buildCommit, capabilities }, request.requestId);
      return;
    }
    if (!bridgeId || request.bridgeId !== bridgeId || event.origin !== origin)
      return;
    const lifecycle = request.kind === 'SUSPEND' || request.kind === 'RESUME';
    if (request.epoch < epoch || (!lifecycle && request.epoch !== epoch))
      return;
    const key = `${request.epoch}:${request.requestId}`;
    const fingerprint = JSON.stringify({
      kind: request.kind,
      payload: request.payload,
    });
    if (fingerprints.has(key) && fingerprints.get(key) !== fingerprint) {
      fail(
        request,
        'REQUEST_ID_REUSED',
        'A request identity cannot name different Earth operations.',
      );
      return;
    }
    const previous = receipts.get(key);
    if (previous) {
      windowRef.parent.postMessage(previous, origin);
      return;
    }
    if (inflight.has(key)) return;
    fingerprints.set(key, fingerprint);
    if (fingerprints.size > 256)
      fingerprints.delete(fingerprints.keys().next().value);
    if (lifecycle && request.epoch > epoch) {
      epoch = request.epoch;
      cancelWork();
    }
    if (request.kind === 'MEDIA_FOCUS_GRANTED') {
      const waiter = mediaWaiters.get(request.requestId);
      if (waiter?.epoch === epoch) waiter.finish(true);
      send(
        'ACK',
        { forKind: 'MEDIA_FOCUS_GRANTED', active },
        request.requestId,
      );
      return;
    }
    if (request.kind === 'ACK') return;
    if (request.kind === 'CANCEL') {
      const target = request.payload.commandRequestId;
      for (const [operationKey, operation] of inflight) {
        if (
          operation.controller &&
          (target === null || operationKey === `${epoch}:${target}`)
        )
          operation.controller.abort('Host cancelled Earth action');
      }
      if (target === null) runtime?.cancel?.();
      retain(
        key,
        send('ACK', { forKind: 'CANCEL', active }, request.requestId),
      );
      return;
    }
    if (request.kind === 'QUIET_REQUEST') {
      inflight.set(key, {});
      const quietEpoch = epoch;
      try {
        const quiet = await media.quiet();
        if (epoch === quietEpoch)
          retain(key, send('QUIET_ACK', quiet, request.requestId));
      } finally {
        inflight.delete(key);
      }
      return;
    }
    if (request.kind === 'SNAPSHOT_REQUEST') {
      retain(
        key,
        send('SNAPSHOT', { snapshot: snapshot() }, request.requestId),
      );
      return;
    }
    if (request.kind === 'SUSPEND') {
      inflight.set(key, {});
      active = false;
      cancelWork();
      snapshot();
      const suspendEpoch = epoch;
      try {
        await media.quiet();
        // Abort an already-constructed application before waiting for startup.
        // Its native lifetime can then stop pending provider/restoration work.
        await disposeRuntime();
        await starting?.catch(() => {});
        await disposeRuntime();
        const quiet = await media.quiet();
        if (!quiet.quiet) throw new Error('Media teardown unconfirmed');
        if (epoch !== suspendEpoch) return;
        readiness = { ...readiness, app: 'waiting', globe: 'not-started' };
        retain(
          key,
          send('ACK', { forKind: 'SUSPEND', active: false }, request.requestId),
        );
      } catch {
        if (epoch === suspendEpoch)
          retain(
            key,
            fail(
              request,
              'TEARDOWN_FAILED',
              'Earth teardown could not be confirmed. Close this view before resuming voice.',
            ),
          );
      } finally {
        inflight.delete(key);
      }
      return;
    }
    if (request.kind === 'RESUME') {
      // Standalone controls own their document once. Parent must create a fresh frame.
      active = false;
      fail(
        request,
        'FRESH_DOCUMENT_REQUIRED',
        'Reopen Earth to restore its shared view. Unsaved annotations are not part of that snapshot.',
        true,
      );
      return;
    }
    if (request.kind === 'START') {
      if (starting || runtime) return;
      if (!validateSnapshot(request.payload.restore)) {
        fail(
          request,
          'INVALID_RESTORE',
          'The saved Earth view is not supported.',
        );
        return;
      }
      active = true;
      readiness = {
        app: 'starting',
        globe: 'loading',
        restore: request.payload.restore ? 'pending' : 'none',
        providers: [],
      };
      const startEpoch = epoch;
      send('STATUS', readiness);
      starting = (async () => {
        try {
          runtime = await runtimeFactory({
            restore: request.payload.restore,
            onHome: () => {
              if (active) send('REQUEST_HOME', {});
            },
            media,
          });
          if (!active || epoch !== startEpoch) {
            await disposeRuntime();
            return;
          }
          const ready = await runtime.ready();
          if (!active || epoch !== startEpoch) return;
          readiness = ready;
          retain(key, send('READY', readiness, request.requestId));
        } catch (error) {
          readiness = {
            ...readiness,
            app: 'failed',
            globe: 'failed',
            restore: request.payload.restore ? 'failed' : 'none',
          };
          if (epoch === startEpoch && active)
            fail(
              request,
              'EARTH_START_FAILED',
              'The complete Earth application could not start. Use the standalone view or retry.',
              true,
            );
        }
      })();
      await starting;
      return;
    }
    if (request.kind !== 'COMMAND') return;
    if (!active || readiness.app !== 'ready' || !runtime) {
      retain(
        key,
        send(
          'RESULT',
          result(
            request,
            'blocked',
            'EARTH_NOT_READY',
            'Earth is not ready for this action.',
          ),
          request.requestId,
        ),
      );
      return;
    }
    const controller = new AbortController(),
      commandEpoch = epoch;
    const operation = { controller, tool: request.payload.tool.name };
    if (
      [
        'earth_fly_to_location',
        'earth_fly_to_coordinates',
        'earth_zoom_to_globe',
      ].includes(operation.tool)
    ) {
      for (const old of inflight.values())
        if (
          [
            'earth_fly_to_location',
            'earth_fly_to_coordinates',
            'earth_zoom_to_globe',
          ].includes(old.tool)
        )
          old.controller.abort('Newer destination');
    }
    inflight.set(key, operation);
    let timer,
      timedOut = false;
    try {
      const isCurrent = () =>
        active &&
        epoch === commandEpoch &&
        !controller.signal.aborted &&
        !disposed;
      const outcome = await Promise.race([
        runtime.command(request.payload.tool, {
          signal: controller.signal,
          isCurrent,
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort('Action timeout');
            reject(new Error('ACTION_TIMEOUT'));
          }, commandTimeoutMs);
        }),
      ]);
      if (epoch !== commandEpoch) return;
      const status = isCurrent() ? outcome.status : 'superseded';
      retain(
        key,
        send(
          'RESULT',
          result(request, status, outcome.code, outcome.message),
          request.requestId,
        ),
      );
    } catch (error) {
      if (epoch !== commandEpoch) return;
      const cancelled = controller.signal.aborted;
      retain(
        key,
        send(
          'RESULT',
          result(
            request,
            timedOut ? 'unknown' : cancelled ? 'cancelled' : 'failed',
            timedOut
              ? 'ACTION_TIMEOUT_READBACK'
              : cancelled
                ? 'ACTION_CANCELLED'
                : 'ACTION_FAILED',
            timedOut
              ? 'The action deadline passed. Read the current Earth view before retrying; earlier effects may already have applied.'
              : cancelled
                ? 'This Earth action stopped before completion.'
                : 'The requested Earth action could not be completed.',
          ),
          request.requestId,
        ),
      );
    } finally {
      clearTimeout(timer);
      inflight.delete(key);
    }
  }
  const handler = (event) => {
    void receive(event).catch(() => {});
  };
  windowRef.addEventListener('message', handler);
  return {
    getState: () => ({ bridgeId, epoch, active, readiness }),
    async destroy() {
      disposed = true;
      active = false;
      cancelWork();
      windowRef.removeEventListener('message', handler);
      await media.quiet();
      await media.destroy();
      await disposeRuntime();
    },
  };
}
