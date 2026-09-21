import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCesiumLoader } from './loadCesium.js';

function fixture({ globalRef = {}, appendError } = {}) {
  const scripts = [];
  const timers = new Set();
  const documentRef = {
    createElement(tag) {
      assert.equal(tag, 'script');
      return {
        remove() {
          this.removed = true;
        },
      };
    },
    head: {
      appendChild(script) {
        if (appendError) throw appendError;
        scripts.push(script);
      },
    },
  };
  const load = createCesiumLoader({
    documentRef,
    globalRef,
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 45_000);
      timers.add(callback);
      return callback;
    },
    clearTimeoutImpl(callback) {
      timers.delete(callback);
    },
  });
  return { load, scripts, timers, globalRef };
}

test('constructing the loader does no work; concurrent starts share one engine request', async () => {
  const page = fixture();
  assert.equal(page.scripts.length, 0);
  assert.equal(page.timers.size, 0);
  const first = page.load();
  assert.equal(page.load(), first);
  assert.equal(page.scripts.length, 1);
  assert.equal(page.scripts[0].src, '/cesium/Cesium.js');
  assert.equal(page.scripts[0].async, true);
  page.globalRef.Cesium = { Viewer() {} };
  page.scripts[0].onload();
  await first;
  await page.load();
  assert.equal(page.scripts.length, 1);
  assert.equal(page.timers.size, 0);
  assert.equal(page.scripts[0].onerror, null);
  assert.equal(page.scripts[0].onload, null);
});

test('an already loaded engine needs no script or timer', async () => {
  const page = fixture({ globalRef: { Cesium: { Viewer() {} } } });
  await page.load();
  assert.equal(page.scripts.length, 0);
  assert.equal(page.timers.size, 0);
});

for (const failure of ['network', 'timeout', 'missing global']) {
  test(`${failure} cleans up and allows a fresh engine request`, async () => {
    const page = fixture();
    const first = page.load();
    const failed = assert.rejects(first, /globe engine/);
    const oldScript = page.scripts[0];
    if (failure === 'network') oldScript.onerror();
    else if (failure === 'timeout') [...page.timers][0]();
    else oldScript.onload();
    await failed;
    assert.equal(oldScript.removed, true);
    assert.equal(oldScript.onload, null);
    assert.equal(oldScript.onerror, null);
    assert.equal(page.timers.size, 0);
    const retry = page.load();
    assert.notEqual(retry, first);
    assert.equal(page.scripts.length, 2);
    page.globalRef.Cesium = { Viewer() {} };
    page.scripts[1].onload();
    await retry;
    assert.equal(page.timers.size, 0);
  });
}

test('a blocked script insertion rejects without leaving a pending timer', async () => {
  const page = fixture({ appendError: new Error('Insertion blocked') });
  await assert.rejects(page.load(), /Insertion blocked/);
  assert.equal(page.timers.size, 0);
});

const entrySource = (
  await readFile(new URL('../main.js', import.meta.url), 'utf8')
)
  .replace(/^import .*;\n/gm, '')
  .replace('export let application;', 'let application;')
  .replaceAll('import.meta.env', 'environment')
  .replace("import('./standalone/entry.js')", 'loadRuntime()');

function entryFixture({ production, engine }) {
  const calls = [];
  let options;
  const context = vm.createContext({
    environment: { PROD: production, BASE_URL: '/preview/' },
    createCesiumLoader({ source }) {
      assert.equal(source, '/preview/cesium/Cesium.js');
      return () => {
        calls.push('engine');
        return engine;
      };
    },
    installWelcome(received) {
      options = received;
    },
    async loadRuntime() {
      calls.push('runtime');
      return { startGodsEye: () => calls.push('start') };
    },
  });
  vm.runInContext(entrySource, context);
  return { calls, options };
}

test('production waits for the engine before evaluating the application module', async () => {
  let resolveEngine;
  const page = entryFixture({
    production: true,
    engine: new Promise((resolve) => {
      resolveEngine = resolve;
    }),
  });
  assert.deepEqual(page.calls, []);
  const load = page.options.loadApplication();
  assert.deepEqual(page.calls, ['engine']);
  resolveEngine();
  const runtime = await load;
  assert.deepEqual(page.calls, ['engine', 'runtime']);
  runtime.startGodsEye();
  assert.deepEqual(page.calls, ['engine', 'runtime', 'start']);
});

test('engine failure never evaluates the runtime, while development uses module loading', async () => {
  const failed = entryFixture({
    production: true,
    engine: Promise.reject(new Error('Engine failed')),
  });
  await assert.rejects(failed.options.loadApplication(), /Engine failed/);
  assert.deepEqual(failed.calls, ['engine']);
  const development = entryFixture({ production: false });
  const runtime = await development.options.loadApplication();
  assert.deepEqual(development.calls, ['runtime']);
  runtime.startGodsEye();
  assert.deepEqual(development.calls, ['runtime', 'start']);
});
