import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCctvEmbedStatus,
  parseCctvPlayerResponse,
  classifyIpcamLivePlayer,
} from '../../server/providers/cctv/embedStatus.js';

const ipcamAlias = '69421e5731fe2';
const ipcamPage = `
  var alias = '${ipcamAlias}';
  var available = 1;
  var servicetype = 'U';
  var domainlockenabled = 0;
  params["timelapseenabledoncamera"] = 0;
  params["timeshiftenabled"] = 0;
  params["storageenabledoncamera"] = 0;
`;

test('reviewed IPCamLive public player status is checked without reading media URLs or tokens', async () => {
  let called;
  const check = createCctvEmbedStatus({
    fetchImpl: async (url, init) => {
      called = { url, init };
      return new Response(
        `${ipcamPage}var token = 'not-for-output'; var address = 'private';`,
      );
    },
  });
  const embedUrl = `https://g3.ipcamlive.com/player/player.php?alias=${ipcamAlias}`;
  const result = await check({ embedUrl });
  assert.equal(called.url, embedUrl);
  assert.equal(called.init.redirect, 'error');
  assert.equal(result.status, 'live');
  assert.equal(Number.isFinite(Date.parse(result.checkedAt)), true);
  assert.doesNotMatch(
    JSON.stringify(result),
    /not-for-output|private|token|address/,
  );
});

for (const [label, html, status] of [
  [
    'offline',
    ipcamPage.replace('available = 1', 'available = 0'),
    'unavailable',
  ],
  [
    'domain restricted',
    ipcamPage.replace('domainlockenabled = 0', 'domainlockenabled = 1'),
    'unavailable',
  ],
  [
    'embedding not enabled',
    ipcamPage.replace("servicetype = 'U'", "servicetype = 'B'"),
    'unavailable',
  ],
  ['wrong alias', ipcamPage.replace(ipcamAlias, '69421e4b4c166'), 'unknown'],
  [
    'missing availability',
    ipcamPage.replace('var available = 1;', ''),
    'unknown',
  ],
  [
    'missing service type',
    ipcamPage.replace("var servicetype = 'U';", ''),
    'unknown',
  ],
  ['ambiguous availability', `${ipcamPage}var available = 0;`, 'unknown'],
  ['login or challenge', '<html>Sign in to view camera</html>', 'unknown'],
  ...[
    'timelapseenabledoncamera',
    'timeshiftenabled',
    'storageenabledoncamera',
  ].flatMap((field) => [
    [
      field,
      ipcamPage.replace(`params["${field}"] = 0`, `params["${field}"] = 1`),
      'unknown',
    ],
    [
      `missing ${field}`,
      ipcamPage.replace(`params["${field}"] = 0;`, ''),
      'unknown',
    ],
  ]),
])
  test(`IPCamLive ${label} cannot be admitted as live`, () => {
    assert.equal(classifyIpcamLivePlayer(html, ipcamAlias).status, status);
  });

test('unreviewed IPCamLive aliases and hosts never trigger public metadata requests', async () => {
  let requests = 0;
  const check = createCctvEmbedStatus({
    fetchImpl: async () => {
      requests++;
      throw Error();
    },
  });
  for (const embedUrl of [
    'https://g3.ipcamlive.com/player/player.php?alias=unreviewed',
    `https://g2.ipcamlive.com/player/player.php?alias=${ipcamAlias}`,
    `https://g3.ipcamlive.com/player/player.php?alias=${ipcamAlias}&token=value`,
  ])
    assert.equal((await check({ embedUrl })).status, 'unavailable');
  assert.equal(requests, 0);
});

const source = {
  embedUrl: 'https://www.youtube-nocookie.com/embed/abcdefghijk',
};
function payload(patch = {}) {
  return {
    playabilityStatus: { status: 'OK', playableInEmbed: true },
    videoDetails: { videoId: 'abcdefghijk' },
    microformat: {
      playerMicroformatRenderer: { liveBroadcastDetails: { isLiveNow: true } },
    },
    ...patch,
  };
}
function page(value) {
  return `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(value)}; window.other = {};</script></html>`;
}
function response(value) {
  return new Response(page(value), {
    headers: { 'content-type': 'text/html' },
  });
}
async function flush() {
  for (let index = 0; index < 15; index++) await Promise.resolve();
}

function apiLiveItem(patch = {}) {
  return {
    id: 'abcdefghijk',
    snippet: { liveBroadcastContent: 'live' },
    status: { privacyStatus: 'public', embeddable: true },
    liveStreamingDetails: { actualStartTime: '2026-09-17T08:00:00Z' },
    ...patch,
  };
}

function apiFixture(options = {}) {
  const requests = [];
  const check = createCctvEmbedStatus({
    youtubeApiKey: 'test-server-youtube-key',
    now: () => Date.parse('2026-09-17T09:00:00Z'),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url.startsWith('https://www.youtube.com/watch?'))
        return response({ playabilityStatus: { status: 'LOGIN_REQUIRED' } });
      return new Response(JSON.stringify({ items: [apiLiveItem()] }));
    },
    ...options,
  });
  return { check, requests };
}

test('official API fallback requires a dedicated key and sends it only to the fixed endpoint header', async () => {
  const f = apiFixture();
  const result = await f.check(source);
  assert.equal(result.status, 'live');
  assert.equal(f.requests.length, 2);
  const request = f.requests[1];
  const url = new URL(request.url);
  assert.equal(
    url.origin + url.pathname,
    'https://www.googleapis.com/youtube/v3/videos',
  );
  assert.equal(url.searchParams.get('id'), 'abcdefghijk');
  assert.equal(
    url.searchParams.get('part'),
    'snippet,liveStreamingDetails,status',
  );
  assert.equal(url.searchParams.has('key'), false);
  assert.equal(
    request.init.headers['x-goog-api-key'],
    'test-server-youtube-key',
  );
  assert.equal(request.init.redirect, 'error');
  assert.equal(
    request.init.signal,
    f.requests[0].init.signal,
    'one total budget',
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /test-server-youtube-key|googleapis|https:/,
  );
  assert.equal(f.requests[0].init.headers['x-goog-api-key'], undefined);
});

for (const key of ['', undefined, null, 'bad\nkey'])
  test(`missing or invalid API key keeps zero-key behavior: ${JSON.stringify(key)}`, async () => {
    const f = apiFixture({ youtubeApiKey: key });
    assert.equal((await f.check(source)).status, 'unknown');
    assert.equal(f.requests.length, 1);
  });

for (const [label, watch, expected] of [
  ['already live', payload(), 'live'],
  [
    'ended',
    payload({
      microformat: {
        playerMicroformatRenderer: {
          liveBroadcastDetails: { isLiveNow: false },
        },
      },
    }),
    'ended',
  ],
  [
    'embedding denied',
    payload({ playabilityStatus: { status: 'OK', playableInEmbed: false } }),
    'unavailable',
  ],
  [
    'removed',
    payload({ playabilityStatus: { status: 'UNPLAYABLE' } }),
    'unavailable',
  ],
])
  test(`API fallback cannot override public ${label} evidence`, async () => {
    let requests = 0;
    const f = apiFixture({
      fetchImpl: async () => {
        requests++;
        return response(watch);
      },
    });
    assert.equal((await f.check(source)).status, expected);
    assert.equal(requests, 1);
  });

for (const [label, value, expected] of [
  ['wrong ID', { items: [apiLiveItem({ id: 'differentid' })] }, 'unknown'],
  ['empty results', { items: [] }, 'unknown'],
  ['ambiguous results', { items: [apiLiveItem(), apiLiveItem()] }, 'unknown'],
  ['missing results', {}, 'unknown'],
  [
    'API error inside HTTP200',
    { error: { message: 'test-server-youtube-key' }, items: [apiLiveItem()] },
    'unknown',
  ],
  [
    'private',
    {
      items: [
        apiLiveItem({ status: { privacyStatus: 'private', embeddable: true } }),
      ],
    },
    'unavailable',
  ],
  [
    'unlisted',
    {
      items: [
        apiLiveItem({
          status: { privacyStatus: 'unlisted', embeddable: true },
        }),
      ],
    },
    'unavailable',
  ],
  [
    'embedding disabled',
    {
      items: [
        apiLiveItem({ status: { privacyStatus: 'public', embeddable: false } }),
      ],
    },
    'unavailable',
  ],
  [
    'missing permission',
    { items: [apiLiveItem({ status: { privacyStatus: 'public' } })] },
    'unknown',
  ],
  [
    'missing privacy',
    { items: [apiLiveItem({ status: { embeddable: true } })] },
    'unknown',
  ],
  [
    'not live',
    { items: [apiLiveItem({ snippet: { liveBroadcastContent: 'none' } })] },
    'ended',
  ],
  [
    'upcoming',
    { items: [apiLiveItem({ snippet: { liveBroadcastContent: 'upcoming' } })] },
    'unavailable',
  ],
  ['missing live marker', { items: [apiLiveItem({ snippet: {} })] }, 'unknown'],
  [
    'missing live details',
    { items: [apiLiveItem({ liveStreamingDetails: undefined })] },
    'unknown',
  ],
  [
    'missing start',
    { items: [apiLiveItem({ liveStreamingDetails: {} })] },
    'unknown',
  ],
  [
    'bad start',
    {
      items: [apiLiveItem({ liveStreamingDetails: { actualStartTime: '0' } })],
    },
    'unknown',
  ],
  [
    'future start',
    {
      items: [
        apiLiveItem({
          liveStreamingDetails: { actualStartTime: '2027-09-17T08:00:00Z' },
        }),
      ],
    },
    'unknown',
  ],
  [
    'ended despite live marker',
    {
      items: [
        apiLiveItem({
          liveStreamingDetails: {
            actualStartTime: '2026-09-17T08:00:00Z',
            actualEndTime: '2026-09-17T08:59:00Z',
          },
        }),
      ],
    },
    'ended',
  ],
  [
    'ambiguous end',
    {
      items: [
        apiLiveItem({
          liveStreamingDetails: {
            actualStartTime: '2026-09-17T08:00:00Z',
            actualEndTime: null,
          },
        }),
      ],
    },
    'unknown',
  ],
])
  test(`API fallback fails closed for ${label}`, async () => {
    const f = apiFixture({
      fetchImpl: async (url) =>
        url.startsWith('https://www.youtube.com/watch?')
          ? new Response('<html>Live status could not be read</html>')
          : new Response(JSON.stringify(value)),
    });
    const result = await f.check(source);
    assert.equal(result.status, expected);
    assert.doesNotMatch(
      JSON.stringify(result),
      /test-server-youtube-key|googleapis/,
    );
  });

for (const status of [302, 403, 429, 500])
  test(`API HTTP${status} cannot disclose provider errors or enable playback`, async () => {
    const f = apiFixture({
      fetchImpl: async (url) =>
        url.startsWith('https://www.youtube.com/watch?')
          ? new Response('<html>Unknown</html>')
          : new Response('test-server-youtube-key', { status }),
    });
    const result = await f.check(source);
    assert.equal(result.status, 'unknown');
    assert.doesNotMatch(JSON.stringify(result), /test-server-youtube-key/);
  });

test('API network errors cannot expose secrets, and IPCamLive never uses YouTube credentials', async () => {
  const f = apiFixture({
    fetchImpl: async (url) => {
      if (url.includes('youtube.com/watch'))
        return new Response('<html>Unknown</html>');
      throw Error('failure with test-server-youtube-key');
    },
  });
  const result = await f.check(source);
  assert.equal(result.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /test-server-youtube-key/);
  let count = 0;
  const ipcam = apiFixture({
    fetchImpl: async (_url, init) => {
      count++;
      assert.equal(init.headers['x-goog-api-key'], undefined);
      return new Response('<html>Unknown</html>');
    },
  });
  assert.equal(
    (
      await ipcam.check({
        embedUrl: `https://g3.ipcamlive.com/player/player.php?alias=${ipcamAlias}`,
      })
    ).status,
    'unknown',
  );
  assert.equal(count, 1);
});

test('API fallback shares the original overall deadline and cancels late responses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  let done;
  const f = apiFixture({
    timeoutMs: 100,
    fetchImpl: async (url, init) => {
      if (url.includes('youtube.com/watch'))
        return new Response('<html>Unknown</html>');
      signal = init.signal;
      return new Promise((resolve) => {
        done = resolve;
      });
    },
  });
  const pending = f.check(source);
  await flush();
  t.mock.timers.tick(100);
  assert.equal((await pending).status, 'unknown');
  assert.equal(signal.aborted, true);
  done(new Response(JSON.stringify({ items: [apiLiveItem()] })));
  await flush();
  assert.equal(
    (await f.check(source)).status,
    'unknown',
    'late API proof cannot replace cached timeout',
  );
});

test('API requests are coalesced and cached with the public status result', async () => {
  const f = apiFixture();
  const values = await Promise.all(
    Array.from({ length: 8 }, () => f.check(source)),
  );
  assert.equal(
    values.every((value) => value.status === 'live'),
    true,
  );
  assert.equal(f.requests.length, 2);
  await f.check(source);
  assert.equal(f.requests.length, 2);
});

test('oversized or malformed API responses remain unconfirmed', async () => {
  for (const body of ['{bad-json', 'x'.repeat(65537)]) {
    const f = apiFixture({
      fetchImpl: async (url) =>
        url.includes('youtube.com/watch')
          ? new Response('<html>Unknown</html>')
          : new Response(body),
    });
    assert.equal((await f.check(source)).status, 'unknown');
  }
});

test('public watch metadata proves currently live only with matching ID and explicit embedding permission', async () => {
  let request;
  const check = createCctvEmbedStatus({
    now: () => 1000,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(payload());
    },
  });
  const value = await check(source);
  assert.equal(value.status, 'live');
  assert.equal(value.checkedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(request.url, 'https://www.youtube.com/watch?v=abcdefghijk');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.redirect, 'error');
  assert.ok(request.options.signal);
  assert.equal('html' in value, false);
});

test('the JSON reader handles braces, escaped quotes and backslashes inside strings without evaluating scripts', () => {
  const value = payload({
    title: 'A {camera} with "quotes" and \\ escapes',
    nested: { text: '}' },
  });
  assert.deepEqual(parseCctvPlayerResponse(page(value)), value);
  assert.deepEqual(
    parseCctvPlayerResponse(
      `window["ytInitialPlayerResponse"] = ${JSON.stringify(value)};`,
    ),
    value,
  );
  assert.equal(
    parseCctvPlayerResponse(
      'var ytInitialPlayerResponse = { malicious: (() => 42)() };',
    ),
    null,
  );
  assert.equal(
    parseCctvPlayerResponse('var ytInitialPlayerResponse = {"broken":'),
    null,
  );
  assert.equal(parseCctvPlayerResponse('<html>Consent required</html>'), null);
});

for (const [name, value, expected] of [
  [
    'ended',
    payload({
      microformat: {
        playerMicroformatRenderer: {
          liveBroadcastDetails: { isLiveNow: false },
        },
      },
    }),
    'ended',
  ],
  [
    'embedding disabled',
    payload({ playabilityStatus: { status: 'OK', playableInEmbed: false } }),
    'unavailable',
  ],
  [
    'removed',
    payload({
      playabilityStatus: {
        status: 'ERROR',
        reason: '<script>never returned</script>',
      },
    }),
    'unavailable',
  ],
  [
    'login required',
    payload({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }),
    'unknown',
  ],
  [
    'explicit offline',
    payload({ playabilityStatus: { status: 'LIVE_STREAM_OFFLINE' } }),
    'unavailable',
  ],
  [
    'ordinary finite video',
    payload({
      microformat: {},
      videoDetails: { videoId: 'abcdefghijk', isLiveContent: false },
    }),
    'ended',
  ],
  [
    'missing permission',
    payload({ playabilityStatus: { status: 'OK' } }),
    'unknown',
  ],
  [
    'other video',
    payload({ videoDetails: { videoId: 'different12' } }),
    'unknown',
  ],
  [
    'ever-live without current status',
    payload({
      microformat: {},
      videoDetails: { videoId: 'abcdefghijk', isLiveContent: true },
    }),
    'unknown',
  ],
  [
    'malformed live flag',
    payload({
      microformat: {
        playerMicroformatRenderer: {
          liveBroadcastDetails: { isLiveNow: 'true' },
        },
      },
    }),
    'unknown',
  ],
]) {
  test(`${name} metadata reports ${expected} without inventing current live status`, async () => {
    const check = createCctvEmbedStatus({
      fetchImpl: async () => response(value),
    });
    const result = await check(source);
    assert.equal(result.status, expected);
    assert.doesNotMatch(result.message, /<script>/);
  });
}

test('only validated official embed IDs can select a watch page', async () => {
  let fetches = 0;
  const check = createCctvEmbedStatus({
    fetchImpl: async () => {
      fetches++;
      return response(payload());
    },
  });
  for (const embedUrl of [
    'https://evil.example/embed/abcdefghijk',
    'https://www.youtube.com/embed/abcdefghijk?next=https://evil.example',
    'https://user@www.youtube.com/embed/abcdefghijk',
    'file:///etc/passwd',
  ]) {
    assert.equal((await check({ embedUrl })).status, 'unavailable');
  }
  assert.equal(fetches, 0);
  assert.equal(
    (await check({ embedUrl: 'https://www.youtube.com/embed/abcdefghijk' }))
      .status,
    'live',
  );
  assert.equal(fetches, 1);
});

test('simultaneous lookups coalesce and success cache expires after sixty seconds', async () => {
  let clock = 1000;
  let calls = 0;
  let release;
  const check = createCctvEmbedStatus({
    now: () => clock,
    fetchImpl: async () => {
      calls++;
      if (calls === 1)
        await new Promise((done) => {
          release = done;
        });
      return response(payload());
    },
  });
  const first = check(source);
  const second = check(source);
  release();
  assert.equal((await first).status, 'live');
  assert.equal((await second).status, 'live');
  assert.equal(calls, 1);
  const copied = await check(source);
  copied.status = 'mutated';
  assert.equal((await check(source)).status, 'live');
  clock += 59_999;
  await check(source);
  assert.equal(calls, 1);
  clock++;
  await check(source);
  assert.equal(calls, 2);
});

test('bounded cache evicts old IDs and also bounds outstanding distinct checks', async () => {
  let calls = 0;
  const check = createCctvEmbedStatus({
    maxEntries: 2,
    fetchImpl: async (url) => {
      calls++;
      return response(
        payload({
          videoDetails: { videoId: new URL(url).searchParams.get('v') },
        }),
      );
    },
  });
  for (const id of ['abcdefghijk', 'bcdefghijkl', 'cdefghijklm', 'abcdefghijk'])
    await check({ embedUrl: `https://www.youtube.com/embed/${id}` });
  assert.equal(calls, 4);
  let release;
  const busy = createCctvEmbedStatus({
    maxEntries: 1,
    fetchImpl: async () => {
      await new Promise((done) => {
        release = done;
      });
      return response(payload());
    },
  });
  const first = busy(source);
  assert.equal(
    (await busy({ embedUrl: 'https://www.youtube.com/embed/bcdefghijkl' }))
      .status,
    'unknown',
  );
  release();
  await first;
});

test('declared oversized and chunked oversized pages are cancelled and never parsed', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(page(payload())));
      },
      cancel() {
        cancelled = true;
      },
    });
    const check = createCctvEmbedStatus({
      maxBytes: 20,
      fetchImpl: async () =>
        new Response(body, {
          headers: declared ? { 'content-length': '9999' } : {},
        }),
    });
    assert.equal((await check(source)).status, 'unknown');
    assert.equal(cancelled, true);
  }
});

test('even a fetch implementation that ignores abort has a finite deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const check = createCctvEmbedStatus({
    timeoutMs: 50,
    fetchImpl: (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  const pending = check(source);
  t.mock.timers.tick(50);
  assert.equal((await pending).status, 'unknown');
  assert.equal(signal.aborted, true);
});

test('a stalled response body is cancelled by the same deadline as its headers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const check = createCctvEmbedStatus({
    timeoutMs: 50,
    fetchImpl: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  const pending = check(source);
  await flush();
  t.mock.timers.tick(50);
  assert.equal((await pending).status, 'unknown');
  assert.equal(cancelled, true);
});

test('HTTP errors and network failures remain unknown rather than pretending a broadcast ended', async () => {
  for (const fetchImpl of [
    async () => new Response('unavailable', { status: 429 }),
    async () => {
      throw new Error('network failed');
    },
    async () => new Response('<html>Consent required</html>'),
  ]) {
    const check = createCctvEmbedStatus({ fetchImpl });
    assert.equal((await check(source)).status, 'unknown');
  }
});
