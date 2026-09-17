import test from 'node:test';
import assert from 'node:assert/strict';
import { Cartographic, Math as CesiumMath } from 'cesium';
import { createGlobeFeedActions } from './globeFeeds.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const events = [];
  const enabled = new Set();
  let state = { status: 'ready' };
  let navigation = 0;
  let cockpit = false;
  let enableGate;
  const radio = {
    selectStation(id, options) {
      events.push(['select-radio', id, options]);
      return id === 'known';
    },
    stopPlayback(options) {
      events.push(['stop-radio', options]);
    },
  };
  const cctv = {
    selectCamera(id, options) {
      events.push(['select-camera', id, options]);
      return id === 'known';
    },
    focusCamera(id, duration) {
      events.push(['focus-camera', id, duration]);
      return 'focused';
    },
  };
  const components = {
    scene: {
      viewer: {
        camera: {
          flyTo(options) {
            events.push(['fly', options]);
          },
        },
      },
    },
    controls: {
      styleManager: {
        beginDeferredLocationNavigation() {
          if (cockpit) return false;
          events.push(['claim-navigation']);
          return ++navigation;
        },
        reassertDeferredLocationNavigation(token) {
          if (cockpit || token !== navigation) return false;
          events.push(['release-tracking']);
          return true;
        },
        setPanelCollapsed(...args) {
          events.push(['panel', ...args]);
        },
      },
    },
    data: {
      catalog: { get: (id) => ({ radio, cctv })[id] },
      dataManager: {
        async setEnabled(id, value, options) {
          events.push(['enable', id, value, options]);
          if (enableGate) await enableGate;
          if (value) enabled.add(id);
        },
        isEnabled: (id) => enabled.has(id),
        setLayerParams(...args) {
          events.push(['params', ...args]);
          return true;
        },
        getLayerLifecycleState: (id) => ({
          enabled: enabled.has(id),
          lifecycleState: enabled.has(id) ? 'enabled' : 'disabled',
          uncertain: false,
        }),
      },
    },
  };
  const application = {
    getState: () => state,
    getComponents: () => components,
  };
  return {
    events,
    components,
    enabled,
    radio,
    cctv,
    actions: createGlobeFeedActions(application),
    setState: (value) => {
      state = { status: value };
    },
    setCockpit: (value) => {
      cockpit = value;
    },
    moveCamera: () => {
      navigation++;
    },
    gateEnable: (promise) => {
      enableGate = promise;
    },
  };
}

const location = { id: 'known', lat: 30.2672, lon: -97.7431 };

test('unavailable globe keeps the directory usable and rejects handoff before side effects', async () => {
  const f = fixture();
  f.setState('failed');
  assert.equal(f.actions.isReady(), false);
  await assert.rejects(f.actions.openOnGlobe('radio', location), {
    code: 'GLOBE_NOT_READY',
  });
  assert.deepEqual(f.events, []);
});

test('invalid coordinates and unsupported feed kinds never release tracking or load layers', async () => {
  const f = fixture();
  for (const item of [
    { lat: null, lon: 0 },
    { lat: '', lon: 0 },
    { lat: true, lon: 0 },
    { lat: 91, lon: 0 },
    { lat: 0, lon: -181 },
    { lat: NaN, lon: 0 },
  ]) {
    await assert.rejects(f.actions.openOnGlobe('traffic', item), {
      code: 'INVALID_FEED_LOCATION',
    });
  }
  await assert.rejects(f.actions.openOnGlobe('unknown', location), {
    code: 'INVALID_FEED_KIND',
  });
  assert.deepEqual(f.events, []);
});

test('cockpit refuses a handoff before changing layers or camera ownership', async () => {
  const f = fixture();
  f.setCockpit(true);
  await assert.rejects(f.actions.openOnGlobe('cctv', location), {
    code: 'GLOBE_NAVIGATION_REFUSED',
  });
  assert.deepEqual(f.events, []);
});

test('radio selects the exact station after ownership handoff without autoplay', async () => {
  const f = fixture();
  const result = await f.actions.openOnGlobe('radio', location);
  assert.deepEqual(result, { opened: true, selected: true, message: null });
  const selectIndex = f.events.findIndex(([event]) => event === 'select-radio');
  assert.ok(
    f.events.findIndex(([event]) => event === 'release-tracking') < selectIndex,
  );
  assert.deepEqual(f.events[selectIndex], [
    'select-radio',
    'known',
    { autoplay: false, focus: true, origin: 'user' },
  ]);
  assert.ok(
    f.events.some(
      ([event, panel, collapsed]) =>
        event === 'panel' && panel === 'radio-panel' && collapsed === false,
    ),
  );
  assert.ok(!f.events.some(([event]) => event === 'fly'));
});

test('station missing from globe catalogue receives honest coordinate fallback without a substitute station', async () => {
  const f = fixture();
  const result = await f.actions.openOnGlobe('radio', {
    ...location,
    id: 'outside-catalogue',
  });
  assert.equal(result.selected, false);
  assert.match(result.message, /outside the globe tuner catalogue/);
  assert.equal(
    f.events.filter(([event]) => event === 'select-radio').length,
    1,
  );
  const destination = f.events.find(([event]) => event === 'fly')[1]
    .destination;
  const position = Cartographic.fromCartesian(destination);
  assert.ok(
    Math.abs(CesiumMath.toDegrees(position.latitude) - location.lat) < 1e-6,
  );
  assert.ok(
    Math.abs(CesiumMath.toDegrees(position.longitude) - location.lon) < 1e-6,
  );
});

test('CCTV selects, persists and focuses the requested camera through shared ownership', async () => {
  const f = fixture();
  const result = await f.actions.openOnGlobe('cctv', location);
  assert.equal(result.selected, true);
  const release = f.events.findIndex(([event]) => event === 'release-tracking');
  const focus = f.events.findIndex(([event]) => event === 'focus-camera');
  assert.ok(release >= 0 && release < focus);
  assert.ok(
    f.events.some(
      ([event, kind, params]) =>
        event === 'params' &&
        kind === 'cctv' &&
        params.selectedCameraId === 'known',
    ),
  );
  assert.ok(
    f.events.some(
      ([event, panel, collapsed]) =>
        event === 'panel' && panel === 'cctv-panel' && collapsed === false,
    ),
  );
});

test('real traffic report location does not enable simulated traffic or unrelated layers', async () => {
  const f = fixture();
  const result = await f.actions.openOnGlobe('traffic', location);
  assert.equal(result.opened, true);
  assert.ok(f.events.some(([event]) => event === 'fly'));
  assert.ok(
    !f.events.some(([event]) =>
      ['enable', 'params', 'select-radio', 'select-camera'].includes(event),
    ),
  );
});

test('official incident position and latitude/longitude aliases use the same strict coordinates', async () => {
  for (const item of [
    { id: 'incident', position: { latitude: 60.2, longitude: 24.9 } },
    { id: 'incident', latitude: 60.2, longitude: 24.9 },
  ]) {
    const f = fixture();
    await f.actions.openOnGlobe('traffic', item);
    const position = Cartographic.fromCartesian(
      f.events.find(([event]) => event === 'fly')[1].destination,
    );
    assert.ok(Math.abs(CesiumMath.toDegrees(position.latitude) - 60.2) < 1e-6);
    assert.ok(Math.abs(CesiumMath.toDegrees(position.longitude) - 24.9) < 1e-6);
  }
  const f = fixture();
  await assert.rejects(
    f.actions.openOnGlobe('traffic', {
      position: { latitude: null, longitude: 24.9 },
    }),
    { code: 'INVALID_FEED_LOCATION' },
  );
});

test('a directory row cannot change the requested target while its catalogue loads', async () => {
  const f = fixture();
  const gate = deferred();
  f.gateEnable(gate.promise);
  const item = { ...location, id: 'outside-catalogue' };
  const pending = f.actions.openOnGlobe('radio', item);
  item.id = 'known';
  item.lat = 70;
  gate.resolve();
  const result = await pending;
  assert.equal(result.selected, false);
  const position = Cartographic.fromCartesian(
    f.events.find(([event]) => event === 'fly')[1].destination,
  );
  assert.ok(
    Math.abs(CesiumMath.toDegrees(position.latitude) - location.lat) < 1e-6,
  );
});

test('an external camera action during loading wins over the delayed feed handoff', async () => {
  const f = fixture();
  const gate = deferred();
  f.gateEnable(gate.promise);
  const pending = f.actions.openOnGlobe('radio', location);
  f.moveCamera();
  gate.resolve();
  await assert.rejects(pending, { code: 'GLOBE_NAVIGATION_REFUSED' });
  assert.ok(
    !f.events.some(([event]) =>
      ['release-tracking', 'select-radio', 'fly'].includes(event),
    ),
  );
});

test('a newer directory handoff supersedes old asynchronous catalogue loading', async () => {
  const f = fixture();
  const gate = deferred();
  f.gateEnable(gate.promise);
  const pending = f.actions.openOnGlobe('radio', location);
  await f.actions.openOnGlobe('traffic', { ...location, lat: 52 });
  gate.resolve();
  await assert.rejects(pending, { code: 'FEED_HANDOFF_SUPERSEDED' });
  assert.equal(f.events.filter(([event]) => event === 'fly').length, 1);
  assert.ok(!f.events.some(([event]) => event === 'select-radio'));
});

test('application teardown while a catalogue loads prevents post-destroy selection', async () => {
  const f = fixture();
  const gate = deferred();
  f.gateEnable(gate.promise);
  const pending = f.actions.openOnGlobe('cctv', location);
  f.setState('destroying');
  gate.resolve();
  await assert.rejects(pending, { code: 'GLOBE_NOT_READY' });
  assert.ok(
    !f.events.some(([event]) =>
      ['release-tracking', 'select-camera', 'focus-camera'].includes(event),
    ),
  );
});

test('closing the feed directory during loading cannot release tracking or steal the camera', async () => {
  const f = fixture();
  const gate = deferred();
  const controller = new AbortController();
  f.gateEnable(gate.promise);
  const pending = f.actions.openOnGlobe('cctv', location, {
    signal: controller.signal,
  });
  controller.abort();
  gate.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.ok(
    !f.events.some(([event]) =>
      ['release-tracking', 'select-camera', 'focus-camera', 'fly'].includes(
        event,
      ),
    ),
  );
});

test('an already closed feed directory cannot claim navigation or activate a layer', async () => {
  const f = fixture();
  await assert.rejects(
    f.actions.openOnGlobe('radio', location, { signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  assert.deepEqual(f.events, []);
});

test('directory playback stops globe radio synchronously and never requires a ready globe', () => {
  const f = fixture();
  f.actions.beforeRadioPlay();
  assert.deepEqual(f.events, [['stop-radio', { origin: 'user' }]]);
  assert.doesNotThrow(() => createGlobeFeedActions(null).beforeRadioPlay());
});
