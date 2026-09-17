import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css'))
      return { format: 'module', shortCircuit: true, source: 'export {};' };
    return next(url, context);
  },
});
const { installLiveFeeds } = await import('./liveFeeds.js');
const { showStartupFailure } = await import('./chrome.js');
hooks.deregister();

class Element extends EventTarget {
  constructor(tag, ownerDocument) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.value = '';
    this._text = '';
    this.isConnected = true;
    this.className = '';
    this.open = false;
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((node) => node.textContent).join(' ');
  }
  append(...nodes) {
    for (const node of nodes) {
      this.children.push(node);
      node.parentElement = this;
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'src') this.src = '';
  }
  get options() {
    return this.children;
  }
  get classList() {
    return {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => {
        if (!this.classList.contains(name)) this.className += ` ${name}`;
      },
      remove: (name) => {
        this.className = this.className
          .split(/\s+/)
          .filter((value) => value !== name)
          .join(' ');
      },
    };
  }
  contains(node) {
    return node === this || this.children.some((child) => child.contains(node));
  }
  querySelectorAll(selector) {
    const feedKind = /^\[data-feed-kind="([^"]+)"\]$/.exec(selector)?.[1];
    return this.children
      .flatMap(all)
      .filter((node) =>
        feedKind
          ? node.dataset.feedKind === feedKind
          : selector.startsWith('.') &&
            node.classList.contains(selector.slice(1)),
      );
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  getClientRects() {
    for (let node = this; node; node = node.parentElement)
      if (!node.isConnected || node.hidden || node.classList.contains('hidden'))
        return [];
    return [{}];
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  scrollIntoView() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  }
  remove() {
    this.isConnected = false;
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this,
      );
  }
  closest(selector) {
    if (
      selector === 'button[data-feed-id]' &&
      this.tagName === 'BUTTON' &&
      this.dataset.feedId
    )
      return this;
    if (
      selector === '.du-recovery-actions' &&
      this.className === 'du-recovery-actions'
    )
      return this;
    return this.parentElement?.closest(selector) || null;
  }
}
const all = (node) => [node, ...node.children.flatMap(all)];
const find = (doc, predicate) => all(doc.body).find(predicate);
const click = (target, dispatch = target) => {
  const event = new Event('click');
  if (dispatch !== target)
    Object.defineProperty(event, 'target', { get: () => target });
  dispatch.dispatchEvent(event);
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const station = {
  id: '12345678-1234-1234-1234-123456789012',
  name: 'Test radio',
  lat: 1,
  lon: 2,
  streamUrl: 'https://radio.example/live',
  country: 'Example',
  tags: [],
  languages: [],
};
const camera = {
  id: 'camera-one',
  name: 'Test camera',
  lat: 1,
  lon: 2,
  city: 'Example',
  feedType: 'image',
};
function fixture(fetchImpl) {
  const previous = {
    document: globalThis.document,
    Option: globalThis.Option,
    Audio: globalThis.Audio,
    fetch: globalThis.fetch,
    getComputedStyle: globalThis.getComputedStyle,
  };
  const doc = new EventTarget();
  doc.createElement = (tag) => new Element(tag, doc);
  doc.createTextNode = (value) => {
    const node = doc.createElement('#text');
    node.textContent = value;
    return node;
  };
  doc.body = doc.createElement('body');
  doc.getElementById = (id) => find(doc, (node) => node.id === id) || null;
  doc.activeElement = doc.body;
  doc.hidden = false;
  const audio = [];
  class Audio extends Element {
    constructor() {
      super('audio', doc);
      this.paused = true;
      this.src = '';
      this.playCount = 0;
      audio.push(this);
    }
    play() {
      this.playCount++;
      this.paused = false;
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
      this.dispatchEvent(new Event('pause'));
    }
    load() {}
  }
  globalThis.document = doc;
  globalThis.Audio = Audio;
  globalThis.fetch = fetchImpl;
  globalThis.getComputedStyle = (node) => ({
    visibility: node.visibility || 'visible',
  });
  globalThis.Option = class extends Element {
    constructor(label, value) {
      super('option', doc);
      this.textContent = label;
      this.value = value;
    }
  };
  return {
    doc,
    audio,
    restore() {
      Object.assign(globalThis, previous);
    },
  };
}

test('radio plays only after station click, synchronously stops globe audio, and releases playback on modal close', async () => {
  const f = fixture(async () => Response.json({ stations: [station] }));
  let stoppedGlobe = 0;
  const feeds = installLiveFeeds({
    beforeRadioPlay() {
      stoppedGlobe++;
      assert.equal(f.audio.length, 0);
    },
  });
  try {
    feeds.open('radio');
    await flush();
    assert.equal(f.audio.length, 0);
    const stationButton = find(
      f.doc,
      (node) => node.dataset.feedId === station.id,
    );
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.ok(stationButton);
    click(stationButton, list);
    assert.equal(stoppedGlobe, 1);
    assert.equal(f.audio[0].playCount, 1);
    await flush();
    assert.match(f.doc.body.textContent, /Playing broadcaster audio/);
    find(f.doc, (node) => node.tagName === 'DIALOG').close();
    assert.equal(f.audio[0].paused, true);
    assert.equal(f.audio[0].src, '');
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('late catalogue responses cannot replace another tab and closing aborts pending work', async () => {
  const pending = [];
  const f = fixture(
    (url, options) =>
      new Promise((resolve) => pending.push({ url, options, resolve })),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    feeds.open('cctv');
    assert.equal(pending[0].options.signal.aborted, true);
    pending[0].resolve(Response.json({ stations: [station] }));
    pending[1].resolve(Response.json({ sources: [camera] }));
    await flush();
    assert.match(f.doc.body.textContent, /Test camera/);
    assert.doesNotMatch(f.doc.body.textContent, /Test radio/);
    click(find(f.doc, (node) => node.textContent === 'Refresh directory'));
    find(f.doc, (node) => node.tagName === 'DIALOG').close();
    assert.equal(pending[2].options.signal.aborted, true);
    const afterClose = f.doc.body.textContent;
    pending[2].resolve(
      Response.json({ sources: [{ ...camera, name: 'Late camera' }] }),
    );
    await flush();
    assert.equal(f.doc.body.textContent, afterClose);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('closing during a globe handoff aborts its signal and restores visible recovery focus', async () => {
  const f = fixture(async () => Response.json({ stations: [station] }));
  const recovery = f.doc.createElement('div');
  recovery.className = 'du-recovery-actions';
  const visible = f.doc.createElement('button');
  recovery.append(visible);
  f.doc.body.append(recovery);
  visible.focus();
  let handoffSignal;
  let resolveHandoff;
  const feeds = installLiveFeeds({
    openOnGlobe(_kind, _item, { signal }) {
      handoffSignal = signal;
      return new Promise((resolve) => {
        resolveHandoff = resolve;
      });
    },
  });
  try {
    feeds.open('radio', f.doc.createElement('button'));
    await flush();
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      find(f.doc, (node) => node.className === 'du-feeds-list'),
    );
    click(find(f.doc, (node) => node.textContent === 'Show on globe'));
    assert.equal(handoffSignal.aborted, false);
    find(f.doc, (node) => node.tagName === 'DIALOG').close();
    assert.equal(handoffSignal.aborted, true);
    assert.equal(f.doc.activeElement, visible);
    resolveHandoff({ opened: true, message: 'Late message' });
    await flush();
    assert.doesNotMatch(f.doc.body.textContent, /Late message/);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('switching away from a camera cancels its strict frame request and ignores late bytes', async () => {
  let frameRequest;
  let resolveFrame;
  const f = fixture((url, options) => {
    if (url === '/api/cctv/sources')
      return Promise.resolve(Response.json({ sources: [camera] }));
    if (url === '/api/radio/stations')
      return Promise.resolve(Response.json({ stations: [station] }));
    frameRequest = { url, signal: options.signal };
    return new Promise((resolve) => {
      resolveFrame = resolve;
    });
  });
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    click(
      find(f.doc, (node) => node.dataset.feedId === camera.id),
      find(f.doc, (node) => node.className === 'du-feeds-list'),
    );
    assert.match(frameRequest.url, /strict=1/);
    assert.equal(frameRequest.signal.aborted, false);
    feeds.open('radio');
    assert.equal(frameRequest.signal.aborted, true);
    resolveFrame(
      new Response(new Uint8Array([255, 216, 255]), {
        headers: {
          'content-type': 'image/jpeg',
          'x-cctv-source': 'upstream-image',
        },
      }),
    );
    await flush();
    assert.doesNotMatch(
      f.doc.body.textContent,
      /Snapshot retrieved|Test camera/,
    );
    assert.equal(f.audio.length, 0);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('startup recovery replaces only the failed globe error panels after preserving diagnostics', () => {
  const f = fixture(async () => Response.json({}));
  try {
    const globe = f.doc.createElement('div');
    globe.id = 'cesiumContainer';
    const nested = f.doc.createElement('div');
    const duplicate = f.doc.createElement('div');
    duplicate.className = 'cesium-widget-errorPanel';
    nested.append(duplicate);
    globe.append(nested);
    const unrelated = f.doc.createElement('div');
    unrelated.className = 'cesium-widget-errorPanel';
    f.doc.body.append(globe, unrelated);
    showStartupFailure(new Error('No recovery target'));
    assert.equal(
      duplicate.isConnected,
      true,
      'no replacement means no removal',
    );

    const loading = f.doc.createElement('div');
    loading.id = 'loading-screen';
    loading.className = 'hidden';
    f.doc.body.append(loading);
    const remove = duplicate.remove.bind(duplicate);
    duplicate.remove = () => {
      assert.match(loading.textContent, /Error details/);
      assert.match(loading.textContent, /WebGL failed/);
      assert.match(loading.textContent, /Graphics context creation rejected/);
      remove();
    };
    showStartupFailure({
      message: 'WebGL failed',
      errors: [new Error('Graphics context creation rejected')],
    });
    assert.equal(duplicate.isConnected, false);
    assert.equal(unrelated.isConnected, true, 'other widgets are untouched');
    assert.equal(globe.isConnected, true, 'the globe host remains intact');
    assert.equal(loading.classList.contains('hidden'), false);
    assert.equal(loading.classList.contains('du-startup-failed'), true);
    assert.equal(f.doc.activeElement.id, 'du-recovery-title');
    assert.deepEqual(
      all(loading)
        .filter((node) => node.dataset.feedKind)
        .map((node) => node.dataset.feedKind),
      ['radio', 'cctv', 'traffic'],
    );
  } finally {
    f.restore();
  }
});

test('a direct feed link returns focus to the matching recovery control after globe startup fails', async () => {
  const f = fixture(async () => Response.json({ sources: [camera] }));
  const loading = f.doc.createElement('div');
  loading.id = 'loading-screen';
  f.doc.body.append(loading);
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    showStartupFailure(new Error('WebGL context creation failed'));
    const recovery = loading.querySelector('[data-feed-kind="cctv"]');
    assert.ok(recovery);
    find(f.doc, (node) => node.tagName === 'DIALOG').close();
    assert.equal(f.doc.activeElement, recovery);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('closing restores an available opener and falls back to the visible header for hidden or missing openers', async () => {
  const f = fixture(async () => Response.json({ stations: [station] }));
  const opener = f.doc.createElement('button');
  const header = f.doc.createElement('button');
  header.id = 'du-open-radio';
  f.doc.body.append(opener, header);
  const feeds = installLiveFeeds();
  try {
    const dialog = find(f.doc, (node) => node.tagName === 'DIALOG');
    feeds.open('radio', opener);
    await flush();
    dialog.close();
    assert.equal(f.doc.activeElement, opener);

    opener.hidden = true;
    feeds.open('radio', opener);
    await flush();
    dialog.close();
    assert.equal(f.doc.activeElement, header);

    f.doc.body.focus();
    feeds.open('radio');
    await flush();
    dialog.close();
    assert.equal(f.doc.activeElement, header);

    opener.hidden = false;
    opener.visibility = 'hidden';
    feeds.open('radio', opener);
    await flush();
    dialog.close();
    assert.equal(f.doc.activeElement, header);
  } finally {
    feeds.destroy();
    f.restore();
  }
});
