import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvVideoPlayback } from './videoPlayback.js';
import { createProjection } from './projection.js';
import * as Cesium from 'cesium';

class Video extends EventTarget {
  paused = true;
  playCount = 0;
  loadCount = 0;
  source = null;
  canPlayType() { return ''; }
  set src(value) { this.source = value; }
  getAttribute(name) { return name === 'src' ? this.source : null; }
  removeAttribute(name) { if (name === 'src') this.source = null; }
  load() { this.loadCount++; }
  pause() { this.paused = true; }
  play() { this.playCount++; this.paused = false; return Promise.resolve(); }
  emit(name) { this.dispatchEvent(new Event(name)); }
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const video = options.video || new Video();
  const statuses = [];
  const playback = createCctvVideoPlayback({ video, url: '/camera', feedType: 'mp4',
    timeoutMs: 100, onStatus: value => statuses.push(value), ...options });
  t.after(() => playback.destroy());
  return { video, playback, statuses, status: () => statuses.at(-1) };
}

test('unsupported HLS is identified before any media request and never times out as a network fault', (t) => {
  const f = fixture(t, { feedType: 'hls' });
  assert.equal(f.video.source, null);
  assert.equal(f.status().status, 'unsupported');
  assert.match(f.status().message, /browser.*HLS/);
  t.mock.timers.tick(1000);
  assert.equal(f.statuses.length, 1);
});

test('native HLS is attempted, and stream failures explain the required playlist relay', (t) => {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  const f = fixture(t, { video, feedType: 'hls' });
  assert.equal(video.source, '/camera');
  video.emit('error');
  assert.equal(f.status().status, 'unavailable');
  assert.match(f.status().message, /playlist segment relay/);
  assert.equal(video.source, null);
});

test('initial loading and later stalls have finite deadlines, with an explicit retry that can recover', async (t) => {
  const f = fixture(t);
  t.mock.timers.tick(100);
  assert.match(f.status().message, /timed out/);
  assert.equal(f.video.source, null);
  assert.equal(f.playback.retry(), true);
  f.video.emit('canplay');
  await flush();
  assert.equal(f.status().status, 'ready');
  assert.equal(f.video.playCount, 1);
  f.video.emit('waiting');
  t.mock.timers.tick(90);
  f.video.emit('stalled');
  t.mock.timers.tick(10);
  assert.equal(f.status().status, 'unavailable', 'repeat stalls cannot extend the deadline forever');
  f.playback.setActive(false);
  f.playback.setActive(true);
  f.video.emit('canplay');
  await flush();
  assert.equal(f.status().status, 'ready');
});

test('play requests coalesce and permission rejection is never retried by animation frames', async (t) => {
  const video = new Video();
  let reject;
  video.play = () => { video.playCount++; return new Promise((_, fail) => { reject = fail; }); };
  const f = fixture(t, { video });
  video.emit('canplay');
  for (let i = 0; i < 100; i++) f.playback.resume();
  await flush();
  assert.equal(video.playCount, 1);
  reject(new DOMException('Autoplay denied', 'NotAllowedError'));
  await flush();
  assert.equal(f.status().status, 'blocked');
  for (let i = 0; i < 100; i++) f.playback.resume();
  await flush();
  assert.equal(video.playCount, 1);
});

test('destroy detaches listeners, cancels deadlines and prevents late autoplay completion from restarting media', async (t) => {
  const video = new Video();
  let finish;
  video.play = () => { video.playCount++; return new Promise(resolve => { finish = resolve; }); };
  const f = fixture(t, { video });
  video.emit('canplay');
  await flush();
  f.playback.destroy();
  const count = f.statuses.length;
  video.paused = false;
  finish();
  await flush();
  video.emit('canplay');
  video.emit('error');
  t.mock.timers.tick(1000);
  assert.equal(video.paused, true);
  assert.equal(video.source, null);
  assert.equal(f.statuses.length, count);
});

test('the actual camera projection replaces a failed video texture with a visible explanation and recovers', async (t) => {
  const video = new Video();
  const canvas = { getContext: () => ({}) };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: name => name === 'video' ? video : canvas };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const painted = [];
  const viewer = { entities: new Cesium.EntityCollection() };
  const state = { _viewer: viewer, _cctvOverlayHost: { clearSource() {}, setVisible() {} } };
  const record = {
    camera: { id: 'test', name: 'Test camera', feedType: 'mp4' },
    frustumGeometry: { halfW: 1, halfH: 1 },
    frustumPositions: { capCenter: new Cesium.Cartesian3(1, 2, 3), label: new Cesium.Cartesian3(1, 2, 4) },
  };
  const projection = createProjection({ state, services: { render: {} }, parts: {
    model: { normalizeFeedType: value => value, isVideoFeedType: () => true, planeOrientationFor: () => Cesium.Quaternion.IDENTITY },
    frames: { mediaUrlFor: () => '/camera', paintProjectionPlaceholder: (_ctx, _camera, status) => painted.push(status) },
  } });
  const runtime = projection.createProjectionRuntime(record);
  t.after(() => projection.destroyProjectionRuntime(runtime));
  assert.equal(runtime.planeMaterial.image.getValue(), canvas);
  assert.match(runtime.overlayEntry.details[0], /Loading/);
  video.emit('canplay');
  await flush();
  assert.equal(runtime.planeMaterial.image.getValue(), video);
  video.error = { code: 3 };
  video.emit('error');
  assert.equal(runtime.planeMaterial.image.getValue(), canvas);
  assert.match(painted.at(-1).message, /cannot be decoded/);
  assert.match(runtime.overlayEntry.details[0], /cannot be decoded/);
  assert.equal(runtime.playback.retry(), true);
  video.emit('canplay');
  await flush();
  assert.equal(runtime.planeMaterial.image.getValue(), video);
  assert.deepEqual(runtime.overlayEntry.details, []);
});
