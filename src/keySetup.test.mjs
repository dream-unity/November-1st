import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectKeyUpdates,
  keySetupChipLabel,
  stripKeylessBasemapFromHash,
} from './keySetup.js';

test('the chip counts what is missing, and retires the count at zero', () => {
  assert.equal(
    keySetupChipLabel({ setCount: 0, total: 8 }),
    'POWER UP · 8 KEYS WAITING',
  );
  assert.equal(
    keySetupChipLabel({ setCount: 7, total: 8 }),
    'POWER UP · 1 KEY WAITING',
  );
  assert.equal(keySetupChipLabel({ setCount: 8, total: 8 }), 'POWERED UP');
  assert.equal(
    keySetupChipLabel(null),
    'POWERED UP',
    'no status is not a broken label',
  );
});

test('collectKeyUpdates keeps only non-empty trimmed values', () => {
  const updates = collectKeyUpdates([
    { envVar: 'OPENAI_API_KEY', value: '  sk-abc  ' },
    { envVar: 'FIRMS_MAP_KEY', value: '' },
    { envVar: 'TOMTOM_API_KEY', value: '   ' },
    { envVar: '', value: 'orphan' },
    null,
  ]);
  assert.deepEqual(updates, { OPENAI_API_KEY: 'sk-abc' });
  assert.deepEqual(collectKeyUpdates([]), {});
  assert.deepEqual(collectKeyUpdates(null), {});
});

test('the first Google key strips ONLY the keyless OSM basemap from the share hash', () => {
  const stripped = stripKeylessBasemapFromHash(
    'lat=30.2&lon=-97.7&map=osm&style=normal',
  );
  assert.ok(stripped !== null);
  const params = new URLSearchParams(stripped);
  assert.equal(params.get('map'), null, 'osm basemap removed');
  assert.equal(params.get('lat'), '30.2', 'camera survives');
  assert.equal(params.get('style'), 'normal', 'style survives');
  // A stack under any other name was chosen or shared on purpose.
  assert.equal(stripKeylessBasemapFromHash('map=bing-aerial&lat=1'), null);
  assert.equal(
    stripKeylessBasemapFromHash('lat=1&lon=2'),
    null,
    'no stack, nothing to do',
  );
  assert.equal(stripKeylessBasemapFromHash(''), null);
  assert.equal(stripKeylessBasemapFromHash(undefined), null);
});

test('aborting pending setup removes its surface and ignores a late response', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const removed = [];
  const chip = { remove: () => removed.push('chip') };
  const root = { dataset: {}, remove: () => removed.push('root') };
  let resolveResponse;
  let requestSignal;
  const controller = new AbortController();
  const pending = initKeySetup({
    documentRef: {
      getElementById: (id) => (id === 'key-setup-chip' ? chip : root),
    },
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    },
  });
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  assert.deepEqual(removed, ['chip', 'root']);
  resolveResponse({ ok: true, json: async () => ({ keys: [] }) });
  assert.equal(await pending, null);
});

function setupFixture() {
  const removed = [];
  const handlers = new Map();
  const applyChanges = [];
  const apply = {
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener() {},
    setAttribute: (...args) => applyChanges.push(args),
  };
  const statusLine = { textContent: '' };
  const input = { dataset: { envVar: 'OPENAI_API_KEY' }, value: 'test-value' };
  const chip = {
    remove: () => removed.push('chip'),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  const root = {
    dataset: {},
    remove: () => removed.push('root'),
    querySelector: (selector) =>
      ({
        '[data-key-setup-apply]': apply,
        '[data-key-setup-status]': statusLine,
      })[selector] || null,
    querySelectorAll: () => [input],
  };
  const documentRef = {
    getElementById: (id) => (id === 'key-setup-chip' ? chip : root),
  };
  return { documentRef, removed, handlers, applyChanges, statusLine };
}

test('hosted builds remove the credential editor without probing a forbidden endpoint', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const f = setupFixture();
  let requests = 0;
  assert.equal(
    await initKeySetup({
      ...f,
      enabled: false,
      fetchImpl: () => {
        requests++;
      },
    }),
    null,
  );
  assert.equal(requests, 0);
  assert.deepEqual(f.removed, ['chip', 'root']);
});

test('malformed credential status cannot create broken editable rows', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const { keySetupStatus } = await import('./keySetupCore.mjs');
  const unsafeLink = keySetupStatus();
  unsafeLink.keys[0].getUrl = 'javascript:alert(1)';
  for (const payload of [
    null,
    { keys: null },
    { keys: [{}], total: 1, setCount: 0 },
    unsafeLink,
  ]) {
    const f = setupFixture();
    assert.equal(
      await initKeySetup({
        ...f,
        fetchImpl: async () => Response.json(payload),
      }),
      null,
    );
    assert.deepEqual(f.removed, ['chip', 'root']);
  }
});

test('local credential status remains available and disposal suppresses a late save failure', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const { keySetupStatus } = await import('./keySetupCore.mjs');
  const f = setupFixture();
  let rejectSave;
  const ui = await initKeySetup({
    ...f,
    fetchImpl: async (url) =>
      url.endsWith('/status')
        ? Response.json(keySetupStatus())
        : new Promise((_resolve, reject) => {
            rejectSave = reject;
          }),
  });
  assert.ok(ui);
  const pending = f.handlers.get('click')();
  assert.equal(f.statusLine.textContent, 'Saving…');
  ui.destroy();
  rejectSave(new Error('Late request rejection'));
  await pending;
  assert.equal(f.statusLine.textContent, 'Saving…');
  assert.deepEqual(f.applyChanges, [['aria-disabled', 'true']]);
});

test('a hung local status request is aborted and its dormant editor is removed', async () => {
  const { initKeySetup } = await import('./keySetup.js');
  const f = setupFixture();
  let requestSignal;
  // Keep the test alive while AbortSignal.timeout uses an unreferenced timer.
  const keepAlive = setTimeout(() => {}, 100);
  try {
    const ui = await initKeySetup({
      ...f,
      requestTimeoutMs: 1,
      fetchImpl: (_url, { signal }) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    });
    assert.equal(ui, null);
    assert.equal(requestSignal.reason.name, 'TimeoutError');
    assert.deepEqual(f.removed, ['chip', 'root']);
  } finally {
    clearTimeout(keepAlive);
  }
});
