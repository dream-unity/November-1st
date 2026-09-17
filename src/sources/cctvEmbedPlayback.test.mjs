import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCctvEmbedPlayback,
  loadCctvYouTubeApi,
} from './cctvEmbedPlayback.js';
import { normalizeCctvEmbedUrl } from './cctvTypes.js';

class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.attributes = {};
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentNode)
      this.parentNode.children = this.parentNode.children.filter(
        (node) => node !== this,
      );
    this.parentNode = null;
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

class Document extends EventTarget {
  hidden = false;
  constructor() {
    super();
    this.head = new Element('head', this);
    this.body = new Element('body', this);
    this.defaultView = { location: { origin: 'https://camera.example' } };
  }
  createElement(tag) {
    return new Element(tag, this);
  }
  hide(hidden) {
    this.hidden = hidden;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

async function flush() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = options.document || new Document();
  const container = document.createElement('div');
  const players = [];
  class Player {
    plays = 0;
    muted = false;
    destroyed = false;
    constructor(iframe, options) {
      this.iframe = iframe;
      this.events = options.events;
      players.push(this);
    }
    playVideo() {
      this.plays++;
    }
    mute() {
      this.muted = true;
    }
    destroy() {
      this.destroyed = true;
      this.iframe.remove();
    }
    emit(name, data) {
      this.events[name]?.({ target: this, data });
    }
  }
  const statuses = [];
  const playback = createCctvEmbedPlayback({
    container,
    embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk',
    title: 'Harbour camera',
    playbackKind: 'live',
    timeoutMs: 100,
    loadApi: async () => ({ Player }),
    onStatus: (value) => statuses.push(value),
    ...options,
  });
  t.after(() => playback.destroy());
  return {
    document,
    container,
    players,
    statuses,
    playback,
    Player,
    status: () => statuses.at(-1),
  };
}

const ipcamEmbed =
  'https://g3.ipcamlive.com/player/player.php?alias=69421e5731fe2';
const ipcamStatusUrl = '/api/cctv/embed-status/au-zen-sunrise';
const currentIpcamStatus = () =>
  new Response(
    JSON.stringify({
      status: 'live',
      checkedAt: '2026-09-17T08:50:00.000Z',
    }),
  );

test('only exact reviewed IPCamLive player identities normalize, including safe owner controls', () => {
  assert.equal(
    normalizeCctvEmbedUrl(`${ipcamEmbed}&autoplay=1&mute=1&disableuserpause=1`),
    ipcamEmbed,
  );
  for (const url of [
    ipcamEmbed.replace('g3.', 'g9.'),
    ipcamEmbed.replace('https:', 'http:'),
    ipcamEmbed.replace('69421e5731fe2', 'unreviewed'),
    ipcamEmbed.replace('/player/player.php', '/player/snapshot.php'),
    `${ipcamEmbed}&alias=69421e4b4c166`,
    `${ipcamEmbed}&token=private`,
    `${ipcamEmbed}&autoplay=anything`,
    `${ipcamEmbed}#fragment`,
    ipcamEmbed.replace('g3.ipcamlive.com', 'g3.ipcamlive.com.evil.example'),
  ])
    assert.equal(normalizeCctvEmbedUrl(url), '', url);
});

test('IPCamLive loads only after live proof and never treats iframe load as video playback', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    embedUrl: ipcamEmbed,
    statusUrl: ipcamStatusUrl,
    fetchImpl: async () => {
      checks++;
      return currentIpcamStatus();
    },
  });
  await flush();
  assert.equal(checks, 1);
  assert.equal(f.players.length, 0, 'YouTube API must not be used');
  const frame = f.container.children[0];
  assert.ok(frame);
  const url = new URL(frame.src);
  assert.equal(url.searchParams.get('disabletimelapseplayer'), '1');
  assert.equal(url.searchParams.get('disablestorageplayer'), '1');
  assert.equal(url.searchParams.get('mute'), '1');
  frame.dispatchEvent(new Event('load'));
  assert.equal(f.status().status, 'ready');
  assert.equal(f.status().reason, 'provider-controls');
  assert.equal(
    f.statuses.some((x) => x.status === 'playing'),
    false,
  );
  assert.match(f.status().message, /Playback status is shown inside/);
  f.playback.pause();
  assert.equal(f.container.children.length, 0);
  assert.equal(f.status().status, 'paused');
  t.mock.timers.tick(120_000);
  await flush();
  assert.equal(checks, 1, 'paused player must not poll');
});

test('IPCamLive requires current live proof even if caller omits strict flag', async (t) => {
  const f = fixture(t, {
    embedUrl: ipcamEmbed,
    statusUrl: ipcamStatusUrl,
    fetchImpl: async () => new Response(JSON.stringify({ status: 'unknown' })),
  });
  await flush();
  assert.equal(f.container.children.length, 0);
  assert.equal(f.status().status, 'unavailable');
});

test('IPCamLive respects manual playback and checks again on explicit Play', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    embedUrl: ipcamEmbed,
    statusUrl: ipcamStatusUrl,
    autoPlay: false,
    fetchImpl: async () => {
      checks++;
      return currentIpcamStatus();
    },
  });
  await flush();
  assert.equal(
    new URL(f.container.children[0].src).searchParams.get('autoplay'),
    '0',
  );
  f.playback.play();
  await flush();
  assert.equal(checks, 2);
  assert.equal(f.container.children.length, 1);
  assert.equal(
    new URL(f.container.children[0].src).searchParams.get('autoplay'),
    '1',
  );
});

test('IPCamLive periodically rechecks live status and unloads a stopped publisher stream', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    embedUrl: ipcamEmbed,
    statusUrl: ipcamStatusUrl,
    statusRecheckMs: 1000,
    fetchImpl: async () =>
      ++checks === 1
        ? currentIpcamStatus()
        : new Response(
            JSON.stringify({
              status: 'unavailable',
              checkedAt: '2026-09-17T08:51:00.000Z',
              message: 'Publisher reports offline.',
            }),
          ),
  });
  await flush();
  f.container.children[0].dispatchEvent(new Event('load'));
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(checks, 2);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.status().status, 'unavailable');
  assert.equal(f.status().liveStatus, 'unavailable');
});

test('IPCamLive hidden views abort a pending recheck and never recreate a late player', async (t) => {
  let checks = 0;
  let pendingSignal;
  let resolve;
  const f = fixture(t, {
    embedUrl: ipcamEmbed,
    statusUrl: ipcamStatusUrl,
    statusRecheckMs: 1000,
    fetchImpl: async (_url, init) => {
      checks++;
      if (checks === 1) return currentIpcamStatus();
      pendingSignal = init.signal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  await flush();
  f.container.children[0].dispatchEvent(new Event('load'));
  t.mock.timers.tick(1000);
  await flush();
  f.document.hide(true);
  assert.equal(pendingSignal.aborted, true);
  assert.equal(f.container.children.length, 0);
  resolve(currentIpcamStatus());
  await flush();
  assert.equal(f.status().status, 'suspended');
  assert.equal(f.container.children.length, 0);
  t.mock.timers.tick(120_000);
  assert.equal(checks, 2);
});

test('approved embeds preserve publisher controls, origin and referrer identity without a loop', async (t) => {
  const f = fixture(t);
  await flush();
  const iframe = f.container.children[0];
  const url = new URL(iframe.src);
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, '/embed/abcdefghijk');
  assert.equal(url.searchParams.get('origin'), 'https://camera.example');
  assert.equal(url.searchParams.get('enablejsapi'), '1');
  assert.equal(url.searchParams.get('playsinline'), '1');
  assert.equal(url.searchParams.get('controls'), '1');
  assert.equal(url.searchParams.get('autoplay'), '0');
  assert.equal(url.searchParams.get('loop'), '0');
  assert.equal(iframe.referrerPolicy, 'strict-origin-when-cross-origin');
  assert.match(iframe.allow, /autoplay/);
  assert.equal(iframe.title, 'Harbour camera');
});

test('iframe load and player readiness never claim video playback; PLAYING does', async (t) => {
  const f = fixture(t);
  await flush();
  const p = f.players[0];
  f.container.children[0].dispatchEvent(new Event('load'));
  assert.equal(f.status().status, 'loading');
  p.emit('onReady');
  assert.equal(f.status().status, 'ready');
  assert.equal(p.muted, true);
  assert.equal(p.plays, 1);
  p.emit('onStateChange', 1);
  assert.equal(f.status().status, 'playing');
  t.mock.timers.tick(500);
  assert.equal(f.status().status, 'playing');
});

test('manual native playback and pauses update intent without autoplaying an idle player', async (t) => {
  const f = fixture(t, { autoPlay: false });
  await flush();
  const p = f.players[0];
  p.emit('onReady');
  p.emit('onStateChange', 5);
  t.mock.timers.tick(500);
  assert.equal(p.plays, 0);
  assert.equal(f.status().status, 'ready');
  p.emit('onStateChange', 1);
  assert.equal(f.status().status, 'playing');
  p.emit('onStateChange', 2);
  assert.equal(f.status().status, 'paused');
  f.document.hide(true);
  f.document.hide(false);
  await flush();
  assert.equal(f.players.length, 1);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.status().status, 'paused');
});

test('autoplay blocking leaves native controls and an explicit user retry', async (t) => {
  const f = fixture(t);
  await flush();
  const p = f.players[0];
  p.emit('onReady');
  p.emit('onAutoplayBlocked');
  assert.equal(f.status().status, 'blocked');
  assert.equal(f.status().reason, 'autoplay-blocked');
  assert.equal(f.container.children.length, 1);
  t.mock.timers.tick(500);
  assert.equal(f.status().status, 'blocked');
  f.playback.play();
  assert.equal(p.plays, 2);
  p.emit('onStateChange', 1);
  assert.equal(f.status().status, 'playing');
});

test('explicit pause destroys media, stale callbacks cannot restart it, and Play creates a fresh player', async (t) => {
  const f = fixture(t);
  await flush();
  const first = f.players[0];
  first.emit('onReady');
  first.emit('onStateChange', 1);
  f.playback.pause();
  assert.equal(first.destroyed, true);
  assert.equal(f.container.children.length, 0);
  first.emit('onStateChange', 1);
  first.emit('onError', 100);
  first.emit('onReady');
  assert.equal(f.status().status, 'paused');
  f.playback.play();
  await flush();
  assert.equal(f.players.length, 2);
  f.players[1].emit('onReady');
  assert.equal(f.players[1].plays, 1);
});

test('hidden view destroys its iframe and resumes only prior playing intent', async (t) => {
  const f = fixture(t);
  await flush();
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  f.document.hide(true);
  assert.equal(f.status().status, 'suspended');
  assert.equal(f.container.children.length, 0);
  assert.equal(f.players[0].destroyed, true);
  assert.equal(f.playback.play(), false);
  f.document.hide(false);
  await flush();
  assert.equal(f.players.length, 2);
  f.players[1].emit('onReady');
  assert.equal(f.players[1].plays, 1);
  f.playback.setActive(false);
  f.document.hide(true);
  f.document.hide(false);
  await flush();
  assert.equal(f.players.length, 2);
  assert.equal(f.container.children.length, 0);
});

test('an initially hidden panel never requests the API until activated', async (t) => {
  let calls = 0;
  const f = fixture(t, {
    initiallyActive: false,
    loadApi: async () => {
      calls++;
      return { Player: f.Player };
    },
  });
  await flush();
  assert.equal(calls, 0);
  f.playback.setActive(true);
  await flush();
  assert.equal(calls, 1);
  assert.equal(f.players.length, 1);
});

test('an API resolving after close cannot attach an iframe or emit further status', async (t) => {
  let resolve;
  const f = fixture(t, {
    loadApi: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  await flush();
  f.playback.destroy();
  const count = f.statuses.length;
  resolve({ Player: f.Player });
  await flush();
  f.document.hide(true);
  f.document.hide(false);
  assert.equal(f.container.children.length, 0);
  assert.equal(f.players.length, 0);
  assert.equal(f.statuses.length, count);
  assert.equal(f.playback.retry(), false);
});

test('closing before the queued API request prevents even the script download', async (t) => {
  let calls = 0;
  const f = fixture(t, {
    loadApi: async () => {
      calls++;
      return { Player: f.Player };
    },
  });
  f.playback.destroy();
  await flush();
  assert.equal(calls, 0);
  assert.equal(f.container.children.length, 0);
});

test('load timeout invalidates a late API response and retry can succeed', async (t) => {
  let resolve;
  let calls = 0;
  const f = fixture(t, {
    loadApi: () =>
      ++calls === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : Promise.resolve({ Player: f.Player }),
  });
  await flush();
  t.mock.timers.tick(100);
  assert.equal(f.status().status, 'unavailable');
  assert.equal(f.status().reason, 'player-load-timeout');
  resolve({ Player: f.Player });
  await flush();
  assert.equal(f.players.length, 0);
  assert.equal(f.playback.retry(), true);
  await flush();
  assert.equal(f.players.length, 1);
});

test('repeated buffering events cannot extend the deadline indefinitely', async (t) => {
  const f = fixture(t);
  await flush();
  const p = f.players[0];
  p.emit('onReady');
  p.emit('onStateChange', 1);
  p.emit('onStateChange', 3);
  t.mock.timers.tick(90);
  p.emit('onStateChange', 3);
  t.mock.timers.tick(10);
  assert.equal(f.status().status, 'unavailable');
  assert.equal(f.status().reason, 'buffer-timeout');
  assert.equal(p.destroyed, true);
});

test('ready players that never begin playback have a finite deadline', async (t) => {
  const f = fixture(t);
  await flush();
  f.players[0].emit('onReady');
  t.mock.timers.tick(100);
  assert.equal(f.status().reason, 'play-start-timeout');
  assert.equal(f.container.children.length, 0);
});

for (const kind of ['live', 'clip']) {
  test(`${kind} broadcasts end honestly and never automatically loop`, async (t) => {
    const f = fixture(t, { playbackKind: kind });
    await flush();
    const p = f.players[0];
    p.emit('onReady');
    p.emit('onStateChange', 1);
    p.emit('onStateChange', 0);
    assert.equal(f.container.children.length, 0);
    assert.equal(p.destroyed, true);
    p.emit('onStateChange', 1);
    t.mock.timers.tick(1000);
    assert.equal(f.status().status, 'ended');
    assert.equal(p.plays, 1);
    f.document.hide(true);
    f.document.hide(false);
    await flush();
    assert.equal(f.players.length, 1);
  });
}

for (const [code, message] of [
  [2, /invalid/],
  [5, /browser/],
  [100, /removed or made private/],
  [101, /does not allow embedded/],
  [150, /does not allow embedded/],
  [153, /referrer/],
  [999, /could not play/],
]) {
  test(`provider error ${code} is actionable and terminates the media session`, async (t) => {
    const f = fixture(t);
    await flush();
    f.players[0].emit('onError', code);
    assert.equal(f.status().status, 'unavailable');
    assert.equal(f.status().reason, `youtube-${code}`);
    assert.match(f.status().message, message);
    assert.equal(f.players[0].destroyed, true);
    assert.equal(f.container.children.length, 0);
  });
}

for (const embedUrl of [
  'http://www.youtube-nocookie.com/embed/abcdefghijk',
  'https://www.youtube-nocookie.com.evil.example/embed/abcdefghijk',
  'https://evil.example/embed/abcdefghijk',
  'https://user:pass@www.youtube-nocookie.com/embed/abcdefghijk',
  'https://www.youtube-nocookie.com:444/embed/abcdefghijk',
  'https://www.youtube-nocookie.com/embed/abcdefghijk?autoplay=1',
  'https://www.youtube-nocookie.com/embed/abcdefghijk#fragment',
  'https://www.youtube-nocookie.com/embed/too-short',
  'https://www.youtube-nocookie.com/embed/%61bcdefghijk',
  'javascript:alert(1)',
]) {
  test(`reject unapproved embed before any API request: ${embedUrl}`, async (t) => {
    let loads = 0;
    const f = fixture(t, {
      embedUrl,
      loadApi: () => {
        loads++;
      },
    });
    await flush();
    assert.equal(f.status().reason, 'invalid-embed');
    assert.equal(f.container.children.length, 0);
    assert.equal(loads, 0);
  });
}

test('opaque page origins fail before contacting the video provider', async (t) => {
  const document = new Document();
  document.defaultView.location.origin = 'null';
  const f = fixture(t, { document });
  await flush();
  assert.equal(f.status().reason, 'invalid-embed');
  assert.equal(f.players.length, 0);
});

test('concurrent API consumers share one official script and preserve an existing ready callback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Document();
  const window = document.defaultView;
  let readyCount = 0;
  const previousReady = () => {
    readyCount++;
  };
  window.onYouTubeIframeAPIReady = previousReady;
  const first = loadCctvYouTubeApi(document, window, 100);
  const second = loadCctvYouTubeApi(document, window, 100);
  assert.equal(first, second);
  assert.equal(document.head.children.length, 1);
  assert.equal(
    document.head.children[0].src,
    'https://www.youtube.com/iframe_api',
  );
  window.YT = { Player: class {} };
  window.onYouTubeIframeAPIReady();
  assert.equal(await first, window.YT);
  assert.equal(await second, window.YT);
  assert.equal(readyCount, 1);
  assert.equal(window.onYouTubeIframeAPIReady, previousReady);
  assert.equal(await loadCctvYouTubeApi(document, window, 100), window.YT);
  assert.equal(document.head.children.length, 1);
});

test('failed API scripts are removed and a subsequent attempt can load successfully', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Document();
  const window = document.defaultView;
  const first = loadCctvYouTubeApi(document, window, 100);
  const rejected = assert.rejects(first, /could not load/);
  document.head.children[0].onerror();
  await rejected;
  await flush();
  assert.equal(document.head.children.length, 0);
  const second = loadCctvYouTubeApi(document, window, 100);
  window.YT = { Player: class {} };
  window.onYouTubeIframeAPIReady();
  assert.equal(await second, window.YT);
});

test('an unrelated failing API-ready subscriber cannot crash this player loader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Document();
  const window = document.defaultView;
  window.onYouTubeIframeAPIReady = () => {
    throw new Error('Other player failed');
  };
  const loaded = loadCctvYouTubeApi(document, window, 100);
  window.YT = { Player: class {} };
  assert.doesNotThrow(() => window.onYouTubeIframeAPIReady());
  assert.equal(await loaded, window.YT);
});

test('API downloads have a bounded timeout and do not leave scripts attached', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const document = new Document();
  const first = loadCctvYouTubeApi(document, document.defaultView, 100);
  const rejected = assert.rejects(first, /timed out/);
  t.mock.timers.tick(100);
  await rejected;
  assert.equal(document.head.children.length, 0);
});

test('selected broadcast preflight checks the same-origin endpoint before creating any player', async (t) => {
  let request;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        status: 'live',
        checkedAt: new Date().toISOString(),
        message: 'Publisher says live.',
      });
    },
  });
  await flush();
  assert.equal(
    request.url,
    'https://camera.example/api/cctv/embed-status/camera-one',
  );
  assert.equal(request.options.redirect, 'error');
  assert.equal(f.players.length, 1);
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  assert.equal(f.status().liveStatus, 'live');
  assert.equal(f.status().message, 'Camera video is playing.');
});

for (const status of ['ended', 'unavailable']) {
  test(`${status} preflight refuses archived or forbidden playback before requesting the player API`, async (t) => {
    let apiLoads = 0;
    const f = fixture(t, {
      statusUrl: '/api/cctv/embed-status/camera-one',
      fetchImpl: async () =>
        Response.json({ status, message: 'Publisher status message.' }),
      loadApi: async () => {
        apiLoads++;
        return { Player: f.Player };
      },
    });
    await flush();
    assert.equal(f.status().status, status);
    assert.equal(f.status().liveStatus, status);
    assert.equal(f.status().message, 'Publisher status message.');
    assert.equal(f.players.length, 0);
    assert.equal(apiLoads, 0);
    assert.equal(f.container.children.length, 0);
  });
}

test('unknown preflight permits publisher playback without presenting it as verified live', async (t) => {
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    fetchImpl: async () => Response.json({ status: 'unknown' }),
  });
  await flush();
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  assert.equal(f.status().liveStatus, 'unknown');
  assert.match(f.status().message, /live status unconfirmed/);
});

test('an ended live broadcast requires a fresh preflight before replay and refuses an archive', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    fetchImpl: async () =>
      Response.json({
        status: ++checks === 1 ? 'live' : 'ended',
        message: 'Broadcast has ended.',
      }),
  });
  await flush();
  const first = f.players[0];
  first.emit('onReady');
  first.emit('onStateChange', 1);
  first.emit('onStateChange', 0);
  first.emit('onStateChange', 1);
  assert.equal(f.status().status, 'ended');
  assert.equal(f.container.children.length, 0);
  f.playback.play();
  await flush();
  assert.equal(checks, 2);
  assert.equal(f.status().status, 'ended');
  assert.equal(f.players.length, 1);
});

for (const [name, retryProof] of [
  ['cached live', { status: 'live', checkedAt: '2020-01-01T00:00:00.000Z' }],
  ['older live', { status: 'live', checkedAt: '2019-01-01T00:00:00.000Z' }],
  ['untimestamped live', { status: 'live' }],
  [
    'fresh unknown',
    { status: 'unknown', checkedAt: '2020-01-01T00:01:00.000Z' },
  ],
]) {
  test(`${name} proof cannot reopen an observed-ended broadcast`, async (t) => {
    let checks = 0;
    const f = fixture(t, {
      statusUrl: '/api/cctv/embed-status/camera-one',
      fetchImpl: async () =>
        Response.json(
          ++checks === 1
            ? { status: 'live', checkedAt: '2020-01-01T00:00:00.000Z' }
            : retryProof,
        ),
    });
    await flush();
    f.players[0].emit('onReady');
    f.players[0].emit('onStateChange', 1);
    f.players[0].emit('onStateChange', 0);
    f.playback.retry();
    await flush();
    assert.equal(checks, 2);
    assert.equal(f.players.length, 1);
    assert.equal(f.container.children.length, 0);
    assert.equal(f.status().status, 'ended');
    assert.equal(f.status().liveStatus, 'ended');
    assert.equal(f.status().reason, 'broadcast-ended-awaiting-fresh-status');
  });
}

test('a strictly newer server live proof permits reconnection independently of the device clock', async (t) => {
  let checks = 0;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    fetchImpl: async () =>
      Response.json({
        status: 'live',
        checkedAt:
          ++checks === 1
            ? '2020-01-01T00:00:00.000Z'
            : '2020-01-01T00:01:00.000Z',
      }),
  });
  await flush();
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  f.players[0].emit('onStateChange', 0);
  f.playback.retry();
  await flush();
  assert.equal(f.players.length, 2);
  f.players[1].emit('onReady');
  f.players[1].emit('onStateChange', 1);
  assert.equal(f.status().status, 'playing');
  assert.equal(f.status().liveStatus, 'live');
});

test('an untimestamped initial proof needs a post-end baseline and then a newer proof', async (t) => {
  let checks = 0;
  const proofs = [
    { status: 'live' },
    { status: 'live', checkedAt: '2020-01-01T00:00:00.000Z' },
    { status: 'live', checkedAt: '2020-01-01T00:01:00.000Z' },
  ];
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    fetchImpl: async () => Response.json(proofs[checks++]),
  });
  await flush();
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 0);
  f.playback.retry();
  await flush();
  assert.equal(f.players.length, 1);
  assert.equal(f.status().status, 'ended');
  f.playback.retry();
  await flush();
  assert.equal(f.players.length, 2);
});

test('a hidden view aborts preflight and never creates a player after the response arrives', async (t) => {
  let signal;
  let release;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise((done) => {
        release = done;
      });
    },
  });
  await flush();
  f.playback.setActive(false);
  assert.equal(signal.aborted, true);
  release(Response.json({ status: 'live' }));
  await flush();
  assert.equal(f.status().status, 'suspended');
  assert.equal(f.players.length, 0);
});

test('a bounded preflight timeout permits unconfirmed playback with a fresh player-load deadline', async (t) => {
  let signal;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    statusTimeoutMs: 80,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  await flush();
  t.mock.timers.tick(80);
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(f.players.length, 1);
  t.mock.timers.tick(30);
  assert.equal(
    f.status().status,
    'loading',
    'player still has its own 100ms deadline after preflight',
  );
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  assert.match(f.status().message, /live status unconfirmed/);
});

test('cross-origin status URLs never become arbitrary browser fetch targets', async (t) => {
  let fetches = 0;
  const f = fixture(t, {
    statusUrl: 'https://evil.example/api/cctv/embed-status/camera-one',
    fetchImpl: async () => {
      fetches++;
      return Response.json({ status: 'live' });
    },
  });
  await flush();
  assert.equal(fetches, 0);
  assert.equal(f.players.length, 1);
  assert.equal(f.status().liveStatus, 'unknown');
});

test('oversized or malformed preflight bodies remain unknown and cannot mark a broadcast live', async (t) => {
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    fetchImpl: async () =>
      Response.json({ status: 'live', html: 'x'.repeat(9000) }),
  });
  await flush();
  assert.equal(f.players.length, 1);
  assert.equal(f.status().liveStatus, 'unknown');
});

for (const [name, options] of [
  ['missing status endpoint', { statusUrl: undefined }],
  [
    'cross-origin status endpoint',
    { statusUrl: 'https://other.example/api/cctv/embed-status/camera-one' },
  ],
  [
    'unknown status',
    { proof: { status: 'unknown', checkedAt: '2026-09-17T00:00:00.000Z' } },
  ],
  ['untimestamped live status', { proof: { status: 'live' } }],
  [
    'malformed live timestamp',
    { proof: { status: 'live', checkedAt: 'not-a-date' } },
  ],
  [
    'non-string live timestamp',
    { proof: { status: 'live', checkedAt: 1789603200000 } },
  ],
  [
    'unrecognized response',
    { proof: { status: 'available', checkedAt: '2026-09-17T00:00:00.000Z' } },
  ],
]) {
  test(`live-only embed refuses ${name} before loading any official player`, async (t) => {
    let apiLoads = 0;
    let requests = 0;
    const f = fixture(t, {
      statusUrl: '/api/cctv/embed-status/camera-one',
      requireLiveStatus: true,
      fetchImpl: async () => {
        requests++;
        return Response.json(
          options.proof || {
            status: 'live',
            checkedAt: '2026-09-17T00:00:00.000Z',
          },
        );
      },
      loadApi: async () => {
        apiLoads++;
        return { Player: f.Player };
      },
      ...options,
    });
    await flush();
    assert.equal(f.status().status, 'unavailable');
    assert.equal(f.status().reason, 'live-status-unconfirmed');
    assert.equal(f.status().liveStatus, 'unknown');
    assert.match(f.status().message, /Live-only/);
    assert.equal(apiLoads, 0);
    assert.equal(f.players.length, 0);
    assert.equal(f.container.children.length, 0);
    if (name.includes('endpoint')) assert.equal(requests, 0);
    t.mock.timers.tick(500);
    assert.equal(
      f.status().reason,
      'live-status-unconfirmed',
      'preflight refusal clears the player-load deadline',
    );
  });
}

test('live-only embed requires fresh preflight on retry and allows a timestamped live result', async (t) => {
  let requests = 0;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    requireLiveStatus: true,
    fetchImpl: async (_url, options) => {
      assert.equal(options.cache, 'no-store');
      return Response.json(
        ++requests === 1
          ? { status: 'unknown' }
          : { status: 'live', checkedAt: '2026-09-17T00:00:00.000Z' },
      );
    },
  });
  await flush();
  assert.equal(f.status().reason, 'live-status-unconfirmed');
  assert.equal(f.players.length, 0);
  f.playback.retry();
  await flush();
  assert.equal(requests, 2);
  assert.equal(f.players.length, 1);
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  assert.equal(f.status().status, 'playing');
  assert.equal(f.status().liveStatus, 'live');
});

test('live-only embed timeout and HTTP failures cannot fall back to unchecked playback', async (t) => {
  let requests = 0;
  let signal;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    requireLiveStatus: true,
    statusTimeoutMs: 80,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return ++requests === 1
        ? new Promise(() => {})
        : Promise.resolve(new Response(null, { status: 503 }));
    },
  });
  await flush();
  t.mock.timers.tick(80);
  await flush();
  assert.equal(signal.aborted, true);
  assert.equal(f.status().reason, 'live-status-unconfirmed');
  assert.equal(f.players.length, 0);
  f.playback.retry();
  await flush();
  assert.equal(requests, 2);
  assert.equal(f.status().reason, 'live-status-unconfirmed');
  assert.equal(f.container.children.length, 0);
});

test('live-only embed still requires strictly newer server proof after an observed ending', async (t) => {
  let requests = 0;
  const f = fixture(t, {
    statusUrl: '/api/cctv/embed-status/camera-one',
    requireLiveStatus: true,
    fetchImpl: async () =>
      Response.json({
        status: 'live',
        checkedAt:
          ++requests < 3
            ? '2026-09-17T00:00:00.000Z'
            : '2026-09-17T00:01:00.000Z',
      }),
  });
  await flush();
  f.players[0].emit('onReady');
  f.players[0].emit('onStateChange', 1);
  f.players[0].emit('onStateChange', 0);
  f.playback.retry();
  await flush();
  assert.equal(f.players.length, 1);
  assert.equal(f.status().reason, 'broadcast-ended-awaiting-fresh-status');
  f.playback.retry();
  await flush();
  assert.equal(requests, 3);
  assert.equal(f.players.length, 2);
  f.players[1].emit('onReady');
  f.players[1].emit('onStateChange', 1);
  assert.equal(f.status().status, 'playing');
});

for (const status of ['ended', 'unavailable']) {
  test(`live-only embeds retain actionable ${status} publisher status`, async (t) => {
    const f = fixture(t, {
      statusUrl: '/api/cctv/embed-status/camera-one',
      requireLiveStatus: true,
      fetchImpl: async () =>
        Response.json({ status, message: 'Publisher status remains visible.' }),
    });
    await flush();
    assert.equal(f.status().status, status);
    assert.equal(f.status().reason, 'broadcast-not-live');
    assert.equal(f.status().message, 'Publisher status remains visible.');
    assert.equal(f.players.length, 0);
  });
}
