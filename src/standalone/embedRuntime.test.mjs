import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { validateSnapshot } from '../embed/snapshot.js';

// Execute the real owned adapter, replacing application construction only.
const source = (
  await readFile(new URL('./embedRuntime.js', import.meta.url), 'utf8')
)
  .replace(/^import .*;\n/gm, '')
  .replace('export async function ', 'async function ');
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function fixture({
  run = async () => ({ ok: true, arrived: true }),
  restoration = { status: 'not-requested' },
  restore = null,
} = {}) {
  let listener,
    cancels = 0,
    runnerPorts,
    startOptions,
    providerSignal,
    destroys = 0;
  const shell = { hidden: true, inert: true },
    waiting = { hidden: false },
    opened = [];
  const events = new Map(),
    polling = [];
  const documentRef = {
    hidden: false,
    getElementById: (id) => (id === 'du-application' ? shell : waiting),
    addEventListener: (kind, callback) => events.set(kind, callback),
    removeEventListener: (kind) => events.delete(kind),
  };
  const share = {
    format: 'gev-share-v2',
    hashParams: 'v=2&lat=0&lon=0',
    feed: null,
    hasUnsavedState: true,
  };
  const styleManager = {
    shareLinkManager: {
      exportSnapshot: (options) => ({ ...share, ...options }),
    },
    subscribeCameraHandoff: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  const components = {
    scene: {
      viewer: {
        camera: {
          cancelFlight: () => {
            cancels++;
          },
        },
      },
      operations: {
        surface: { groundFloor: {} },
        annotationResolver: {},
        searchAndFlyTo() {},
      },
    },
    controls: { styleManager },
    data: {
      dataManager: {
        getLayerLifecycleState: () => ({ enabled: true, uncertain: false }),
        setPollingSuspended: (value) => polling.push(value),
      },
    },
    tools: { sceneDirector: {}, annotations: {} },
  };
  const placeSearch = {};
  const context = vm.createContext({
    AbortController,
    AbortSignal,
    URL,
    history: { replaceState() {} },
    window: { location: { href: 'https://earth.example/embed/' } },
    document: documentRef,
    validateSnapshot,
    startGodsEye: (options) => {
      startOptions = options;
    },
    getStandalonePorts: () => ({
      ready: async () => ({ components, restoration }),
      getPlaceSearch: () => placeSearch,
      openFeed: async (kind) => {
        opened.push(kind);
      },
      destroy: async () => {
        destroys++;
      },
    }),
    readDeploymentStatus: async ({ signal }) => {
      providerSignal = signal;
      return {
        providers: [
          { id: 'radio', status: 'configured' },
          { id: 'cctv', status: 'protected' },
        ],
      };
    },
    createGevActionRunner: (ports) => {
      runnerPorts = ports;
      return run;
    },
  });
  vm.runInContext(source, context);
  const onHome = () => {};
  const runtime = await context.createEmbeddedRuntime({ restore, onHome });
  const ready = await runtime.ready();
  return {
    runtime,
    ready,
    components,
    placeSearch,
    shell,
    waiting,
    opened,
    onHome,
    polling,
    hide: (hidden) => {
      documentRef.hidden = hidden;
      events.get('visibilitychange')?.();
    },
    get runnerPorts() {
      return runnerPorts;
    },
    get startOptions() {
      return startOptions;
    },
    get providerSignal() {
      return providerSignal;
    },
    get destroys() {
      return destroys;
    },
    get cancels() {
      return cancels;
    },
    handoff: () => listener?.({ generation: 2 }),
  };
}
const options = () => ({
  signal: new AbortController().signal,
  isCurrent: () => true,
});

test('real document visibility pauses owned polling without destroying or losing snapshot state', async () => {
  const f = await fixture();
  assert.deepEqual(f.polling, [false]);
  const snapshot = f.runtime.snapshot();
  f.hide(true);
  assert.deepEqual(f.polling, [false, true]);
  assert.equal(f.destroys, 0);
  assert.deepEqual(f.runtime.snapshot(), snapshot);
  f.hide(false);
  assert.deepEqual(f.polling, [false, true, false]);
  await f.runtime.destroy();
  f.hide(true);
  assert.deepEqual(f.polling, [false, true, false]);
});

test('embedded adapter binds actual application services and reports readiness without asserting live feeds', async () => {
  const f = await fixture();
  assert.equal(f.shell.hidden, false);
  assert.equal(f.shell.inert, false);
  assert.equal(f.waiting.hidden, true);
  assert.equal(f.startOptions.onHome, f.onHome);
  assert.equal(f.runnerPorts.viewer, f.components.scene.viewer);
  assert.equal(f.runnerPorts.placeSearch, f.placeSearch);
  assert.equal(
    f.runnerPorts.searchNavigation,
    f.components.scene.operations.searchAndFlyTo,
  );
  assert.equal(f.ready.app, 'ready');
  assert.equal(f.ready.globe, 'ready');
  assert.equal(f.ready.restore, 'none');
  assert.equal(f.ready.providers[0].status, 'unknown');
  assert.equal(f.ready.providers[1].status, 'protected');
  const outcome = await f.runtime.command(
    { name: 'earth_open_feed', args: { kind: 'radio' } },
    options(),
  );
  assert.equal(outcome.status, 'applied');
  assert.match(
    outcome.message,
    /No stream playback or availability is implied/,
  );
  assert.deepEqual(f.opened, ['radio']);
  assert.equal(f.runtime.snapshot().feed, 'radio');
  assert.equal(f.runtime.snapshot().hasUnsavedState, true);
  await f.runtime.destroy();
  await f.runtime.destroy();
  assert.equal(f.destroys, 1);
  assert.equal(f.providerSignal.aborted, true);
});

test('user camera ownership supersedes delayed actions without cancelling the user flight', async () => {
  let settle, seen;
  const f = await fixture({
    run: (name, args, context) => {
      seen = { name, args, context };
      return new Promise((resolve) => {
        settle = resolve;
      });
    },
  });
  const pending = f.runtime.command(
    {
      name: 'earth_fly_to_location',
      args: { query: 'A place', viewMode: 'overview' },
    },
    options(),
  );
  await flush();
  assert.equal(seen.args.waitForArrival, true);
  f.handoff();
  assert.equal(seen.context.signal.aborted, true);
  assert.equal(f.cancels, 0);
  settle({ ok: true, arrived: true });
  const outcome = await pending;
  assert.equal(outcome.status, 'superseded');
  assert.equal(outcome.code, 'USER_NAVIGATION_WON');
  await f.runtime.destroy();
});

test('an owned flight is cancelled on host abort and never claims arrival from a start receipt', async () => {
  const f = await fixture({ run: async () => ({ ok: true, arrived: false }) });
  const outcome = await f.runtime.command(
    {
      name: 'earth_fly_to_coordinates',
      args: { latitude: 0, longitude: 0, rangeM: 1000 },
    },
    options(),
  );
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.code, 'ARRIVAL_UNCONFIRMED');
  await f.runtime.destroy();
  let settle;
  const g = await fixture({
    run: () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  });
  const controller = new AbortController();
  const pending = g.runtime.command(
    { name: 'earth_zoom_to_globe', args: {} },
    { signal: controller.signal, isCurrent: () => !controller.signal.aborted },
  );
  controller.abort('Host exit');
  assert.equal(g.cancels, 1);
  settle({ ok: true });
  assert.equal((await pending).status, 'superseded');
  await g.runtime.destroy();
});
