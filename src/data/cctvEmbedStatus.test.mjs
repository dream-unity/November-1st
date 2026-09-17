import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCctvEmbedStatus,
  parseCctvPlayerResponse,
} from '../../server/providers/cctv/embedStatus.js';

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
