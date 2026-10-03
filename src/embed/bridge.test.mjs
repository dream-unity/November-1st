import test from 'node:test';
import assert from 'node:assert/strict';
import { installEarthBridge } from './bridge.js';
import { validateMessage } from './protocol.js';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ready = {
  app: 'ready',
  globe: 'ready',
  restore: 'none',
  providers: [{ id: 'radio', status: 'unknown' }],
};
const share = {
  format: 'gev-share-v2',
  hashParams: 'v=2&lat=0&lon=0&alt=1000',
  feed: null,
  hasUnsavedState: true,
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture({
  command = async () => ({
    status: 'applied',
    code: 'ARRIVED',
    message: 'Arrived.',
  }),
  quiet = async () => ({ quiet: true, blockedPlayerCount: 0 }),
  destroy = async () => {},
  readyPort = async () => ready,
} = {}) {
  const sent = [],
    listeners = new Map();
  const parent = {
    postMessage: (message, origin) => sent.push({ message, origin }),
  };
  const windowRef = {
    parent,
    addEventListener: (kind, fn) => listeners.set(kind, fn),
    removeEventListener: (kind) => listeners.delete(kind),
  };
  let count = 0,
    starts = 0,
    destroys = 0,
    media;
  const bridge = installEarthBridge({
    windowRef,
    origins: ['https://dreamunity.one'],
    buildCommit: 'e'.repeat(40),
    randomUUID: () => id(++count + 100),
    commandTimeoutMs: 100,
    mediaTimeoutMs: 100,
    runtimeFactory: async () => {
      starts++;
      return {
        ready: readyPort,
        command,
        snapshot: () => share,
        destroy: async () => {
          destroys++;
          await destroy();
        },
        cancel() {},
      };
    },
    mediaFactory: (options) => {
      media = options;
      return { mediaPreflight: true, quiet, destroy() {} };
    },
  });
  async function send(
    kind,
    payload = {},
    {
      requestId = id(++count),
      epoch = 0,
      origin = 'https://dreamunity.one',
      source = parent,
      bridgeId = id(99),
    } = {},
  ) {
    listeners.get('message')?.({
      origin,
      source,
      data: {
        channel: 'dream-unity:earth',
        version: 1,
        bridgeId,
        epoch,
        requestId,
        kind,
        payload,
      },
    });
    await flush();
    return requestId;
  }
  return {
    send,
    sent,
    bridge,
    parent,
    getMedia: () => media,
    starts: () => starts,
    destroys: () => destroys,
  };
}

test('bridge rejects untrusted origin/source and binds cryptographic challenge before startup', async () => {
  const f = fixture();
  await f.send('INIT', {}, { origin: 'https://untrusted.example' });
  await f.send('INIT', {}, { source: {} });
  await f.send('START', { restore: null });
  assert.equal(f.sent.length, 0);
  assert.equal(f.starts(), 0);
  await f.send('INIT');
  assert.equal(f.sent[0].message.kind, 'HELLO');
  assert.equal(f.sent[0].message.bridgeId, id(99));
  assert.equal(f.sent[0].message.payload.capabilities.suspension, false);
  assert.equal(f.sent[0].message.payload.capabilities.mediaPreflight, true);
  await f.send('START', { restore: null }, { bridgeId: id(98) });
  assert.equal(f.starts(), 0);
  await f.bridge.destroy();
});

test('CANCEL aborts only its named operation, preserves document/epoch, and never reports old success', async () => {
  const operations = [];
  const f = fixture({
    command: (_tool, context) =>
      new Promise((resolve) => {
        operations.push({ context, resolve });
      }),
  });
  await f.send('INIT');
  await f.send('START', { restore: null });
  const first = await f.send('COMMAND', {
    turnId: id(9),
    tool: { name: 'earth_get_view', args: {} },
  });
  await f.send('COMMAND', {
    turnId: id(10),
    tool: { name: 'earth_set_visual_style', args: { style: 'normal' } },
  });
  await f.send('CANCEL', { commandRequestId: first });
  assert.equal(f.sent.at(-1).message.payload.forKind, 'CANCEL');
  assert.equal(operations[0].context.signal.aborted, true);
  assert.equal(operations[1].context.signal.aborted, false);
  assert.equal(f.bridge.getState().epoch, 0);
  assert.equal(f.bridge.getState().active, true);
  assert.equal(f.destroys(), 0);
  operations[0].resolve({
    status: 'applied',
    code: 'OBSERVED',
    message: 'Old',
  });
  await flush();
  assert.equal(f.sent.at(-1).message.payload.status, 'superseded');
  await f.send('CANCEL', { commandRequestId: null });
  assert.equal(operations[1].context.signal.aborted, true);
  operations[1].resolve({ status: 'applied', code: 'APPLIED', message: 'Old' });
  await flush();
  assert.equal(f.sent.at(-1).message.payload.status, 'superseded');
  await f.bridge.destroy();
});

test('exact contract rejects extra fields, invalid UUID, nonfinite coordinates and oversized UTF8', () => {
  const message = {
    channel: 'dream-unity:earth',
    version: 1,
    bridgeId: id(99),
    epoch: 0,
    requestId: id(1),
    kind: 'COMMAND',
    payload: {
      turnId: id(2),
      tool: {
        name: 'earth_fly_to_coordinates',
        args: { latitude: 0, longitude: 0, rangeM: 1000 },
      },
    },
  };
  assert.equal(validateMessage(message), true);
  assert.equal(validateMessage({ ...message, transcript: 'private' }), false);
  assert.equal(
    validateMessage({
      ...message,
      bridgeId: '00000000-0000-1000-8000-000000000001',
    }),
    false,
  );
  assert.equal(
    validateMessage({
      ...message,
      payload: {
        ...message.payload,
        tool: {
          ...message.payload.tool,
          args: { ...message.payload.tool.args, latitude: Infinity },
        },
      },
    }),
    false,
  );
  assert.equal(
    validateMessage({
      ...message,
      payload: {
        ...message.payload,
        tool: {
          name: 'earth_fly_to_location',
          args: { query: 'x'.repeat(40000), viewMode: 'close' },
        },
      },
    }),
    false,
  );
});

test('commands execute once, reused IDs cannot change operation, lifecycle owns epoch and disposal', async () => {
  let executions = 0;
  const f = fixture({
    command: async () => {
      executions++;
      return {
        status: 'applied',
        code: 'ARRIVED',
        message: 'Arrival observed.',
      };
    },
  });
  await f.send('INIT');
  await f.send('START', { restore: null });
  assert.equal(f.starts(), 1);
  assert.equal(f.sent.at(-1).message.kind, 'READY');
  const payload = {
    turnId: id(5),
    tool: { name: 'earth_zoom_to_globe', args: {} },
  };
  const requestId = id(6);
  await f.send('COMMAND', payload, { requestId });
  await f.send('COMMAND', payload, { requestId });
  assert.equal(executions, 1);
  assert.equal(f.sent.at(-1).message.kind, 'RESULT');
  await f.send(
    'COMMAND',
    { ...payload, tool: { name: 'earth_get_view', args: {} } },
    { requestId },
  );
  assert.equal(f.sent.at(-1).message.payload.code, 'REQUEST_ID_REUSED');
  await f.send('COMMAND', payload, { epoch: 2 });
  assert.equal(executions, 1);
  await f.send(
    'SUSPEND',
    { reason: 'route-exit' },
    { epoch: 1, requestId: id(7) },
  );
  await f.send(
    'SUSPEND',
    { reason: 'route-exit' },
    { epoch: 1, requestId: id(7) },
  );
  assert.equal(f.destroys(), 1);
  assert.equal(f.bridge.getState().active, false);
  await f.send('RESUME', { hostVisible: true }, { epoch: 2 });
  assert.equal(f.sent.at(-1).message.payload.code, 'FRESH_DOCUMENT_REQUIRED');
  await f.bridge.destroy();
});

test('media preflight resolves only after matching parent capture/output stopped receipt', async () => {
  const f = fixture();
  await f.send('INIT');
  await f.send('START', { restore: null });
  let resolved = false;
  const request = f
    .getMedia()
    .requestFocus('player-surface')
    .then((value) => {
      resolved = value;
    });
  const emitted = f.sent.at(-1).message;
  assert.equal(emitted.kind, 'MEDIA_FOCUS_REQUEST');
  assert.equal(resolved, false);
  await f.send(
    'MEDIA_FOCUS_GRANTED',
    { captureStopped: true, outputStopped: true },
    { requestId: id(300) },
  );
  assert.equal(resolved, false);
  await f.send(
    'MEDIA_FOCUS_GRANTED',
    { captureStopped: true, outputStopped: true },
    { requestId: emitted.requestId },
  );
  await request;
  assert.equal(resolved, true);
  await f.bridge.destroy();
});

test('late command receipt cannot claim effect after a newer lifecycle epoch', async () => {
  let finish;
  const f = fixture({
    command: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await f.send('INIT');
  await f.send('START', { restore: null });
  const requestId = id(8);
  await f.send(
    'COMMAND',
    { turnId: id(9), tool: { name: 'earth_get_view', args: {} } },
    { requestId },
  );
  await f.send('SUSPEND', { reason: 'exit' }, { epoch: 1 });
  finish({ status: 'applied', code: 'OLD_EFFECT', message: 'Old receipt' });
  await flush();
  assert.equal(
    f.sent.some(
      (item) =>
        item.message.kind === 'RESULT' && item.message.requestId === requestId,
    ),
    false,
  );
  await f.bridge.destroy();
});

test('deadline after dispatch returns unknown with actual readback rather than asserting rollback', async () => {
  const f = fixture({ command: () => new Promise(() => {}) });
  await f.send('INIT');
  await f.send('START', { restore: null });
  const requestId = await f.send('COMMAND', {
    turnId: id(8),
    tool: { name: 'earth_get_view', args: {} },
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const receipt = f.sent.find(
    (item) =>
      item.message.kind === 'RESULT' && item.message.requestId === requestId,
  ).message;
  assert.equal(receipt.payload.status, 'unknown');
  assert.equal(receipt.payload.code, 'ACTION_TIMEOUT_READBACK');
  assert.deepEqual(receipt.payload.snapshot, share);
  await f.bridge.destroy();
});

test('suspend aborts constructed startup before waiting and disposes each runtime once', async () => {
  let settleReady;
  const f = fixture({
    readyPort: () =>
      new Promise((resolve) => {
        settleReady = resolve;
      }),
    destroy: async () => {
      settleReady();
    },
  });
  await f.send('INIT');
  await f.send('START', { restore: null });
  assert.equal(f.bridge.getState().readiness.app, 'starting');
  await f.send('SUSPEND', { reason: 'exit' }, { epoch: 1 });
  assert.equal(f.destroys(), 1);
  assert.equal(f.sent.at(-1).message.payload.forKind, 'SUSPEND');
  assert.equal(
    f.sent.some((item) => item.message.kind === 'READY'),
    false,
  );
  await f.bridge.destroy();
  assert.equal(f.destroys(), 1);
});

test('unconfirmed teardown never emits a successful suspend acknowledgment', async () => {
  const f = fixture({
    quiet: async () => ({ quiet: false, blockedPlayerCount: 1 }),
  });
  await f.send('INIT');
  await f.send('START', { restore: null });
  const requestId = await f.send('SUSPEND', { reason: 'exit' }, { epoch: 1 });
  assert.equal(f.sent.at(-1).message.kind, 'FAILED');
  assert.equal(f.sent.at(-1).message.payload.code, 'TEARDOWN_FAILED');
  assert.equal(
    f.sent.some(
      (item) =>
        item.message.kind === 'ACK' && item.message.requestId === requestId,
    ),
    false,
  );
  await f.bridge.destroy();
});

test('quiet duplicates replay the same receipt and late quiet cannot cross an epoch', async () => {
  let resolveQuiet,
    quietCount = 0;
  const f = fixture({
    quiet: () => {
      quietCount++;
      return quietCount === 1
        ? new Promise((resolve) => {
            resolveQuiet = resolve;
          })
        : Promise.resolve({ quiet: true, blockedPlayerCount: 0 });
    },
  });
  await f.send('INIT');
  await f.send('START', { restore: null });
  const requestId = await f.send('QUIET_REQUEST');
  await f.send('QUIET_REQUEST', {}, { requestId });
  assert.equal(quietCount, 1);
  await f.send('SUSPEND', { reason: 'exit' }, { epoch: 1 });
  resolveQuiet({ quiet: true, blockedPlayerCount: 0 });
  await flush();
  assert.equal(
    f.sent.some(
      (item) =>
        item.message.kind === 'QUIET_ACK' &&
        item.message.requestId === requestId,
    ),
    false,
  );
  const freshId = await f.send('QUIET_REQUEST', {}, { epoch: 1 });
  const first = f.sent.at(-1).message;
  await f.send('QUIET_REQUEST', {}, { epoch: 1, requestId: freshId });
  assert.deepEqual(f.sent.at(-1).message, first);
  await f.bridge.destroy();
});
