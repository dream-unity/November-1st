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
  canPlayType() {
    return '';
  }
  set src(value) {
    this.source = value;
  }
  getAttribute(name) {
    return name === 'src' ? this.source : null;
  }
  removeAttribute(name) {
    if (name === 'src') this.source = null;
  }
  load() {
    this.loadCount++;
  }
  pause() {
    this.paused = true;
  }
  play() {
    this.playCount++;
    this.paused = false;
    return Promise.resolve();
  }
  emit(name) {
    this.dispatchEvent(new Event(name));
  }
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const video = options.video || new Video();
  const statuses = [];
  const playback = createCctvVideoPlayback({
    video,
    url: '/camera',
    feedType: 'mp4',
    timeoutMs: 100,
    loadHls: async () => ({ isSupported: () => false }),
    onStatus: (value) => statuses.push(value),
    ...options,
  });
  t.after(() => playback.destroy());
  return { video, playback, statuses, status: () => statuses.at(-1) };
}

test('unsupported HLS is identified after the browser adapter check and does not become a network fault', async (t) => {
  const f = fixture(t, {
    feedType: 'hls',
    loadHls: async () => ({ isSupported: () => false }),
  });
  await flush();
  assert.equal(f.video.source, null);
  assert.equal(f.status().status, 'unsupported');
  assert.match(f.status().message, /browser.*HLS/);
  t.mock.timers.tick(1000);
  assert.equal(f.statuses.length, 2);
});

test('native HLS is attempted and stream failures give an actionable retry message', async (t) => {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  const f = fixture(t, { video, feedType: 'hls' });
  await flush();
  assert.equal(video.source, '/camera');
  video.emit('error');
  assert.equal(f.status().status, 'unavailable');
  assert.match(f.status().message, /retry or choose another camera/);
  assert.equal(video.source, null);
});

test('HLS adapter loads browsers without native HLS, then tears down a failed session', async (t) => {
  const instances = [];
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    constructor() {
      instances.push(this);
    }
    on(_name, callback) {
      this.onError = callback;
    }
    loadSource(url) {
      this.source = url;
    }
    attachMedia(video) {
      this.video = video;
    }
    stopLoad() {
      this.stopped = true;
    }
    startLoad() {
      this.stopped = false;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const f = fixture(t, { feedType: 'hls', loadHls: async () => Hls });
  await flush();
  assert.equal(instances[0].source, '/camera');
  assert.equal(instances[0].video, f.video);
  f.video.emit('canplay');
  await flush();
  assert.equal(f.status().status, 'ready');
  f.playback.setActive(false);
  assert.equal(instances[0].stopped, true);
  f.playback.setActive(true);
  assert.equal(instances[0].stopped, false);
  instances[0].onError('error', { fatal: false });
  assert.equal(f.status().status, 'ready');
  instances[0].onError('error', { fatal: true });
  assert.equal(f.status().status, 'unavailable');
  assert.equal(instances[0].destroyed, true);
  assert.equal(f.playback.retry(), true);
  await flush();
  assert.equal(instances.length, 2);
  f.playback.destroy();
  assert.equal(instances[1].destroyed, true);
});

test('a lazy HLS adapter finishing after disposal cannot create a media session', async (t) => {
  let resolve;
  let created = 0;
  class Hls {
    static isSupported = () => true;
    constructor() {
      created++;
    }
  }
  const f = fixture(t, {
    feedType: 'hls',
    loadHls: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  f.playback.destroy();
  resolve(Hls);
  await flush();
  assert.equal(created, 0);
});

test('a panel with native controls never resumes playback on canplay unless explicitly requested', async (t) => {
  const f = fixture(t, { autoPlay: false });
  f.video.emit('loadedmetadata');
  t.mock.timers.tick(200);
  assert.equal(
    f.status().status,
    'ready',
    'metadata-only preload may wait for native Play without timing out',
  );
  f.video.emit('canplay');
  await flush();
  assert.equal(f.video.playCount, 0);
  f.playback.resume();
  await flush();
  assert.equal(f.video.playCount, 1);
  f.video.pause();
  f.video.emit('canplay');
  await flush();
  assert.equal(f.video.playCount, 1);
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
  assert.equal(
    f.status().status,
    'unavailable',
    'repeat stalls cannot extend the deadline forever',
  );
  f.playback.setActive(false);
  f.playback.setActive(true);
  f.playback.retry();
  f.video.emit('canplay');
  await flush();
  assert.equal(f.status().status, 'ready');
});

test('play requests coalesce and permission rejection is never retried by animation frames', async (t) => {
  const video = new Video();
  let reject;
  video.play = () => {
    video.playCount++;
    return new Promise((_, fail) => {
      reject = fail;
    });
  };
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

test('a hung play promise has a deadline and cannot prevent a new retry from playing', async (t) => {
  const video = new Video();
  video.play = () => {
    video.playCount++;
    return new Promise(() => {});
  };
  const f = fixture(t, { video });
  video.emit('canplay');
  await flush();
  t.mock.timers.tick(100);
  assert.equal(f.status().status, 'unavailable');
  assert.match(f.status().message, /did not start/);
  video.play = () => {
    video.playCount++;
    video.paused = false;
    return Promise.resolve();
  };
  assert.equal(f.playback.retry(), true);
  video.emit('canplay');
  await flush();
  assert.equal(video.playCount, 2);
  assert.equal(f.status().status, 'ready');
});

test('destroy detaches listeners, cancels deadlines and prevents late autoplay completion from restarting media', async (t) => {
  const video = new Video();
  let finish;
  video.play = () => {
    video.playCount++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
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
  globalThis.document = {
    createElement: (name) => (name === 'video' ? video : canvas),
  };
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  });
  const painted = [];
  const viewer = { entities: new Cesium.EntityCollection() };
  const state = {
    _viewer: viewer,
    _cctvOverlayHost: { clearSource() {}, setVisible() {} },
  };
  const record = {
    camera: { id: 'test', name: 'Test camera', feedType: 'mp4' },
    frustumGeometry: { halfW: 1, halfH: 1 },
    frustumPositions: {
      capCenter: new Cesium.Cartesian3(1, 2, 3),
      label: new Cesium.Cartesian3(1, 2, 4),
    },
  };
  const projection = createProjection({
    state,
    services: { render: {} },
    parts: {
      model: {
        normalizeFeedType: (value) => value,
        isVideoFeedType: () => true,
        planeOrientationFor: () => Cesium.Quaternion.IDENTITY,
      },
      frames: {
        mediaUrlFor: () => '/camera',
        paintProjectionPlaceholder: (_ctx, _camera, status) =>
          painted.push(status),
      },
    },
  });
  const runtime = projection.createProjectionRuntime(record);
  t.after(() => projection.destroyProjectionRuntime(runtime));
  assert.equal(runtime.planeMaterial.image.getValue(), canvas);
  assert.match(runtime.overlayEntry.details[0], /Connecting/);
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
  assert.match(runtime.overlayEntry.details[0], /ready/);
});

test('only the playing event confirms playback; metadata and resolved play promises cannot claim moving video', async (t) => {
  const f = fixture(t, { autoPlay: false });
  f.video.emit('loadedmetadata');
  assert.equal(f.status().status, 'ready');
  f.playback.play();
  await flush();
  assert.equal(f.status().status, 'ready');
  t.mock.timers.tick(100);
  assert.equal(
    f.status().status,
    'unavailable',
    'resolved play without playback still has a finite start deadline',
  );
  f.playback.retry();
  f.video.emit('canplay');
  f.video.emit('playing');
  assert.equal(f.status().status, 'playing');
  t.mock.timers.tick(200);
  assert.equal(f.status().status, 'playing');
});

test('user pause and finite clip completion are respected even when canplay fires repeatedly', async (t) => {
  const f = fixture(t);
  f.video.emit('canplay');
  await flush();
  f.video.emit('playing');
  assert.equal(f.status().status, 'playing');
  f.playback.pause();
  f.video.emit('canplay');
  f.playback.resume();
  assert.equal(f.status().status, 'paused');
  assert.equal(f.video.paused, true);
  f.playback.play();
  await flush();
  f.video.emit('playing');
  assert.equal(f.status().status, 'playing');
  f.video.emit('ended');
  f.video.emit('canplay');
  f.playback.resume();
  assert.equal(f.status().status, 'ended');
  f.playback.play();
  assert.equal(f.video.currentTime, 0);
});

test('browser permission refusal preserves the attached media and a synchronous explicit Play can recover', async (t) => {
  const video = new Video();
  video.play = () =>
    Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  const f = fixture(t, { video });
  video.emit('canplay');
  await flush();
  assert.equal(f.status().status, 'blocked');
  assert.equal(video.source, '/camera');
  let synchronous = false;
  video.play = () => {
    synchronous = true;
    video.paused = false;
    video.emit('playing');
    return Promise.resolve();
  };
  f.playback.play();
  assert.equal(synchronous, true);
  assert.equal(f.status().status, 'playing');
});

test('visibility suspends HLS loading and resumes only previously playing media, respecting explicit inactivity', async (t) => {
  const doc = new EventTarget();
  doc.hidden = false;
  const instances = [];
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    constructor() {
      instances.push(this);
    }
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {
      this.destroyed = true;
    }
    stopLoad() {
      this.stopped = true;
    }
    startLoad() {
      this.stopped = false;
    }
  }
  const f = fixture(t, {
    feedType: 'hls',
    loadHls: async () => Hls,
    visibilityTarget: doc,
  });
  await flush();
  f.video.emit('canplay');
  await flush();
  f.video.emit('playing');
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(instances[0].stopped, true);
  assert.equal(f.video.paused, true);
  t.mock.timers.tick(1000);
  assert.equal(f.status().status, 'suspended');
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  f.video.emit('playing');
  assert.equal(instances[0].stopped, false);
  assert.equal(f.status().status, 'playing');
  f.playback.pause();
  const count = f.video.playCount;
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.video.playCount, count);
  assert.equal(f.status().status, 'paused');
  f.playback.setActive(false);
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(instances[0].stopped, true);
  f.playback.destroy();
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(instances[0].destroyed, true);
});

test('a delayed play settlement or playing event cannot undo an explicit pause', async (t) => {
  const video = new Video();
  let finish;
  video.play = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const f = fixture(t, { video });
  video.emit('canplay');
  f.playback.pause();
  video.paused = false;
  video.emit('playing');
  finish();
  await flush();
  assert.equal(video.paused, true);
  assert.equal(f.status().status, 'paused');
});

test('a finite HLS playlist ending reconnects on explicit Play rather than silently looping the recording', async (t) => {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  const f = fixture(t, { video, feedType: 'hls' });
  await flush();
  video.emit('canplay');
  await flush();
  video.emit('playing');
  video.emit('ended');
  const loads = video.loadCount;
  f.playback.play();
  assert.ok(video.loadCount > loads);
  assert.equal(f.status().status, 'loading');
  await flush();
  assert.equal(video.source, '/camera');
});

test('a queued internal pause event after tab resume cannot cancel the new playback intent', async (t) => {
  const video = new Video();
  const doc = new EventTarget();
  doc.hidden = false;
  const f = fixture(t, { video, visibilityTarget: doc });
  video.emit('canplay');
  await flush();
  video.emit('playing');
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  await flush();
  video.emit('playing');
  assert.equal(video.paused, false);
  video.emit('pause');
  assert.equal(f.status().status, 'playing');
  assert.equal(video.paused, false);
});

test('a collapsed camera panel performs no source loading until explicitly activated', async (t) => {
  const f = fixture(t, { initiallyActive: false });
  assert.equal(f.video.source, null);
  t.mock.timers.tick(1000);
  assert.equal(f.status().status, 'loading');
  f.playback.setActive(true);
  assert.equal(f.video.source, '/camera');
  f.video.emit('canplay');
  await flush();
  f.video.emit('playing');
  f.playback.setActive(false);
  assert.equal(f.video.paused, true);
  assert.equal(f.status().status, 'suspended');
});

test('MSE-capable browsers use the controlled HLS player even when they advertise native HLS', async (t) => {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  let player;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    constructor(options) {
      player = this;
      this.options = options;
    }
    on(_event, callback) {
      this.error = callback;
    }
    loadSource(url) {
      this.source = url;
    }
    attachMedia(media) {
      this.media = media;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const f = fixture(t, {
    video,
    feedType: 'hls',
    playbackKind: 'live',
    loadHls: async () => Hls,
  });
  await flush();
  assert.equal(video.source, null, 'native src must not bypass controlled HLS');
  assert.equal(player.source, '/camera');
  assert.equal(player.media, video);
  assert.equal(player.options.liveSyncDurationCount, 1);
  assert.equal(player.options.liveMaxLatencyDurationCount, 3);
  player.error('error', {
    fatal: true,
    type: 'networkError',
    details: 'fragLoadError',
    response: { code: 404 },
    url: 'secret-url',
  });
  assert.equal(f.status().status, 'reconnecting');
  assert.equal(f.status().reason, 'hls-network-error');
  assert.match(f.status().message, /fragment request failed, HTTP 404/);
  assert.doesNotMatch(f.status().message, /secret-url/);
});

test('live network failures reload a fresh playlist with a finite three-attempt backoff budget', async (t) => {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  video.error = { code: 2 };
  const f = fixture(t, { video, feedType: 'hls', playbackKind: 'live' });
  await flush();
  for (let i = 0; i < 3; i++) {
    video.emit('error');
    assert.equal(f.status().status, 'reconnecting');
    assert.equal(f.status().reason, 'media-network-error');
    assert.match(f.status().message, new RegExp(`${i + 1}/3`));
    assert.equal(video.source, null);
    t.mock.timers.tick(1000 * 2 ** i - 1);
    assert.equal(video.source, null);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(video.source, '/camera');
  }
  video.emit('error');
  assert.equal(f.status().status, 'unavailable');
  assert.match(f.status().message, /limit reached/);
  const loads = video.loadCount;
  t.mock.timers.tick(60_000);
  assert.equal(video.loadCount, loads);
  f.playback.setActive(false);
  f.playback.setActive(true);
  await flush();
  assert.equal(
    video.loadCount,
    loads,
    'visibility cannot evade a terminal recovery budget',
  );
  assert.equal(f.playback.retry(), true);
  await flush();
  video.emit('error');
  assert.match(f.status().message, /1\/3/);
});

for (const fatal of [false, true]) {
  test(`HLS HTTP 410 ends live playback without reconnecting, even when fatal is ${fatal}`, async (t) => {
    const players = [];
    class Hls {
      static isSupported = () => true;
      static Events = { ERROR: 'error' };
      constructor() { players.push(this); }
      on(_name, callback) { this.error = callback; }
      loadSource() {}
      attachMedia() {}
      destroy() { this.destroyed = true; }
    }
    const f = fixture(t, {
      feedType: 'hls', playbackKind: 'live', loadHls: async () => Hls,
    });
    await flush();
    f.video.emit('canplay');
    await flush();
    f.video.emit('playing');
    players[0].error('error', {
      fatal, type: 'networkError', details: 'levelLoadError', response: { code: 410 },
    });
    assert.equal(f.status().status, 'ended');
    assert.equal(f.status().reason, 'broadcast-ended');
    assert.match(f.status().message, /broadcast has ended/);
    assert.equal(players[0].destroyed, true);
    assert.equal(f.video.source, null);
    assert.equal(f.video.paused, true);
    const loads = f.video.loadCount;
    f.video.emit('canplay');
    f.video.emit('playing');
    players[0].error('error', {
      fatal: true, type: 'networkError', details: 'fragLoadError', response: { code: 404 },
    });
    t.mock.timers.tick(60_000);
    await flush();
    f.playback.setActive(false);
    f.playback.setActive(true);
    await flush();
    assert.equal(f.status().status, 'ended');
    assert.equal(f.video.loadCount, loads);
    assert.equal(players.length, 1, 'no timer or visibility change can replay the archived stream');
    assert.equal(f.playback.retry(), true);
    await flush();
    assert.equal(players.length, 2, 'only an explicit retry requests fresh server admission');
    assert.equal(f.status().status, 'loading');
  });
}

test('pausing, hiding or destroying during reconnect prevents delayed source attachment', async (t) => {
  for (const operation of ['pause', 'hide', 'destroy']) {
    const video = new Video();
    video.canPlayType = () => 'maybe';
    video.error = { code: 2 };
    const doc = new EventTarget();
    doc.hidden = false;
    const f = fixture(t, {
      video,
      feedType: 'hls',
      playbackKind: 'live',
      visibilityTarget: doc,
    });
    await flush();
    video.emit('error');
    if (operation === 'hide') {
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
    } else f.playback[operation]();
    const loads = video.loadCount;
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(video.source, null);
    assert.equal(video.loadCount, loads);
    if (operation === 'pause') {
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
      doc.hidden = false;
      doc.dispatchEvent(new Event('visibilitychange'));
      await flush();
      assert.equal(
        video.source,
        null,
        'a paused reconnect stays paused across visibility changes',
      );
    }
    f.playback.destroy();
    t.mock.timers.reset();
  }
});

test('finite clips, unconfirmed video and decode/unsupported failures never automatically reconnect', async (t) => {
  for (const [playbackKind, code] of [
    ['clip', 2],
    ['video', 2],
    ['live', 3],
    ['live', 4],
  ]) {
    const video = new Video();
    video.error = { code };
    const f = fixture(t, { video, playbackKind });
    video.emit('error');
    assert.equal(f.status().status, 'unavailable');
    assert.ok(f.status().reason);
    const loads = video.loadCount;
    t.mock.timers.tick(10_000);
    assert.equal(video.loadCount, loads);
    f.playback.destroy();
    t.mock.timers.reset();
  }
});

test('reconnect budget resets only after stable elapsed playback and advancing media time', async (t) => {
  const video = new Video();
  video.error = { code: 2 };
  video.currentTime = 0;
  const f = fixture(t, { video, playbackKind: 'live' });
  video.emit('error');
  t.mock.timers.tick(1000);
  video.emit('canplay');
  await flush();
  video.emit('playing');
  video.currentTime = 60;
  video.emit('timeupdate');
  video.emit('error');
  assert.match(
    f.status().message,
    /2\/3/,
    'a seek alone does not reset the budget',
  );
  t.mock.timers.tick(2000);
  video.currentTime = 0;
  video.emit('canplay');
  await flush();
  video.emit('playing');
  t.mock.timers.tick(60_000);
  video.currentTime = 60;
  video.emit('timeupdate');
  video.emit('error');
  assert.match(f.status().message, /1\/3/);
});

test('a partially attached HLS adapter is destroyed before native fallback reuses its video', async (t) => {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  let player;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    constructor() {
      player = this;
    }
    on() {}
    loadSource() {}
    attachMedia() {
      throw new Error('adapter attachment failed');
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const f = fixture(t, { video, feedType: 'hls', loadHls: async () => Hls });
  await flush();
  assert.equal(player.destroyed, true);
  assert.equal(video.source, '/camera');
  video.emit('canplay');
  await flush();
  video.emit('playing');
  assert.equal(f.status().status, 'playing');
});

test('explicit pause while the HLS adapter is still importing cancels the initial loading deadline', async (t) => {
  const video = new Video();
  video.canPlayType = () => 'maybe';
  let resolveAdapter;
  const f = fixture(t, {
    video,
    feedType: 'hls',
    playbackKind: 'live',
    loadHls: () =>
      new Promise((resolve) => {
        resolveAdapter = resolve;
      }),
  });
  f.playback.pause();
  t.mock.timers.tick(10_000);
  assert.equal(f.status().status, 'paused');
  resolveAdapter({ isSupported: () => false });
  await flush();
  assert.equal(video.source, null);
  assert.equal(f.status().status, 'paused');
});

test('HLS loading restarts only after a real suspension, not on every play event', async (t) => {
  let player;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    constructor() {
      player = this;
      this.starts = 0;
      this.stops = 0;
    }
    on() {}
    loadSource() {}
    attachMedia() {}
    destroy() {}
    startLoad() {
      this.starts++;
    }
    stopLoad() {
      this.stops++;
    }
  }
  const f = fixture(t, { feedType: 'hls', loadHls: async () => Hls });
  await flush();
  f.video.emit('canplay');
  await flush();
  f.video.emit('play');
  f.video.emit('playing');
  assert.equal(player.starts, 0, 'initial HLS loader must not be restarted');
  f.playback.pause();
  assert.equal(player.stops, 1);
  f.playback.play();
  f.video.emit('play');
  await flush();
  f.video.emit('playing');
  assert.equal(
    player.starts,
    1,
    'resume and native play event must not restart twice',
  );
});

test('invalid HLS manifests remain terminal even when hls.js categorizes them as network errors', async (t) => {
  let player;
  class Hls {
    static isSupported = () => true;
    static Events = { ERROR: 'error' };
    constructor() {
      player = this;
    }
    on(_event, callback) {
      this.error = callback;
    }
    loadSource() {}
    attachMedia() {}
    destroy() {}
  }
  const f = fixture(t, {
    feedType: 'hls',
    playbackKind: 'live',
    loadHls: async () => Hls,
  });
  await flush();
  player.error('error', {
    fatal: true,
    type: 'networkError',
    details: 'manifestParsingError',
  });
  assert.equal(f.status().status, 'unavailable');
  assert.equal(f.status().reason, 'hls-format-error');
  const count = f.statuses.length;
  t.mock.timers.tick(10_000);
  assert.equal(f.statuses.length, count);
});
