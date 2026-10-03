import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('./embed.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '')
  .replaceAll('import.meta.env', 'env')
  .replace("import('./embedRuntime.js')", 'importRuntime()');
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture({ fetch, loadCesium = async () => {}, importRuntime } = {}) {
  const win = new EventTarget();
  win.parent = {};
  let installed,
    starts = 0,
    destroys = 0;
  const context = vm.createContext({
    window: win,
    document: { getElementById: () => ({}) },
    env: { PROD: true, BASE_URL: '/', DU_BUILD_COMMIT: 'a'.repeat(40) },
    AbortController,
    AbortSignal,
    fetch:
      fetch ||
      (async () => ({
        ok: true,
        json: async () => ({ commit: 'a'.repeat(40) }),
      })),
    createCesiumLoader: () => loadCesium,
    installEmbedMediaFocus() {},
    installEarthBridge: (options) => {
      installed = options;
      return {
        destroy: async () => {
          destroys++;
        },
      };
    },
    importRuntime:
      importRuntime ||
      (async () => ({
        createEmbeddedRuntime: async () => {
          starts++;
        },
      })),
  });
  vm.runInContext(source, context);
  return {
    win,
    get installed() {
      return installed;
    },
    get starts() {
      return starts;
    },
    get destroys() {
      return destroys;
    },
  };
}

test('pagehide during build identity lookup cannot install an unowned bridge afterward', async () => {
  const lookup = deferred();
  let lookupSignal;
  const f = fixture({
    fetch: (_url, { signal }) => {
      lookupSignal = signal;
      return lookup.promise;
    },
  });
  f.win.dispatchEvent(new Event('pagehide'));
  assert.equal(lookupSignal.aborted, true);
  lookup.resolve({ ok: true, json: async () => ({ commit: 'a'.repeat(40) }) });
  await flush();
  assert.equal(f.installed, undefined);
  assert.equal(f.starts, 0);
});

test('suspension during globe loading prevents late application construction', async () => {
  const engine = deferred();
  const f = fixture({ loadCesium: () => engine.promise });
  await flush();
  const lifetime = new AbortController();
  const pending = f.installed.runtimeFactory({ signal: lifetime.signal });
  lifetime.abort();
  engine.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.starts, 0);
});

test('suspension during module loading cannot construct the application afterward', async () => {
  const module = deferred();
  let starts = 0;
  const f = fixture({ importRuntime: () => module.promise });
  await flush();
  const lifetime = new AbortController();
  const pending = f.installed.runtimeFactory({ signal: lifetime.signal });
  await flush();
  lifetime.abort();
  module.resolve({
    createEmbeddedRuntime: () => {
      starts++;
    },
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(starts, 0);
  f.win.dispatchEvent(new Event('pagehide'));
  assert.equal(f.destroys, 1);
});
