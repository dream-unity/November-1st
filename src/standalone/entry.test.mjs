import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real entry body with inert dependencies. This leaves its startup
// ordering and exception handling intact without constructing Cesium in Node.
const source = (await readFile(new URL('./entry.js', import.meta.url), 'utf8'))
  .replace(/^import [\s\S]*?;\n/gm, '')
  .replaceAll('import.meta.env', '__environment')
  .replace('export function startGodsEye', 'function startGodsEye');

function fixture({
  search = '',
  failAt = '',
  startResult = Promise.resolve(),
} = {}) {
  const calls = [];
  const reports = [];
  const logged = [];
  const error = new Error(`Failure at ${failAt || 'async startup'}`);
  error.errors = [new Error('Underlying provider error')];
  let chromeOptions;
  let applicationOptions;
  const touch = (name) => {
    calls.push(name);
    if (failAt === name) throw error;
  };
  const application = {
    start() {
      touch('start');
      return startResult;
    },
  };
  const feedCalls = [];
  const globeActions = { openOnGlobe() {}, beforeRadioPlay() {} };
  const context = vm.createContext({
    URLSearchParams,
    window: { location: { search } },
    __environment: {
      GOOGLE_MAPS_API_KEY: 'test-map-key',
      CESIUM_ION_TOKEN: 'test-cesium-token',
      DEV: false,
    },
    console: { error: (...args) => logged.push(args) },
    createStandaloneApplication(options) {
      touch('construct');
      applicationOptions = options;
      return application;
    },
    createGlobeFeedActions(received) {
      assert.equal(received, application);
      touch('globe-actions');
      return globeActions;
    },
    installLiveFeeds(options) {
      touch('live-feeds');
      assert.equal(options.openOnGlobe, globeActions.openOnGlobe);
      assert.equal(options.beforeRadioPlay, globeActions.beforeRadioPlay);
      return {
        open(...args) {
          touch('open-feed');
          feedCalls.push(args);
        },
      };
    },
    installDreamUnityChrome(options) {
      touch('chrome');
      chromeOptions = options;
    },
    describeError(received) {
      assert.equal(received, error);
      return `Reported: ${received.message}`;
    },
    showStartupFailure(report) {
      reports.push(report);
    },
  });
  vm.runInContext(source, context);
  return {
    start: () => context.startGodsEye(),
    calls,
    reports,
    logged,
    error,
    application,
    feedCalls,
    get chromeOptions() {
      return chromeOptions;
    },
    get applicationOptions() {
      return applicationOptions;
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function assertRecovery(page) {
  assert.equal(page.reports.length, 1, 'startup recovery must be shown once');
  assert.equal(page.reports[0].message, `Reported: ${page.error.message}`);
  assert.equal(page.reports[0].errors, page.error.errors);
  assert.equal(page.logged.length, 1);
}

test('the standalone entry remains dormant until started and returns one application instance', async () => {
  const page = fixture();
  assert.deepEqual(page.calls, []);
  assert.equal(page.start(), page.application);
  assert.equal(page.start(), page.application);
  await settle();
  assert.equal(page.start(), page.application);
  assert.deepEqual(page.calls, [
    'construct',
    'globe-actions',
    'live-feeds',
    'chrome',
    'start',
  ]);
  assert.equal(page.applicationOptions.googleApiKey, 'test-map-key');
  assert.equal(page.applicationOptions.cesiumToken, 'test-cesium-token');
  assert.equal(page.applicationOptions.allowQaRegistration, false);
  assert.deepEqual(page.reports, []);
});

for (const failAt of [
  'construct',
  'globe-actions',
  'live-feeds',
  'chrome',
  'open-feed',
  'start',
]) {
  test(`synchronous ${failAt} failure reports recovery and never repeats partial construction`, async () => {
    const page = fixture({ failAt, search: '?feed=cctv' });
    const result = page.start();
    assert.equal(result, failAt === 'construct' ? undefined : page.application);
    assertRecovery(page);
    const callsAfterFailure = [...page.calls];
    assert.equal(page.start(), result);
    await settle();
    assert.equal(page.start(), result);
    assert.deepEqual(page.calls, callsAfterFailure);
    assert.equal(page.calls.filter((name) => name === 'construct').length, 1);
    assertRecovery(page);
  });
}

test('a rejected asynchronous application start reports recovery without constructing again', async () => {
  let rejectStart;
  const startResult = new Promise((resolve, reject) => {
    rejectStart = reject;
  });
  const page = fixture({ startResult });
  assert.equal(page.start(), page.application);
  assert.equal(page.start(), page.application);
  assert.deepEqual(page.reports, []);
  rejectStart(page.error);
  await settle();
  assertRecovery(page);
  const callsAfterFailure = [...page.calls];
  assert.equal(page.start(), page.application);
  assert.deepEqual(page.calls, callsAfterFailure);
  assert.equal(page.calls.filter((name) => name === 'start').length, 1);
  assertRecovery(page);
});

test('permitted shared feed state opens once at startup and chrome actions remain usable', () => {
  for (const feed of ['radio', 'cctv', 'traffic']) {
    const page = fixture({ search: `?feed=${feed}&country=AU&city=melbourne` });
    assert.deepEqual(page.feedCalls, []);
    page.start();
    page.start();
    assert.deepEqual(page.feedCalls, [[feed]]);
    const opener = {};
    page.chromeOptions.onOpenFeed('radio', opener);
    assert.deepEqual(page.feedCalls, [[feed], ['radio', opener]]);
  }
  for (const search of [
    '',
    '?feed=unknown',
    '?feed=https%3A%2F%2Fother.example',
  ]) {
    const page = fixture({ search });
    page.start();
    assert.deepEqual(page.feedCalls, []);
    assert.equal(page.calls.filter((name) => name === 'start').length, 1);
  }
});
