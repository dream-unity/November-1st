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
  appendChild(node) {
    this.append(node);
    return node;
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
function cameraFilter(doc, value) {
  const select = find(
    doc,
    (node) => node.getAttribute('aria-label') === 'Camera media type',
  );
  select.value = value;
  select.dispatchEvent(new Event('change'));
  return select;
}
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
    location: globalThis.location,
  };
  const doc = new EventTarget();
  const videos = [];
  doc.createElement = (tag) => {
    const node = new Element(tag, doc);
    if (tag === 'video') {
      Object.assign(node, {
        paused: true,
        canPlayType: () => 'maybe',
        load() {},
        pause() {
          this.paused = true;
          this.dispatchEvent(new Event('pause'));
        },
        play() {
          this.paused = false;
          this.dispatchEvent(new Event('playing'));
          return Promise.resolve();
        },
      });
      videos.push(node);
    }
    return node;
  };
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
  globalThis.location = { search: '' };
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
    videos,
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

for (const [countryCode, countryName, sourceKind] of [
  ['UA', 'Ukraine', 'curated-ukraine'],
  ['AU', 'Australia', 'curated-australia'],
]) {
  test(`${countryName} deep links load the country catalogue and location-free stations still play without a false globe marker`, async () => {
    const calls = [];
    const ukrainian = {
      ...station,
      name: 'Українське радіо',
      lat: null,
      lon: null,
      country: countryName,
      countryCode,
      sourceKind,
    };
    const f = fixture(async (url) => {
      calls.push(url);
      return Response.json({ stations: [ukrainian] });
    });
    globalThis.location.search = `?feed=radio&country=${countryCode}`;
    let globeCalls = 0;
    const feeds = installLiveFeeds({
      openOnGlobe() {
        globeCalls++;
      },
    });
    try {
      feeds.open('radio');
      await flush();
      assert.deepEqual(calls, [`/api/radio/stations?country=${countryCode}`]);
      const country = find(
        f.doc,
        (node) => node.getAttribute('aria-label') === 'Filter by country',
      );
      assert.equal(country.value, countryName);
      const list = find(f.doc, (node) => node.className === 'du-feeds-list');
      click(
        find(f.doc, (node) => node.dataset.feedId === station.id),
        list,
      );
      await flush();
      assert.match(f.doc.body.textContent, /Playing broadcaster audio/);
      assert.match(f.doc.body.textContent, /no verified map location/);
      assert.match(f.doc.body.textContent, /broadcaster’s published source/);
      assert.equal(
        find(f.doc, (node) => node.textContent === 'Globe location unavailable')
          .disabled,
        true,
      );
      assert.equal(globeCalls, 0);
      feeds.destroy();
      assert.equal(f.audio[0].paused, true);
    } finally {
      feeds.destroy();
      f.restore();
    }
  });

  test(`${countryName} remains discoverable when global results omit it and its shortcut retries a failed country request`, async () => {
    const calls = [];
    let uaRequests = 0;
    const ukrainian = {
      ...station,
      id: '22345678-1234-1234-1234-123456789012',
      name: 'Ukraine radio',
      country: countryName,
      countryCode,
    };
    const f = fixture(async (url) => {
      calls.push(url);
      if (url.includes(`?country=${countryCode}`)) {
        uaRequests++;
        return uaRequests === 1
          ? new Response('offline', { status: 503 })
          : Response.json({ stations: [ukrainian] });
      }
      return Response.json({ stations: [station] });
    });
    const feeds = installLiveFeeds();
    try {
      feeds.open('radio');
      await flush();
      const country = find(
        f.doc,
        (node) => node.getAttribute('aria-label') === 'Filter by country',
      );
      assert.ok(country.options.some((option) => option.value === countryName));
      const shortcut = find(
        f.doc,
        (node) => node.textContent === `${countryName} stations`,
      );
      click(shortcut);
      await flush();
      assert.match(f.doc.body.textContent, /HTTP 503/);
      click(shortcut);
      await flush();
      assert.equal(uaRequests, 2);
      assert.ok(find(f.doc, (node) => node.dataset.feedId === ukrainian.id));
      country.value = 'Example';
      country.dispatchEvent(new Event('change'));
      await flush();
      assert.equal(calls.at(-1), '/api/radio/stations');
      assert.ok(find(f.doc, (node) => node.dataset.feedId === station.id));
    } finally {
      feeds.destroy();
      f.restore();
    }
  });
}

test('changing country while a request is pending aborts it and late country results cannot replace the chosen directory', async () => {
  const pending = [];
  const f = fixture(
    (url, options) =>
      new Promise((resolve) => pending.push({ url, options, resolve })),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    pending[0].resolve(Response.json({ stations: [station] }));
    await flush();
    const country = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter by country',
    );
    country.value = 'Ukraine';
    country.dispatchEvent(new Event('change'));
    country.value = '';
    country.dispatchEvent(new Event('change'));
    assert.equal(pending[1].options.signal.aborted, true);
    assert.equal(pending[2].url, '/api/radio/stations');
    pending[2].resolve(Response.json({ stations: [station] }));
    await flush();
    pending[1].resolve(
      Response.json({
        stations: [{ ...station, name: 'Late Ukraine', country: 'Ukraine' }],
      }),
    );
    await flush();
    assert.doesNotMatch(f.doc.body.textContent, /Late Ukraine/);
    assert.ok(find(f.doc, (node) => node.dataset.feedId === station.id));
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('publisher-only cameras remain links, filter by city, and never inflate playable-camera counts', async () => {
  const publisher = {
    id: 'au-publisher-view',
    name: 'River view',
    country: 'AU',
    countryName: 'Australia',
    state: 'South Australia',
    city: 'Adelaide',
    access: 'publisher-only',
    sourcePage:
      'https://www.cityofadelaide.com.au/webcams/river-torrens-and-elder-park/',
    verifiedAt: '2026-09-17T08:48:00Z',
  };
  const f = fixture(async () =>
    Response.json({
      sources: [
        {
          id: 'au-camera',
          name: 'Coastal camera',
          city: 'Busselton',
          country: 'AU',
          countryName: 'Australia',
          lat: -33.64,
          lon: 115.34,
          feedType: 'embed',
          playbackKind: 'live',
          embedUrl: 'https://www.youtube.com/embed/72vmq0Q3ueE',
        },
      ],
      publisherSources: [
        publisher,
        { ...publisher, id: 'unsafe', sourcePage: 'javascript:alert(1)' },
      ],
    }),
  );
  globalThis.location.search = '?feed=cctv&country=AU';
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    const links = find(
      f.doc,
      (node) => node.className === 'du-feed-publisher-links',
    );
    assert.equal(links.hidden, false);
    assert.match(links.textContent, /1 additional camera links/);
    assert.match(
      find(f.doc, (node) => node.className === 'du-feeds-count').textContent,
      /1 matching cameras/,
    );
    const link = all(links).find((node) => node.tagName === 'A');
    assert.equal(link.href, publisher.sourcePage);
    assert.equal(link.target, '_blank');
    assert.match(link.rel, /noopener/);
    const city = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter by city or region',
    );
    assert.ok(city.options.some((option) => option.value === 'Adelaide'));
    city.value = 'Adelaide';
    city.dispatchEvent(new Event('change'));
    assert.equal(links.hidden, false);
    assert.match(
      find(f.doc, (node) => node.className === 'du-feeds-count').textContent,
      /No in-app cameras/,
    );
    assert.equal(
      find(f.doc, (node) => node.dataset.feedId === publisher.id),
      undefined,
    );
    const media = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Camera media type',
    );
    media.value = 'snapshot';
    media.dispatchEvent(new Event('change'));
    assert.equal(links.hidden, true);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('Melbourne deep link requests the city catalogue and country shortcuts leave that scope', async () => {
  const requests = [];
  const f = fixture(async (url) => {
    requests.push(url);
    return Response.json({
      stations: [
        {
          ...station,
          country: 'Australia',
          countryCode: 'AU',
          city: 'Melbourne',
          locality: 'Fitzroy',
          metroArea: 'melbourne',
        },
      ],
    });
  });
  globalThis.location.search = '?feed=radio&country=AU&city=melbourne';
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    await flush();
    assert.deepEqual(requests, [
      '/api/radio/stations?country=AU&city=melbourne',
    ]);
    const area = find(
      f.doc,
      (node) =>
        node.getAttribute('aria-label') === 'Filter by metropolitan area',
    );
    assert.equal(area.value, 'melbourne');
    assert.equal(area.parentElement.hidden, false);
    assert.match(f.doc.body.textContent, /Fitzroy/);
    click(find(f.doc, (node) => node.textContent === 'Australia stations'));
    await flush();
    assert.equal(requests.at(-1), '/api/radio/stations?country=AU');
    assert.equal(area.value, '');
    click(find(f.doc, (node) => node.textContent === 'Ukraine stations'));
    await flush();
    assert.equal(requests.at(-1), '/api/radio/stations?country=UA');
    assert.equal(area.parentElement.hidden, true);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('a delayed Melbourne response cannot replace a later Australia directory selection', async () => {
  const pending = [];
  const f = fixture(
    (url, options) =>
      new Promise((resolve) => pending.push({ url, options, resolve })),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    click(find(f.doc, (node) => node.textContent === 'Melbourne stations'));
    assert.equal(
      pending[1].url,
      '/api/radio/stations?country=AU&city=melbourne',
    );
    click(find(f.doc, (node) => node.textContent === 'Australia stations'));
    assert.equal(pending[2].url, '/api/radio/stations?country=AU');
    assert.equal(pending[1].options.signal.aborted, true);
    pending[2].resolve(
      Response.json({
        stations: [
          {
            ...station,
            name: 'Current Australia',
            country: 'Australia',
            countryCode: 'AU',
          },
        ],
      }),
    );
    await flush();
    pending[1].resolve(
      Response.json({
        stations: [
          {
            ...station,
            name: 'Obsolete Melbourne',
            country: 'Australia',
            countryCode: 'AU',
          },
        ],
      }),
    );
    pending[0].resolve(Response.json({ stations: [] }));
    await flush();
    assert.match(f.doc.body.textContent, /Current Australia/);
    assert.doesNotMatch(f.doc.body.textContent, /Obsolete Melbourne/);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('a failed Melbourne request cannot display retained Australia stations under the city scope', async () => {
  const pending = [];
  const f = fixture(
    (url, options) =>
      new Promise((resolve) => pending.push({ url, options, resolve })),
  );
  globalThis.location.search = '?feed=radio&country=AU';
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    pending[0].resolve(
      Response.json({
        stations: [
          {
            ...station,
            name: 'Sydney broadcaster',
            country: 'Australia',
            countryCode: 'AU',
            state: 'New South Wales',
          },
        ],
      }),
    );
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      list,
    );
    assert.equal(f.audio[0].paused, false);
    click(find(f.doc, (node) => node.textContent === 'Melbourne stations'));
    assert.equal(
      pending[1].url,
      '/api/radio/stations?country=AU&city=melbourne',
    );
    assert.equal(
      list.children.length,
      0,
      'old AU results are hidden while the city loads',
    );
    assert.equal(f.audio[0].paused, true);
    assert.doesNotMatch(
      find(f.doc, (node) => node.className === 'du-feed-detail').textContent,
      /Sydney broadcaster/,
    );
    pending[1].resolve(
      Response.json({ error: 'Unavailable' }, { status: 503 }),
    );
    await flush();
    assert.equal(
      list.children.length,
      0,
      'a failed city request does not relabel old AU results',
    );
    assert.doesNotMatch(f.doc.body.textContent, /Previous directory retained/);
    click(find(f.doc, (node) => node.textContent === 'Australia stations'));
    assert.match(list.textContent, /Sydney broadcaster/);
    click(find(f.doc, (node) => node.textContent === 'Refresh directory'));
    assert.equal(pending[2].url, '/api/radio/stations?country=AU');
    assert.match(
      list.textContent,
      /Sydney broadcaster/,
      'same-scope refresh retains its catalogue',
    );
    pending[2].resolve(
      Response.json({ error: 'Unavailable' }, { status: 503 }),
    );
    await flush();
    assert.match(list.textContent, /Sydney broadcaster/);
    assert.match(f.doc.body.textContent, /Previous directory retained/);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('Melbourne community matches explain the inferred location in the list and player', async () => {
  const f = fixture(async () =>
    Response.json({
      stations: [
        {
          ...station,
          name: 'Melbourne community station',
          country: 'Australia',
          countryCode: 'AU',
          state: 'Victoria',
          sourceKind: 'radio-browser',
          metroMatch: 'community-metadata',
          lat: null,
          lon: null,
        },
      ],
    }),
  );
  globalThis.location.search = '?feed=radio&country=AU&city=melbourne';
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.match(list.textContent, /Melbourne match from community listing/);
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      list,
    );
    const detail = find(f.doc, (node) => node.className === 'du-feed-detail');
    assert.match(detail.textContent, /community listing mentions Melbourne/);
    assert.match(
      detail.textContent,
      /location has not been verified with the broadcaster/,
    );
    assert.match(detail.textContent, /no verified map location/);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('Greater Melbourne includes explicitly reviewed suburbs and separate publisher links without treating all Victoria as Melbourne', async () => {
  const metro = {
    ...camera,
    id: 'suburb-live',
    name: 'Bayside live',
    city: 'Mount Martha',
    country: 'AU',
    countryName: 'Australia',
    state: 'Victoria',
    metroArea: 'melbourne',
    feedType: 'hls',
    playbackKind: 'live',
  };
  const f = fixture(async () =>
    Response.json({
      sources: [
        metro,
        {
          ...metro,
          id: 'regional',
          name: 'Regional camera',
          city: 'Warrnambool',
          metroArea: '',
        },
        { ...metro, id: 'still', feedType: 'image', playbackKind: 'snapshot' },
      ],
      publisherSources: [
        {
          id: 'metro-publisher',
          name: 'Melbourne publisher',
          city: 'South Yarra',
          country: 'AU',
          state: 'Victoria',
          metroArea: 'melbourne',
          access: 'publisher-only',
          sourcePage: 'https://camera.example/live',
          verifiedAt: '2026-09-17T00:00:00Z',
        },
      ],
    }),
  );
  globalThis.location.search = '?feed=cctv&country=AU&city=melbourne';
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].children[0].dataset.feedId, metro.id);
    const links = find(
      f.doc,
      (node) => node.className === 'du-feed-publisher-links',
    );
    assert.equal(links.hidden, false);
    assert.match(links.textContent, /1 additional camera links/);
    const city = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter by city or region',
    );
    assert.ok(city.options.some((option) => option.value === 'Mount Martha'));
    assert.ok(city.options.some((option) => option.value === 'South Yarra'));
    assert.ok(!city.options.some((option) => option.value === 'Warrnambool'));
    cameraFilter(f.doc, 'snapshot');
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].children[0].dataset.feedId, 'still');
    assert.equal(links.hidden, true);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('a refreshed directory retires changed station URLs so retry cannot replay stale broadcaster addresses', async () => {
  let refreshed = false;
  const f = fixture(async () =>
    Response.json({
      stations: [
        {
          ...station,
          streamUrl: refreshed
            ? 'https://radio.example/new'
            : station.streamUrl,
        },
      ],
    }),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      list,
    );
    await flush();
    refreshed = true;
    click(find(f.doc, (node) => node.textContent === 'Refresh directory'));
    await flush();
    assert.equal(f.audio[0].paused, true);
    assert.equal(f.audio[0].src, '');
    assert.match(f.doc.body.textContent, /selected source changed/);
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      list,
    );
    await flush();
    assert.equal(f.audio.at(-1).src, 'https://radio.example/new');
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('the radio player shows the verified CNN stream identity from an older mislabelled directory', async () => {
  const streamUrl = 'https://tunein.cdnstream1.com/2868_96.mp3';
  const f = fixture(async () =>
    Response.json({
      stations: [
        {
          ...station,
          name: 'CNN UK',
          country: 'United Kingdom',
          countryCode: 'GB',
          state: 'London',
          streamUrl,
        },
      ],
    }),
  );
  const feeds = installLiveFeeds({
    openOnGlobe() {
      assert.fail('CNN has no verified map location');
    },
  });
  try {
    feeds.open('radio');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.match(list.textContent, /CNN \(US\).*United States/);
    assert.doesNotMatch(list.textContent, /CNN UK|London|United Kingdom/);
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      list,
    );
    await flush();
    const detail = find(f.doc, (node) => node.className === 'du-feed-detail');
    assert.match(
      detail.textContent,
      /Broadcaster identity and country checked/,
    );
    assert.equal(
      find(f.doc, (node) => node.textContent === 'View station identity source')
        .href,
      'https://tunein.com/cnn/',
    );
    assert.equal(f.audio[0].src, streamUrl);
    assert.equal(
      find(f.doc, (node) => node.textContent === 'Globe location unavailable')
        .disabled,
      true,
    );
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('conflicting radio listings show an unconfirmed country and no country choice while preserving playback', async () => {
  const f = fixture(async () =>
    Response.json({
      stations: [
        { ...station, country: 'United Kingdom', countryCode: 'GB' },
        {
          ...station,
          id: '12345678-1234-1234-1234-123456789013',
          country: 'United States',
          countryCode: 'US',
        },
      ],
    }),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.equal(list.children.length, 1);
    assert.match(list.textContent, /Country unconfirmed/);
    const country = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter by country',
    );
    assert.ok(
      !country.options.some((option) =>
        ['United Kingdom', 'United States'].includes(option.value),
      ),
    );
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      list,
    );
    await flush();
    const detail = find(f.doc, (node) => node.className === 'du-feed-detail');
    assert.match(detail.textContent, /Country unconfirmed/);
    assert.match(detail.textContent, /Directory listings disagree/);
    assert.equal(f.audio[0].src, station.streamUrl);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('a metadata-only station correction replaces stale country details without autoplay or taking refresh focus', async () => {
  let refreshed = false;
  const f = fixture(async () =>
    Response.json({
      stations: [
        {
          ...station,
          // An unrecognised stream exercises a later directory correction; known CNN
          // streams are already corrected at the client boundary on the first load.
          streamUrl: 'https://radio.example/cnn',
          name: refreshed ? 'CNN (US)' : 'CNN UK',
          country: refreshed ? 'United States' : 'United Kingdom',
          countryCode: refreshed ? 'US' : 'GB',
          state: refreshed ? '' : 'London',
        },
      ],
    }),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('radio');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    click(
      find(f.doc, (node) => node.dataset.feedId === station.id),
      list,
    );
    await flush();
    const refresh = find(
      f.doc,
      (node) => node.textContent === 'Refresh directory',
    );
    refresh.focus();
    refreshed = true;
    click(refresh);
    await flush();
    const detail = find(f.doc, (node) => node.className === 'du-feed-detail');
    assert.match(detail.textContent, /CNN \(US\).*United States/);
    assert.doesNotMatch(f.doc.body.textContent, /CNN UK|United Kingdom|London/);
    assert.equal(f.doc.activeElement, refresh);
    assert.equal(f.audio.length, 1, 'a correction must not start a new player');
    assert.equal(f.audio[0].paused, true);
    assert.equal(f.audio[0].src, '');
    assert.match(detail.textContent, /Ready to play/);
    click(find(f.doc, (node) => node.textContent === 'Play / retry'));
    await flush();
    assert.equal(f.audio[1].src, 'https://radio.example/cnn');
    click(refresh);
    await flush();
    assert.equal(f.audio.length, 2);
    assert.equal(
      f.audio[1].paused,
      false,
      'unchanged metadata preserves playback',
    );
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('a camera country deep link selects only a supported country and leaves live-only filtering enabled', async () => {
  const f = fixture(async () =>
    Response.json({
      sources: [
        {
          ...camera,
          country: 'UA',
          countryName: 'Ukraine',
          feedType: 'hls',
          playbackKind: 'live',
        },
        {
          ...camera,
          id: 'other-country',
          country: 'GB',
          countryName: 'United Kingdom',
          feedType: 'hls',
          playbackKind: 'live',
        },
      ],
    }),
  );
  globalThis.location.search = '?feed=cctv&country=UA';
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    assert.equal(
      find(
        f.doc,
        (node) =>
          node.getAttribute('aria-label') === 'Filter cameras by country',
      ).value,
      'UA',
    );
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].children[0].dataset.feedId, camera.id);
    assert.equal(
      find(
        f.doc,
        (node) => node.getAttribute('aria-label') === 'Camera media type',
      ).value,
      'live',
    );
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
    cameraFilter(f.doc, 'snapshot');
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
    cameraFilter(f.doc, 'snapshot');
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

test('CCTV starts with declared live video only, exposes snapshot counts, and plays, pauses and cleans up real video elements', async () => {
  const live = {
    ...camera,
    id: 'live',
    name: 'Live road',
    feedType: 'hls',
    playbackKind: 'live',
  };
  const clip = {
    ...camera,
    id: 'clip',
    name: 'Traffic clip',
    feedType: 'mp4',
    playbackKind: 'clip',
  };
  const unknown = {
    ...camera,
    id: 'other',
    name: 'Unconfirmed stream',
    feedType: 'hls',
  };
  const f = fixture(async () =>
    Response.json({ sources: [camera, clip, unknown, live] }),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.equal(list.children.length, 1);
    assert.equal(list.children[0].children[0].dataset.feedId, 'live');
    assert.match(f.doc.body.textContent, /Live video \(1\)/);
    assert.match(f.doc.body.textContent, /Snapshots \(1\)/);
    assert.match(f.doc.body.textContent, /Clips \/ other videos \(2\)/);
    click(list.children[0].children[0], list);
    const video = f.videos[0];
    await import('hls.js');
    await flush();
    assert.equal(video.src, '/api/cctv/media/live');
    assert.equal(video.controls, true);
    assert.equal(video.muted, true);
    assert.equal(video.loop, false);
    assert.doesNotMatch(f.doc.body.textContent, /Playing continuous camera/);
    video.dispatchEvent(new Event('canplay'));
    await flush();
    assert.match(f.doc.body.textContent, /Playing continuous camera video/);
    click(find(f.doc, (node) => node.textContent === 'Pause video'));
    assert.equal(video.paused, true);
    assert.match(f.doc.body.textContent, /Camera video is paused/);
    video.dispatchEvent(new Event('canplay'));
    assert.equal(
      video.paused,
      true,
      'buffer completion cannot override user pause',
    );
    click(find(f.doc, (node) => node.textContent === 'Play video'));
    await flush();
    assert.equal(video.paused, false);
    f.doc.hidden = true;
    f.doc.dispatchEvent(new Event('visibilitychange'));
    assert.equal(video.paused, true);
    f.doc.hidden = false;
    f.doc.dispatchEvent(new Event('visibilitychange'));
    await flush();
    assert.equal(video.paused, false);
    feeds.open('radio');
    assert.equal(video.paused, true);
    assert.equal(video.src, '');
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('snapshot and other-video filters never silently pretend images or unknown HLS are live', async () => {
  const f = fixture(async () =>
    Response.json({
      sources: [camera, { ...camera, id: 'clip', feedType: 'mp4' }],
    }),
  );
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.equal(list.children.length, 0);
    assert.match(
      f.doc.body.textContent,
      /No in-app cameras match this media type/,
    );
    cameraFilter(f.doc, 'snapshot');
    assert.equal(list.children.length, 1);
    cameraFilter(f.doc, 'video');
    assert.equal(list.children.length, 1);
    assert.match(list.textContent, /Video \(live status unknown\)/);
    cameraFilter(f.doc, 'all');
    assert.equal(list.children.length, 2);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('CCTV country choices expose listed-live counts and compose with city, search and media filters', async () => {
  const sources = [
    {
      ...camera,
      id: 'au-live',
      city: 'Richmond',
      country: 'AU',
      countryName: 'Australia',
      feedType: 'hls',
      playbackKind: 'live',
    },
    {
      ...camera,
      id: 'au-still',
      city: 'Melbourne',
      country: 'AU',
      countryName: 'Australia',
    },
    {
      ...camera,
      id: 'gb-live',
      city: 'London',
      country: 'GB',
      countryName: 'United Kingdom',
      feedType: 'hls',
      playbackKind: 'live',
    },
    camera,
  ];
  const f = fixture(async () => Response.json({ sources }));
  const feeds = installLiveFeeds();
  const change = (node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('change'));
  };
  try {
    feeds.open('cctv');
    await flush();
    const country = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter cameras by country',
    );
    const region = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter by city or region',
    );
    const search = find(f.doc, (node) => node.type === 'search');
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.ok(country);
    assert.deepEqual(
      country.options.map((option) => option.value),
      ['', 'AU', 'GB', '__unknown__'],
    );
    assert.match(country.textContent, /Australia — 1 listed live \/ 2 cameras/);
    assert.match(
      country.textContent,
      /Unknown country — 0 listed live \/ 1 cameras/,
    );
    change(country, 'AU');
    assert.deepEqual(
      region.options.map((option) => option.value),
      ['', 'Melbourne', 'Richmond'],
    );
    assert.equal(list.children.length, 1);
    assert.match(list.textContent, /Australia/);
    assert.match(f.doc.body.textContent, /Snapshots \(1\)/);
    change(region, 'Melbourne');
    assert.equal(list.children.length, 0);
    cameraFilter(f.doc, 'snapshot');
    assert.equal(list.children[0].children[0].dataset.feedId, 'au-still');
    change(country, 'GB');
    assert.equal(
      region.value,
      '',
      'a city outside the chosen country is cleared',
    );
    assert.deepEqual(
      region.options.map((option) => option.value),
      ['', 'London'],
    );
    assert.equal(
      list.children.length,
      0,
      'media choice remains selected across countries',
    );
    cameraFilter(f.doc, 'live');
    search.value = 'United Kingdom';
    search.dispatchEvent(new Event('input'));
    assert.equal(list.children[0].children[0].dataset.feedId, 'gb-live');
    search.value = 'Australia';
    search.dispatchEvent(new Event('input'));
    assert.equal(list.children.length, 0);
    assert.match(f.doc.body.textContent, /Live video \(0\)/);
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('CCTV directory refresh clears vanished country and city choices instead of trapping results in an empty filter', async () => {
  let sources = [
    {
      ...camera,
      country: 'AU',
      countryName: 'Australia',
      city: 'Melbourne',
      feedType: 'hls',
      playbackKind: 'live',
    },
  ];
  const f = fixture(async () => Response.json({ sources }));
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    const country = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter cameras by country',
    );
    country.value = 'AU';
    country.dispatchEvent(new Event('change'));
    const region = find(
      f.doc,
      (node) => node.getAttribute('aria-label') === 'Filter by city or region',
    );
    region.value = 'Melbourne';
    region.dispatchEvent(new Event('change'));
    sources = [
      {
        ...camera,
        id: 'replacement',
        country: 'GB',
        countryName: 'United Kingdom',
        city: 'London',
        feedType: 'hls',
        playbackKind: 'live',
      },
    ];
    click(find(f.doc, (node) => node.textContent === 'Refresh directory'));
    await flush();
    assert.equal(country.value, '');
    assert.equal(region.value, '');
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.equal(list.children[0].children[0].dataset.feedId, 'replacement');
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('official camera embeds need player playback events and retain provider links when embedding fails', async () => {
  const embed = {
    ...camera,
    id: 'official-japan',
    name: 'Official city camera',
    country: 'JP',
    countryName: 'Japan',
    feedType: 'embed',
    playbackKind: 'live',
    embedUrl: 'https://www.youtube-nocookie.com/embed/5iDycGQWPCg',
    sourcePage: 'https://camera.example/japan',
  };
  const requests = [];
  const f = fixture(async (url) => {
    const path = new URL(url, 'https://app.example').pathname;
    requests.push(path);
    if (path.startsWith('/api/cctv/embed-status/'))
      return Response.json({
        status: 'live',
        checkedAt: new Date().toISOString(),
      });
    return Response.json({ sources: [embed] });
  });
  let events;
  let player;
  f.doc.defaultView = {
    location: { origin: 'https://app.example' },
    YT: {
      Player: class {
        constructor(iframe, options) {
          events = options.events;
          this.iframe = iframe;
          player = this;
        }
        mute() {
          this.muted = true;
        }
        playVideo() {
          this.playRequested = true;
        }
        destroy() {
          this.destroyed = true;
          this.iframe.remove();
        }
      },
    },
  };
  const feeds = installLiveFeeds();
  try {
    feeds.open('cctv');
    await flush();
    const list = find(f.doc, (node) => node.className === 'du-feeds-list');
    assert.equal(list.children[0].children[0].dataset.feedId, embed.id);
    click(list.children[0].children[0], list);
    await flush();
    assert.ok(find(f.doc, (node) => node.tagName === 'IFRAME'));
    assert.match(f.doc.body.textContent, /Official provider player/);
    assert.doesNotMatch(f.doc.body.textContent, /Camera video is playing/);
    events.onReady({ target: player });
    assert.equal(player.muted, true);
    assert.equal(player.playRequested, true);
    assert.doesNotMatch(f.doc.body.textContent, /Camera video is playing/);
    events.onStateChange({ data: 1 });
    assert.match(f.doc.body.textContent, /Camera video is playing/);
    events.onError({ data: 150 });
    assert.match(f.doc.body.textContent, /does not allow embedded playback/);
    assert.equal(player.destroyed, true);
    assert.equal(
      find(f.doc, (node) => node.tagName === 'IFRAME'),
      undefined,
    );
    assert.equal(
      find(f.doc, (node) => node.tagName === 'IMG'),
      undefined,
    );
    assert.deepEqual(
      requests,
      ['/api/cctv/sources', '/api/cctv/embed-status/official-japan'],
      'embeds never fall back to snapshot requests',
    );
    const link = find(
      f.doc,
      (node) => node.textContent === 'Visit camera provider',
    );
    assert.equal(link.href, embed.sourcePage);
    assert.equal(link.rel, 'noopener noreferrer');
  } finally {
    feeds.destroy();
    f.restore();
  }
});

test('ended broadcasts never start an archive and strict live-only cameras refuse unconfirmed playback', async () => {
  for (const [checkedStatus, liveOnly] of [
    ['ended', false],
    ['unknown', false],
    ['unknown', true],
  ]) {
    const embed = {
      ...camera,
      id: 'checked-embed',
      feedType: 'embed',
      playbackKind: 'live',
      liveOnly,
      embedUrl: 'https://www.youtube-nocookie.com/embed/5iDycGQWPCg',
      sourcePage: 'https://camera.example/public',
    };
    const f = fixture(async (url) =>
      Response.json(
        new URL(url, 'https://app.example').pathname.startsWith(
          '/api/cctv/embed-status/',
        )
          ? { status: checkedStatus, checkedAt: new Date().toISOString() }
          : { sources: [embed] },
      ),
    );
    let events;
    let player;
    f.doc.defaultView = {
      location: { origin: 'https://app.example' },
      YT: {
        Player: class {
          constructor(iframe, options) {
            this.iframe = iframe;
            events = options.events;
            player = this;
          }
          mute() {}
          playVideo() {}
          destroy() {
            this.iframe.remove();
          }
        },
      },
    };
    const feeds = installLiveFeeds();
    try {
      feeds.open('cctv');
      await flush();
      const list = find(f.doc, (node) => node.className === 'du-feeds-list');
      click(list.children[0].children[0], list);
      await flush();
      const label = find(
        f.doc,
        (node) => node.className === 'du-feed-media-kind',
      );
      if (checkedStatus === 'ended' || liveOnly) {
        assert.equal(Boolean(player), false);
        assert.equal(
          find(f.doc, (node) => node.tagName === 'IFRAME'),
          undefined,
        );
        assert.match(
          label.textContent,
          checkedStatus === 'ended'
            ? /Broadcast ended/
            : /Live status unconfirmed/,
        );
      } else {
        assert.ok(player);
        events.onReady({ target: player });
        events.onStateChange({ data: 1 });
        assert.match(label.textContent, /Live status unconfirmed/);
        assert.match(f.doc.body.textContent, /live status unconfirmed/);
      }
      assert.ok(
        find(f.doc, (node) => node.textContent === 'Visit camera provider'),
      );
    } finally {
      feeds.destroy();
      f.restore();
    }
  }
});
