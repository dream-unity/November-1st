import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CctvControls } from './cctvControls.js';

function element() {
  const classes = new Set();
  return {
    dataset: {},
    src: '',
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    },
    classList: {
      add(...values) {
        values.forEach((value) => classes.add(value));
      },
      remove(...values) {
        values.forEach((value) => classes.delete(value));
      },
      contains(value) {
        return classes.has(value);
      },
      toggle(value, enabled) {
        if (enabled) classes.add(value);
        else classes.delete(value);
      },
    },
  };
}
function fixture(t) {
  const prior = globalThis.Image;
  const requests = [];
  globalThis.Image = class {
    constructor() {
      requests.push(this);
    }
    removeAttribute(name) {
      if (name === 'src') {
        this.src = '';
        this.cancelled = true;
      }
    }
  };
  t.after(() => {
    globalThis.Image = prior;
  });
  const controls = new CctvControls({
    elements: { _cctvFrame: element(), _cctvFrameWrap: element() },
    cctv: {},
    actions: { isEnabled: () => true },
  });
  t.after(() => controls.destroy());
  return { controls, requests };
}

test('a late image completion cannot replace a newer camera preview', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const stale = requests[0].onload;
  controls._queueCctvFrame('second.jpg', 'b', true);
  assert.equal(requests[0].onload, null);
  assert.equal(requests[0].cancelled, true);
  requests[1].onload();
  stale();
  assert.equal(controls._cctvFrame.src, 'second.jpg');
  assert.equal(controls._cctvFrame.dataset.cameraId, 'b');
});

test('failed refresh preserves settled pixels, but changing cameras clears them', (t) => {
  const { controls, requests } = fixture(t);
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  requests[1].onerror();
  assert.equal(controls._cctvFrame.src, 'first.jpg');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), true);
  controls._queueCctvFrame('other.jpg', 'b', true);
  assert.equal(controls._cctvFrame.src, '');
  assert.equal(controls._cctvFrameWrap.classList.contains('has-frame'), false);
});

test('destroy invalidates image callbacks and releases each subscription once', (t) => {
  const { controls, requests } = fixture(t);
  let unsubscribed = 0;
  controls.cctv.subscribe = () => () => {
    unsubscribed++;
  };
  controls.connect();
  controls.connect();
  assert.equal(unsubscribed, 1);
  controls._queueCctvFrame('first.jpg', 'a', true);
  const late = requests[0].onload;
  controls.destroy();
  controls.destroy();
  controls.connect();
  late();
  assert.equal(unsubscribed, 2);
  assert.equal(requests[0].onload, null);
  assert.equal(requests[0].onerror, null);
  assert.equal(requests[0].cancelled, true);
  assert.equal(controls._cctvFrame.src, '');
  controls._queueCctvFrame('late.jpg', 'b', true);
  assert.equal(requests.length, 1);
});

function calibrationFixture(t) {
  const { controls } = fixture(t);
  const prior = globalThis.document;
  const inputs = [];
  globalThis.document = {
    createElement() {
      const input = new EventTarget();
      Object.assign(input, {
        focus() {},
        select() {},
        remove() {
          this.parent.input = null;
        },
      });
      inputs.push(input);
      return input;
    },
  };
  t.after(() => {
    globalThis.document = prior;
  });
  const chip = {
    dataset: { calField: 'heading' },
    textContent: '',
    input: null,
    appendChild(input) {
      this.input = input;
      input.parent = this;
    },
    querySelector() {
      return this.input;
    },
  };
  const patches = [];
  controls.actions.setParams = (params) => patches.push(params);
  controls.actions.setPanelCollapsed = () => {};
  controls._cctvCalReadout = { querySelectorAll: () => [chip] };
  controls._cctvState = {
    enabled: true,
    activeCameraId: 'a',
    activeCamera: { id: 'a', headingDeg: 30, basePose: { headingDeg: 20 } },
  };
  const key = (name) =>
    Object.assign(new Event('keydown', { cancelable: true }), { key: name });
  return { controls, chip, inputs, patches, key };
}

test('calibration commits against the captured camera base and releases its editor', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._cctvState.activeCamera.basePose.headingDeg = 60;
  inputs[0].dispatchEvent(key('Enter'));
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, [
    {
      selectedCameraId: 'a',
      calibration: { cameraId: 'a', patch: { headingDeg: 80 } },
    },
  ]);
  assert.equal(controls._calibrationEdit, null);
});

test('a camera switch cancels calibration before old blur can change the new camera', (t) => {
  const { controls, chip, inputs, patches } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  controls._renderCctvState({
    enabled: true,
    activeCameraId: 'b',
    activeCamera: { id: 'b', headingDeg: 200, basePose: { headingDeg: 190 } },
  });
  inputs[0].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
  assert.equal(chip.input, null);
  assert.equal(chip.textContent, 'HDG 200.0°');
});

test('Escape claims calibration cancellation and disposal prevents late commits', (t) => {
  const { controls, chip, inputs, patches, key } = calibrationFixture(t);
  controls._beginCctvCalValueEdit(chip);
  inputs[0].value = '100';
  const escape = key('Escape');
  inputs[0].dispatchEvent(escape);
  inputs[0].dispatchEvent(new Event('blur'));
  assert.equal(escape.defaultPrevented, true);
  controls._beginCctvCalValueEdit(chip);
  inputs[1].value = '120';
  controls.destroy();
  inputs[1].dispatchEvent(new Event('blur'));
  assert.deepEqual(patches, []);
});

test('disposing during camera enable prevents the delayed focus and future clicks', async () => {
  const button = new EventTarget();
  let resolveEnable;
  let enables = 0;
  let focuses = 0;
  const controls = new CctvControls({
    elements: { _cctvPanel: {}, _cctvNextBtn: button },
    cctv: {},
    actions: {
      isEnabled: () => true,
      syncViewport() {},
      toggleEnabled() {
        enables++;
        return new Promise((resolve) => {
          resolveEnable = resolve;
        });
      },
      runExplicitFocus() {
        focuses++;
      },
    },
  });
  button.dispatchEvent(new Event('click'));
  controls.destroy();
  resolveEnable(true);
  await new Promise((resolve) => setImmediate(resolve));
  button.dispatchEvent(new Event('click'));
  assert.equal(enables, 1);
  assert.equal(focuses, 0);
});

test('a stalled snapshot ends loading, rejects late pixels and honestly labels a failed refresh', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { controls, requests } = fixture(t);
  controls._cctvSourceBadge = element();
  controls._cctvState = { enabled: true, activeCamera: { id: 'a' } };
  controls._queueCctvFrame('first.jpg', 'a', true);
  requests[0].onload();
  controls._queueCctvFrame('refresh.jpg', 'a', false);
  const late = requests[1].onload;
  t.mock.timers.tick(20_000);
  assert.equal(controls._cctvFrame.dataset.loading, '');
  assert.match(controls._cctvSourceBadge.textContent, /PREVIOUS FRAME/);
  late();
  assert.equal(controls._cctvFrame.src, 'first.jpg');
});

test('the camera panel renders video controls, keeps an existing stream across refreshes and releases it on disable', async (t) => {
  const { controls } = fixture(t);
  const before = globalThis.document;
  const videos = [];
  globalThis.document = {
    createElement(name) {
      if (name === 'button')
        return {
          remove() {
            this.removed = true;
          },
        };
      assert.equal(name, 'video');
      const video = new EventTarget();
      Object.assign(video, {
        paused: true,
        setAttribute() {},
        removeAttribute(name) {
          if (name === 'src') this.src = '';
        },
        load() {},
        pause() {
          this.paused = true;
        },
        play() {
          this.paused = false;
          return Promise.resolve();
        },
        remove() {
          this.removed = true;
        },
      });
      videos.push(video);
      return video;
    },
  };
  t.after(() => {
    globalThis.document = before;
  });
  controls.actions.setPanelCollapsed = () => {};
  controls._cctvFrameWrap.appendChild = () => {};
  controls._cctvSourceBadge = element();
  const state = {
    enabled: true,
    activeCameraId: 'v',
    activeCamera: {
      id: 'v',
      name: 'Live camera',
      feedType: 'mp4',
      mediaUrl: '/api/cctv/media/v?ts=1',
      frameUrl: '/api/cctv/frame/v',
    },
  };
  controls._renderCctvState(state);
  assert.equal(videos.length, 1);
  assert.equal(videos[0].src, '/api/cctv/media/v?ts=1');
  assert.equal(videos[0].controls, true);
  assert.equal(controls._cctvFrame.hidden, true);
  videos[0].dispatchEvent(new Event('canplay'));
  assert.match(controls._cctvSourceBadge.textContent, /READY/);
  controls._renderCctvState({
    ...state,
    activeCamera: { ...state.activeCamera, mediaUrl: '/api/cctv/media/v?ts=2' },
  });
  assert.equal(videos.length, 1);
  controls._renderCctvState({ ...state, enabled: false });
  assert.equal(videos[0].src, '');
  assert.equal(videos[0].removed, true);
  assert.equal(controls._cctvFrame.hidden, false);
});

function embeddedPanelFixture(t, currentStatus = 'live') {
  const { controls, requests } = fixture(t);
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    MutationObserver: globalThis.MutationObserver,
  };
  const players = [];
  const observers = [];
  const statusRequests = [];
  const document = new EventTarget();
  document.hidden = false;
  document.createElement = (tag) =>
    Object.assign(new EventTarget(), element(), {
      tagName: tag,
      ownerDocument: document,
      children: [],
      setAttribute(name, value) {
        this[name] = value;
      },
      appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
      },
      remove() {
        if (this.parentNode)
          this.parentNode.children = this.parentNode.children.filter(
            (child) => child !== this,
          );
        this.removed = true;
      },
    });
  class Player {
    constructor(iframe, options) {
      this.iframe = iframe;
      this.events = options.events;
      this.plays = 0;
      players.push(this);
    }
    mute() {}
    playVideo() {
      this.plays++;
    }
    destroy() {
      this.destroyed = true;
      this.iframe.remove();
    }
    emit(name, data) {
      this.events[name]?.({ target: this, data });
    }
  }
  document.defaultView = {
    location: { origin: 'https://app.example' },
    YT: { Player },
  };
  globalThis.document = document;
  globalThis.fetch = async (url) => {
    statusRequests.push(url);
    return Response.json({
      status: currentStatus,
      checkedAt: '2026-09-17T12:00:00.000Z',
      message:
        currentStatus === 'ended' ? 'The publisher ended this broadcast.' : '',
    });
  };
  globalThis.MutationObserver = class {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  };
  t.after(() => Object.assign(globalThis, previous));
  controls._cctvPanel = document.createElement('section');
  controls._cctvFrameWrap = document.createElement('div');
  controls._cctvSourceBadge = element();
  controls.actions.setPanelCollapsed = () => {};
  const state = {
    enabled: true,
    activeCameraId: 'jp-embed',
    activeCamera: {
      id: 'jp-embed',
      name: 'Tokyo public camera',
      feedType: 'embed',
      playbackKind: 'live',
      embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk',
      sourcePage: 'https://publisher.example/camera',
      frameUrl: '/api/cctv/frame/jp-embed',
    },
  };
  return {
    controls,
    requests,
    players,
    observers,
    state,
    document,
    statusRequests,
  };
}

const flushEmbedPanel = () => new Promise((resolve) => setImmediate(resolve));

test('the globe camera panel plays an official embed, never loads snapshot pixels and fully releases media on pause or camera change', async (t) => {
  const f = embeddedPanelFixture(t);
  f.controls._renderCctvState(f.state);
  await flushEmbedPanel();
  assert.equal(f.requests.length, 0);
  assert.equal(f.controls._cctvFrame.hidden, true);
  assert.equal(f.players.length, 1);
  assert.equal(
    f.statusRequests[0],
    'https://app.example/api/cctv/embed-status/jp-embed',
  );
  assert.equal(
    f.controls._cctvVideoSource.href,
    'https://publisher.example/camera',
  );
  assert.match(f.controls._cctvVideoNote.textContent, /not projected/);
  f.players[0].emit('onReady');
  assert.doesNotMatch(f.controls._cctvSourceBadge.textContent, /PLAYING/);
  f.players[0].emit('onStateChange', 1);
  assert.match(f.controls._cctvSourceBadge.textContent, /LIVE VIDEO · PLAYING/);
  f.controls._renderCctvState(f.state);
  await flushEmbedPanel();
  assert.equal(
    f.players.length,
    1,
    'routine camera metadata updates keep the current player',
  );
  f.controls._cctvVideoPause.onclick();
  assert.equal(f.players[0].destroyed, true);
  assert.equal(f.controls._cctvVideo.children.length, 0);
  assert.equal(
    f.controls._cctvVideoRetry.hidden,
    false,
    'a paused iframe still has a working Play button',
  );
  f.controls._cctvVideoRetry.onclick();
  await flushEmbedPanel();
  assert.equal(f.players.length, 2);
  f.players[0].emit('onStateChange', 1);
  assert.equal(
    f.controls._cctvVideoStatus.status,
    'loading',
    'late old-player events are ignored',
  );
  const removedContainer = f.controls._cctvVideo;
  f.controls._renderCctvState({
    ...f.state,
    activeCameraId: 'snapshot',
    activeCamera: { id: 'snapshot', feedType: 'image', frameUrl: '/snapshot' },
  });
  assert.equal(f.players[1].destroyed, true);
  assert.equal(removedContainer.removed, true);
  assert.equal(f.observers[0].disconnected, true);
  assert.equal(
    f.requests.length,
    1,
    'only selecting a real snapshot starts a snapshot request',
  );
});

test('collapsing the globe camera panel unloads the iframe and resumes only intended playback', async (t) => {
  const f = embeddedPanelFixture(t);
  f.controls._renderCctvState(f.state);
  await flushEmbedPanel();
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  f.controls._cctvPanel.classList.add('collapsed');
  f.observers[0].callback();
  assert.equal(f.players[0].destroyed, true);
  assert.equal(f.controls._cctvVideo.children.length, 0);
  f.controls._cctvPanel.classList.remove('collapsed');
  f.observers[0].callback();
  await flushEmbedPanel();
  assert.equal(f.players.length, 2);
  f.controls._cctvVideoPause.onclick();
  f.controls._cctvPanel.classList.add('collapsed');
  f.observers[0].callback();
  f.controls._cctvPanel.classList.remove('collapsed');
  f.observers[0].callback();
  await flushEmbedPanel();
  assert.equal(
    f.players.length,
    2,
    'manually paused media remains paused after reopening',
  );
  assert.equal(f.controls._cctvVideoRetry.hidden, false);
});

test('the globe camera panel refuses ended broadcasts and does not claim unconfirmed playback is live', async (t) => {
  for (const status of ['ended', 'unknown']) {
    await t.test(status, async (t) => {
      const f = embeddedPanelFixture(t, status);
      f.controls._renderCctvState(f.state);
      await flushEmbedPanel();
      assert.equal(f.requests.length, 0);
      if (status === 'ended') {
        assert.equal(f.players.length, 0);
        assert.match(f.controls._cctvSourceBadge.textContent, /ended/);
        assert.equal(f.controls._cctvVideoRetry.hidden, false);
      } else {
        f.players[0].emit('onReady');
        f.players[0].emit('onStateChange', 1);
        assert.match(
          f.controls._cctvSourceBadge.textContent,
          /live status unconfirmed/i,
        );
        assert.doesNotMatch(
          f.controls._cctvSourceBadge.textContent,
          /LIVE VIDEO/,
        );
      }
    });
  }
});
