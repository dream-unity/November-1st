import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFeedDirectory,
  filterFeedDirectory,
  readFeedDirectory,
  readCctvSnapshot,
} from './liveFeedsModel.js';

const station = {
  id: '12345678-1234-1234-1234-123456789012',
  name: 'Station One',
  lat: 51.5,
  lon: -0.1,
  streamUrl: 'https://radio.example/live',
  homepage: 'https://radio.example/',
  country: 'United Kingdom',
  countryCode: 'GB',
  state: 'London',
  tags: ['jazz'],
  languages: ['English'],
};
const camera = {
  id: 'cam-one',
  name: 'Camera One',
  lat: 30.2,
  lon: -97.7,
  city: 'Austin',
  provider: 'City',
  feedType: 'image',
};
const frame = (body = new Uint8Array([255, 216, 255]), extra = {}) =>
  new Response(body, {
    headers: {
      'content-type': 'image/jpeg',
      'x-cctv-source': 'upstream-image',
      ...extra,
    },
  });

test('directory rejects malformed collections and invalid coordinates without silently coercing them', () => {
  for (const payload of [
    null,
    {},
    { stations: {} },
    { stations: new Array(20_001) },
  ])
    assert.throws(
      () => normalizeFeedDirectory('radio', payload),
      /invalid response/,
    );
  for (const coords of [
    { lat: null },
    { lat: '30' },
    { lat: 91 },
    { lon: false },
    { lon: 181 },
  ]) {
    const result = normalizeFeedDirectory('cctv', {
      sources: [camera, { ...camera, ...coords, id: 'bad' }],
    });
    assert.deepEqual(
      result.items.map((item) => item.id),
      ['cam-one'],
    );
    assert.equal(result.rejected, 1);
  }
  assert.deepEqual(normalizeFeedDirectory('radio', { stations: [] }).items, []);
  assert.throws(
    () => normalizeFeedDirectory('radio', { stations: [null] }),
    /no usable entries/,
  );
});

test('radio admits only public HTTPS streams and strips unsafe broadcaster links', () => {
  for (const streamUrl of [
    'javascript:alert(1)',
    'http://radio.example/live',
    'https://localhost/live',
    'https://127.0.0.1/',
    'https://user:pass@radio.example/',
  ])
    assert.throws(
      () =>
        normalizeFeedDirectory('radio', {
          stations: [{ ...station, streamUrl }],
        }),
      /no usable entries/,
    );
  const result = normalizeFeedDirectory('radio', {
    stations: [{ ...station, homepage: 'javascript:alert(1)' }, station],
    stale: true,
    updatedAt: 'invalid',
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].homepage, null);
  assert.equal(result.stale, true);
  assert.equal(result.updatedAt, null);
});

test('search matches all words across location, station genre and language with exact region filtering', () => {
  const second = {
    ...station,
    id: 'second',
    name: 'Jazz Paris',
    country: 'France',
    languages: ['French'],
  };
  assert.deepEqual(
    filterFeedDirectory([station, second], 'jazz english').map(
      (item) => item.id,
    ),
    [station.id],
  );
  assert.deepEqual(
    filterFeedDirectory([station, second], 'jazz', 'France').map(
      (item) => item.id,
    ),
    ['second'],
  );
  assert.equal(filterFeedDirectory([station], 'missing').length, 0);
  assert.equal(filterFeedDirectory([camera], 'austin city').length, 1);
});

test('catalogue requests are same-origin, bounded, abortable and validate status before JSON', async () => {
  const calls = [];
  await readFeedDirectory('radio', {
    fetchImpl: async (...args) => {
      calls.push(args);
      return Response.json({ stations: [station] });
    },
  });
  assert.equal(calls[0][0], '/api/radio/stations');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].cache, 'no-store');
  await assert.rejects(
    readFeedDirectory('cctv', {
      fetchImpl: async () => new Response('failure', { status: 503 }),
    }),
    /HTTP 503/,
  );
  await assert.rejects(
    readFeedDirectory('radio', {
      fetchImpl: async () =>
        new Response('{}', { headers: { 'content-length': 9 * 1024 * 1024 } }),
    }),
    { code: 'RESPONSE_TOO_LARGE' },
  );
  await assert.rejects(
    readFeedDirectory('radio', {
      fetchImpl: async () => new Response('<html>failure</html>'),
    }),
    SyntaxError,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    readFeedDirectory('radio', {
      signal: abort.signal,
      fetchImpl: async () => Response.json({ stations: [station] }),
    }),
    { name: 'AbortError' },
  );
});

test('camera preview only requests registered strict routes and accepts real source image bytes', async () => {
  const calls = [];
  const blob = await readCctvSnapshot(
    { id: 'camera/with?query' },
    {
      fetchImpl: async (...args) => {
        calls.push(args);
        return frame();
      },
    },
  );
  assert.match(
    calls[0][0],
    /^\/api\/cctv\/frame\/camera%2Fwith%3Fquery\?strict=1&ts=\d+$/,
  );
  assert.equal(blob.type, 'image/jpeg');
  assert.equal(blob.size, 3);
});

test('camera preview refuses synthetic scenery, unconfirmed sources, HTML, empty and oversized frames', async () => {
  for (const response of [
    frame('<svg/>', { 'content-type': 'image/svg+xml' }),
    frame('fake', { 'x-cctv-source': 'synthetic' }),
    frame('fake', { 'x-cctv-source': 'streetview' }),
    new Response('fake', { headers: { 'content-type': 'image/jpeg' } }),
    frame('', {}),
    frame('small', { 'content-length': 9 * 1024 * 1024 }),
    frame('<html/>', { 'content-type': 'text/html' }),
  ]) {
    await assert.rejects(
      readCctvSnapshot(camera, { fetchImpl: async () => response }),
    );
  }
});

test('camera preview surfaces bounded provider errors and cancels in-flight reads when closed', async () => {
  await assert.rejects(
    readCctvSnapshot(camera, {
      fetchImpl: async () =>
        Response.json(
          { message: 'Camera is temporarily offline.' },
          { status: 503 },
        ),
    }),
    /temporarily offline/,
  );
  const abort = new AbortController();
  let cancelled = false;
  let readerStarted;
  const ready = new Promise((resolve) => {
    readerStarted = resolve;
  });
  const response = new Response(
    new ReadableStream({
      pull() {
        readerStarted();
      },
      cancel() {
        cancelled = true;
      },
    }),
    {
      headers: {
        'content-type': 'image/jpeg',
        'x-cctv-source': 'upstream-image',
      },
    },
  );
  const pending = readCctvSnapshot(camera, {
    signal: abort.signal,
    fetchImpl: async () => response,
  });
  await ready;
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
});
