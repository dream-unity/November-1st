import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeFeedDirectory,
  filterFeedDirectory,
  cameraCountry,
  cameraCountryOptions,
  interleaveCameraCountries,
  readFeedDirectory,
  readCctvSnapshot,
  radioCountryLabel,
  feedCoordinates,
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

test('radio keeps playable stations without a map location and never invents coordinates', () => {
  for (const coords of [
    { lat: null, lon: null },
    { lat: 52, lon: undefined },
    { lat: '50.1', lon: 31 },
    { lat: 91, lon: 31 },
  ]) {
    const { items } = normalizeFeedDirectory('radio', {
      stations: [
        {
          ...station,
          ...coords,
          sourceKind: 'curated-ukraine',
          sourcePage: 'https://broadcaster.example/live',
        },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].lat, null);
    assert.equal(items[0].lon, null);
    assert.equal(items[0].locationPrecision, 'unknown');
    assert.equal(items[0].streamUrl, station.streamUrl);
    assert.equal(items[0].sourcePage, 'https://broadcaster.example/live');
  }
});

test('legacy CNN country labels are corrected by exact stream identity before searching or filtering', () => {
  const { items } = normalizeFeedDirectory('radio', {
    stations: [
      {
        ...station,
        name: 'CNN UK',
        city: 'London',
        streamUrl: 'https://tunein.cdnstream1.com/2868_96.mp3',
      },
    ],
  });
  assert.equal(items[0].name, 'CNN (US)');
  assert.equal(items[0].country, 'United States');
  assert.equal(items[0].countryCode, 'US');
  assert.equal(items[0].countryStatus, 'verified');
  assert.equal(items[0].identitySource, 'https://tunein.com/cnn/');
  assert.equal(items[0].identityCheckedAt, '2026-09-23');
  assert.equal(feedCoordinates(items[0]), false);
  assert.equal(items[0].city, '');
  assert.equal(items[0].state, '');
  assert.equal(filterFeedDirectory(items, '', 'United Kingdom').length, 0);
  assert.equal(filterFeedDirectory(items, 'cnn', 'United States').length, 1);
});

test('conflicting stream country listings remain playable without a country filter or map location', () => {
  for (const id of [station.id, '12345678-1234-1234-1234-123456789013']) {
    const { items } = normalizeFeedDirectory('radio', {
      stations: [
        station,
        {
          ...station,
          id,
          country: 'United States',
          countryCode: 'US',
        },
      ],
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].countryStatus, 'conflicting');
    assert.equal(radioCountryLabel(items[0]), 'Country unconfirmed');
    assert.equal(items[0].streamUrl, station.streamUrl);
    assert.equal(feedCoordinates(items[0]), false);
    for (const country of ['United Kingdom', 'United States'])
      assert.equal(filterFeedDirectory(items, '', country).length, 0);
  }
});

test('unknown radio countries are not inferred from a station name or a truncated code', () => {
  const { items } = normalizeFeedDirectory('radio', {
    stations: [
      { ...station, name: 'London radio', country: '', countryCode: 'USA' },
    ],
  });
  assert.equal(items[0].countryStatus, 'unknown');
  assert.equal(items[0].countryCode, '');
  assert.equal(radioCountryLabel(items[0]), 'Country unconfirmed');
  assert.equal(filterFeedDirectory(items, '', 'United States').length, 0);
});

test('Ukrainian searches match country names, Cyrillic case, equivalent letters and apostrophes', () => {
  const ukrainian = {
    ...station,
    name: 'Радіо Ї П’ЯТНИЦЯ',
    country: 'Ukraine',
    countryCode: 'UA',
  };
  for (const query of [
    'Україна',
    'українська',
    'UKRAINE',
    'радіо і\u0308',
    "п'ятниця",
    'пʼятниця',
  ])
    assert.deepEqual(filterFeedDirectory([ukrainian], query), [ukrainian]);
  assert.equal(filterFeedDirectory([station], 'Україна').length, 0);
});

test('supported country directories are requested explicitly and unsupported country paths never reach the network', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return Response.json({ stations: [station] });
  };
  for (const country of ['UA', 'AU'])
    await readFeedDirectory('radio', { country, fetchImpl });
  assert.deepEqual(calls, [
    '/api/radio/stations?country=UA',
    '/api/radio/stations?country=AU',
  ]);
  for (const country of [
    'GB',
    '../stations',
    'UA&secret=x',
    'AU&secret=x',
    'toString',
    '__proto__',
  ])
    await assert.rejects(
      readFeedDirectory('radio', { country, fetchImpl }),
      /Unsupported country/,
    );
  await assert.rejects(
    readFeedDirectory('cctv', { country: 'UA', fetchImpl }),
    /Unsupported country/,
  );
  assert.equal(calls.length, 2);
});

test('Melbourne radio is an explicit Australian city request and preserves searchable locality without inventing map pins', async () => {
  const calls = [];
  const data = await readFeedDirectory('radio', {
    country: 'AU',
    city: 'melbourne',
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({
        stations: [
          {
            ...station,
            country: 'Australia',
            countryCode: 'AU',
            lat: null,
            lon: null,
            city: 'Melbourne',
            locality: 'Fitzroy',
            region: 'Greater Melbourne',
            metroArea: 'melbourne',
            geographySourcePage: 'https://broadcaster.example/about',
          },
        ],
      });
    },
  });
  assert.deepEqual(calls, ['/api/radio/stations?country=AU&city=melbourne']);
  assert.equal(data.items[0].lat, null);
  assert.equal(filterFeedDirectory(data.items, 'Fitzroy').length, 1);
  assert.equal(filterFeedDirectory(data.items, 'Greater Melbourne').length, 1);
  for (const options of [
    { country: 'UA', city: 'melbourne' },
    { country: 'AU', city: 'melbourne&secret=x' },
    { country: '', city: 'melbourne' },
  ])
    await assert.rejects(
      readFeedDirectory('radio', {
        ...options,
        fetchImpl: async () => {
          throw new Error('must not fetch');
        },
      }),
      /Unsupported city/,
    );
});

test('radio location-match labels admit only recognized Australian provenance values', () => {
  for (const metroMatch of ['curated', 'community-metadata']) {
    const data = normalizeFeedDirectory('radio', {
      stations: [
        {
          ...station,
          country: 'Australia',
          countryCode: 'AU',
          metroMatch,
        },
      ],
    });
    assert.equal(data.items[0].metroMatch, metroMatch);
  }
  for (const overrides of [
    { metroMatch: 'publisher-verified' },
    { metroMatch: '<script>community-metadata</script>' },
    { metroMatch: ['community-metadata'] },
    { metroMatch: 'community-metadata', countryCode: 'UA' },
  ]) {
    const data = normalizeFeedDirectory('radio', {
      stations: [
        {
          ...station,
          countryCode: 'AU',
          ...overrides,
        },
      ],
    });
    assert.equal(data.items[0].metroMatch, '');
  }
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

test('media classification never infers live streaming from an HLS or MP4 container alone', () => {
  const result = normalizeFeedDirectory('cctv', {
    sources: [
      { ...camera, id: 'image-fake-live', playbackKind: 'live' },
      { ...camera, id: 'declared-live', feedType: 'hls', playbackKind: 'live' },
      { ...camera, id: 'unknown-hls', feedType: 'hls' },
      { ...camera, id: 'clip', feedType: 'mp4', playbackKind: 'clip' },
      { ...camera, id: 'unknown-mp4', feedType: 'mp4' },
    ],
  });
  assert.deepEqual(
    result.items.map((item) => item.playbackKind),
    ['snapshot', 'live', 'video', 'clip', 'video'],
  );
  assert.deepEqual(
    filterFeedDirectory(result.items, '', '', 'live').map((item) => item.id),
    ['declared-live'],
  );
  assert.deepEqual(
    filterFeedDirectory(result.items, '', '', 'snapshot').map(
      (item) => item.id,
    ),
    ['image-fake-live'],
  );
  assert.deepEqual(
    filterFeedDirectory(result.items, '', '', 'video').map((item) => item.id),
    ['unknown-hls', 'clip', 'unknown-mp4'],
  );
  assert.equal(
    filterFeedDirectory(result.items, 'missing', '', 'live').length,
    0,
  );
});

test('camera countries are explicit source metadata and source links must be public HTTPS', () => {
  const sources = [
    {
      ...camera,
      id: 'australia',
      country: 'au',
      countryName: 'Australia',
      sourcePage: 'https://camera.example/public',
    },
    {
      ...camera,
      id: 'britain',
      countryCode: 'gb',
      countryName: 'United Kingdom',
      sourcePage: 'https://user:secret@camera.example/',
    },
    { ...camera, sourcePage: 'javascript:alert(1)' },
  ];
  const { items } = normalizeFeedDirectory('cctv', { sources });
  assert.equal(items[0].country, 'AU');
  assert.equal(items[0].countryCode, 'AU');
  assert.equal(items[0].countryName, 'Australia');
  assert.equal(items[0].sourcePage, 'https://camera.example/public');
  assert.equal(items[1].country, 'GB');
  assert.equal(items[1].sourcePage, null);
  assert.equal(items[2].sourcePage, null);
  assert.deepEqual(cameraCountry(items[2]), {
    code: '',
    name: 'Unknown country',
    value: '__unknown__',
  });
  assert.equal(items[2].country, '', 'Austin coordinates do not imply USA');
});

test('camera search, country, city and media filters intersect independently without changing radio country semantics', () => {
  const { items } = normalizeFeedDirectory('cctv', {
    sources: [
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
        city: 'Richmond',
        country: 'AU',
        countryName: 'Australia',
      },
      {
        ...camera,
        id: 'us-live',
        city: 'Richmond',
        country: 'US',
        countryName: 'United States',
        feedType: 'hls',
        playbackKind: 'live',
      },
      camera,
    ],
  });
  const ids = (...args) => filterFeedDirectory(items, ...args).map((x) => x.id);
  assert.deepEqual(ids('australia', 'Richmond', 'live', 'AU'), ['au-live']);
  assert.deepEqual(ids('au richmond', '', 'snapshot', 'AU'), ['au-still']);
  assert.deepEqual(ids('united states', 'Richmond', 'live', 'US'), ['us-live']);
  assert.deepEqual(ids('', 'Richmond', 'live', 'US'), ['us-live']);
  assert.deepEqual(ids('australia', '', 'all', 'US'), []);
  assert.deepEqual(ids('', '', 'all', '__unknown__'), [camera.id]);
  assert.equal(filterFeedDirectory([station], '', 'United Kingdom').length, 1);
});

test('country coverage counts declared live sources without promoting clips or unknown media', () => {
  const { items } = normalizeFeedDirectory('cctv', {
    sources: [
      {
        ...camera,
        id: 'au-live',
        country: 'AU',
        countryName: 'Australia',
        feedType: 'hls',
        playbackKind: 'live',
      },
      {
        ...camera,
        id: 'au-unknown',
        country: 'AU',
        countryName: 'Australia',
        feedType: 'hls',
      },
      {
        ...camera,
        id: 'au-clip',
        country: 'AU',
        countryName: 'Australia',
        feedType: 'mp4',
        playbackKind: 'clip',
      },
      {
        ...camera,
        id: 'gb-image',
        country: 'GB',
        countryName: 'United Kingdom',
        playbackKind: 'live',
      },
      camera,
    ],
  });
  assert.deepEqual(
    cameraCountryOptions(items).map(({ value, name, total, live }) => ({
      value,
      name,
      total,
      live,
    })),
    [
      { value: 'AU', name: 'Australia', total: 3, live: 1 },
      { value: 'GB', name: 'United Kingdom', total: 1, live: 0 },
      { value: '__unknown__', name: 'Unknown country', total: 1, live: 0 },
    ],
  );
});

test('official video embeds are admitted only through the shared provider allowlist', () => {
  const valid = {
    ...camera,
    id: 'official',
    country: 'JP',
    countryName: 'Japan',
    feedType: 'embed',
    playbackKind: 'live',
    embedUrl: 'https://www.youtube-nocookie.com/embed/5iDycGQWPCg',
  };
  for (const embedUrl of [
    'javascript:alert(1)',
    'https://attacker.example/embed/5iDycGQWPCg',
    'https://www.youtube-nocookie.com.attacker.example/embed/5iDycGQWPCg',
    'https://user:secret@www.youtube-nocookie.com/embed/5iDycGQWPCg',
    'https://www.youtube-nocookie.com/embed/invalid',
  ]) {
    const result = normalizeFeedDirectory('cctv', {
      sources: [valid, { ...valid, id: 'invalid', embedUrl }],
    });
    assert.deepEqual(
      result.items.map((item) => item.id),
      ['official'],
    );
    assert.equal(result.items[0].playbackKind, 'live');
    assert.equal(result.rejected, 1);
    assert.equal(cameraCountryOptions(result.items)[0].live, 1);
  }
});

test('camera display interleaves countries without dropping records or changing within-country order', () => {
  const sources = [
    ...Array.from({ length: 40 }, (_, index) => ({
      ...camera,
      id: `us-${index}`,
      country: 'US',
    })),
    { ...camera, id: 'jp-1', country: 'JP' },
    { ...camera, id: 'jp-2', country: 'JP' },
    { ...camera, id: 'au-1', country: 'AU' },
    camera,
  ];
  const shown = interleaveCameraCountries(sources);
  assert.deepEqual(
    shown.slice(0, 6).map((item) => item.id),
    ['us-0', 'jp-1', 'au-1', camera.id, 'us-1', 'jp-2'],
  );
  assert.equal(shown.length, sources.length);
  assert.deepEqual(
    shown.filter((item) => item.country === 'US'),
    sources.filter((item) => item.country === 'US'),
  );
  assert.deepEqual(interleaveCameraCountries([]), []);
  assert.equal(sources[1].id, 'us-1', 'the original catalogue is not mutated');
});
