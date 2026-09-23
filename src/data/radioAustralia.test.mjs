import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AUSTRALIA_RADIO_LIMIT,
  createAustraliaRadioDirectory,
  normalizeAustraliaRadioSources,
  mergeAustraliaRadioStations,
  loadAustraliaRadioSources,
  loadAustraliaRadioExclusions,
} from '../../server/providers/radioAustralia.js';
import { normalizeUkraineRadioSources } from '../../server/providers/radioUkraine.js';
import {
  createRadioProxyMiddleware,
  normalizeRadioBrowserStation,
} from '../../server/providers/radio.js';

const DATE = '2026-09-17T12:00:00.000Z';
const UUID = '12345678-1234-4234-8234-123456789abc';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const source = (overrides = {}) => ({
  id: 'public-radio',
  name: 'Public Radio',
  streamUrl: 'https://radio.example.org/au',
  sourcePage: 'https://example.org/listen',
  codec: 'AAC',
  playbackKind: 'live',
  verifiedAt: DATE,
  ...overrides,
});
const row = (overrides = {}) => ({
  stationuuid: UUID,
  name: 'Australian Community Radio',
  url_resolved: 'https://radio.example.org/community',
  countrycode: 'AU',
  country: 'Australia',
  codec: 'MP3',
  hls: 0,
  lastcheckok: 1,
  geo_lat: null,
  geo_long: null,
  ...overrides,
});
function invoke(middleware, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const result = { status: 0, body: '' };
    Promise.resolve(
      middleware(
        { url, method },
        {
          writeHead(status) {
            result.status = status;
          },
          end(body = '') {
            result.body = String(body);
            resolve(result);
          },
        },
      ),
    ).catch(reject);
  });
}

test('Australian editorial sources require live provenance and keep country identities separate', () => {
  const [au] = normalizeAustraliaRadioSources([source()]);
  const [ua] = normalizeUkraineRadioSources([source()]);
  assert.notEqual(au.id, ua.id);
  assert.equal(au.countryCode, 'AU');
  assert.equal(au.sourceKind, 'curated-australia');
  assert.equal(au.lat, null);
  assert.equal(au.lon, null);
  for (const bad of [
    { playbackKind: 'recording' },
    { streamUrl: 'http://radio.example.org/live' },
    { verifiedAt: null },
    { codec: 'HTML' },
    { lat: -91 },
  ]) {
    assert.deepEqual(normalizeAustraliaRadioSources([source(bad)]), []);
  }
});

test('Australian directory deduplicates documented aliases and bitrate alternatives without merging regions', () => {
  const curated = normalizeAustraliaRadioSources([
    source({ name: 'ABC Radio Melbourne', aliases: ['774 ABC Melbourne'] }),
  ]);
  const rows = [
    '774 ABC Melbourne',
    'ABC Radio Melbourne (AAC)',
    'ABC Radio Sydney',
    'ABC Radio Melbourne Jazz',
  ].map((name, index) =>
    normalizeRadioBrowserStation(
      row({
        stationuuid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        name,
        url_resolved: `https://radio.example.org/${index}`,
      }),
      { requireGeo: false },
    ),
  );
  assert.deepEqual(
    mergeAustraliaRadioStations(curated, rows).map((x) => x.name),
    ['ABC Radio Melbourne', 'ABC Radio Sydney', 'ABC Radio Melbourne Jazz'],
  );
});

test('Australian country discovery includes unlocated audio, excludes foreign rows and keeps a finite separate budget', async () => {
  let calls = 0;
  const directory = createAustraliaRadioDirectory({
    now: () => Date.parse(DATE),
    loadSources: () => [],
    fetchPath: async (pathname) => {
      calls += 1;
      const params = new URL(pathname, 'https://example.org').searchParams;
      assert.equal(params.get('countrycode'), 'AU');
      assert.equal(params.get('has_geo_info'), null);
      assert.equal(params.get('limit'), '2500');
      return [
        row({ countrycode: 'US' }),
        ...Array.from({ length: 1600 }, (_, i) =>
          row({
            stationuuid: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
            name: `Station ${i}`,
            url_resolved: `https://radio.example.org/${i}`,
          }),
        ),
      ];
    },
  });
  const [a, b] = await Promise.all([
    directory.getCatalog(),
    directory.getCatalog(),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.stations.length, AUSTRALIA_RADIO_LIMIT);
  assert.equal(a.coverage.countryCode, 'AU');
  assert.equal(a.stations[0].lat, null);
  assert.equal(a.stations[0].playbackKind, 'unknown');
  assert.deepEqual(a, b);
});

test('country discovery corrects foreign streams and reconciles conflicting copies before filtering', async () => {
  const curated = normalizeAustraliaRadioSources([source({ streamUrl: 'https://radio.example.org/shared', lat: -37.8, lon: 145 })]);
  const directory = createAustraliaRadioDirectory({
    loadSources: () => curated,
    fetchPath: async () => [
      row({ name: 'CNN Australia', url_resolved: 'https://tunein.cdnstream1.com/2868_96.mp3' }),
      row({ stationuuid: '00000000-1111-4111-8111-111111111111', name: 'Foreign copy of shared feed', countrycode: 'GB', country: 'United Kingdom', url_resolved: 'https://radio.example.org/shared' }),
      row({ stationuuid: '00000000-2222-4222-8222-222222222222', name: 'Local Australian radio', url_resolved: 'https://radio.example.org/local' }),
    ],
  });
  const catalog = await directory.getCatalog();
  assert.deepEqual(catalog.stations.map((station) => station.name), ['Local Australian radio']);
  assert.ok(catalog.stations.every((station) => station.countryCode === 'AU'));
});

test('AU and UA routes cache independently and never submit editorial identities as upstream votes', async () => {
  const au = normalizeAustraliaRadioSources([source()]);
  const ua = normalizeUkraineRadioSources([
    source({ streamUrl: 'https://radio.example.org/ua' }),
  ]);
  const queried = [];
  const middleware = createRadioProxyMiddleware({
    lookupImpl: publicLookup,
    loadAustraliaSources: () => au,
    loadUkraineSources: () => ua,
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers'))
        return Response.json([{ name: 'de1.api.radio-browser.info' }]);
      const country = new URL(url).searchParams.get('countrycode');
      queried.push(country);
      return Response.json([row({ countrycode: country })]);
    },
  });
  const australian = JSON.parse(
    (await invoke(middleware, '/stations?country=au')).body,
  );
  const ukrainian = JSON.parse(
    (await invoke(middleware, '/stations?country=UA')).body,
  );
  assert.equal(australian.coverage.countryCode, 'AU');
  assert.equal(ukrainian.coverage.countryCode, 'UA');
  await invoke(middleware, '/stations?country=AU');
  assert.deepEqual(queried, ['AU', 'UA']);
  for (const station of [au[0], ua[0]])
    assert.equal(
      (await invoke(middleware, `/click/${station.id}`, 'POST')).status,
      204,
    );
  assert.deepEqual(queried, ['AU', 'UA']);
  assert.equal(
    (await invoke(middleware, '/stations?country=AU&country=UA')).status,
    400,
  );
});

test('Australian outage fallback uses verified stations and documented finite recordings stay excluded', async () => {
  const curated = normalizeAustraliaRadioSources([source()]);
  const middleware = createRadioProxyMiddleware({
    lookupImpl: publicLookup,
    loadAustraliaSources: () => curated,
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  const response = await invoke(middleware, '/stations?country=AU');
  const result = JSON.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(result.degraded, true);
  assert.equal(
    result.degradedReason,
    'australia-directory-unavailable-using-curated',
  );
  assert.equal(result.coverage.curatedStationCount, 1);
  const directory = createAustraliaRadioDirectory({
    loadSources: () => curated,
    loadExclusions: () => ({
      stationIds: new Set([UUID]),
      streamUrls: new Set(),
    }),
    fetchPath: async () => [row()],
  });
  assert.equal((await directory.getCatalog()).stations.length, 1);
});

test('shipped Australian fallback records have verification, unique streams and coverage across states and territories', () => {
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  const raw = JSON.parse(
    fs.readFileSync(
      path.join(sourceRoot, 'config/radio_sources.australia.json'),
      'utf8',
    ),
  );
  const stations = loadAustraliaRadioSources({ sourceRoot });
  assert.equal(stations.length, raw.stations.length);
  assert.ok(stations.length >= 20);
  assert.equal(new Set(stations.map((x) => x.streamUrl)).size, stations.length);
  for (const station of stations) {
    assert.equal(station.countryCode, 'AU');
    assert.equal(station.sourceKind, 'curated-australia');
    assert.equal(station.lat, null);
    assert.equal(station.lon, null);
    assert.equal(station.playbackKind, 'live');
    assert.ok(station.verifiedAt && station.sourcePage);
  }
  for (const state of [
    'New South Wales',
    'Victoria',
    'Queensland',
    'South Australia',
    'Western Australia',
    'Tasmania',
    'Northern Territory',
    'Australian Capital Territory',
  ]) {
    assert.ok(
      stations.some((x) => x.state === state),
      state,
    );
  }
  assert.ok(loadAustraliaRadioExclusions({ sourceRoot }).streamUrls.size > 0);
});

test('HLS is admitted only for explicitly live-only Australian curated radio and stays out of directory/global rows', () => {
  const hls = source({
    streamUrl: 'https://radio.example.org/live.m3u8',
    streamFormat: 'hls',
    liveOnly: true,
  });
  const [station] = normalizeAustraliaRadioSources([hls]);
  assert.equal(station.streamFormat, 'hls');
  assert.equal(station.liveOnly, true);
  assert.deepEqual(
    normalizeAustraliaRadioSources([{ ...hls, liveOnly: false }]),
    [],
  );
  assert.deepEqual(normalizeUkraineRadioSources([hls]), []);
  assert.equal(
    normalizeRadioBrowserStation(row({ hls: 1, codec: 'AAC' }), {
      requireGeo: false,
    }),
    null,
  );
});

test('documented finite recordings are excluded from the global directory too', async () => {
  const finiteUrl = 'https://recordings.example.org/three-hour.mp3';
  const validId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const middleware = createRadioProxyMiddleware({
    lookupImpl: publicLookup,
    loadAustraliaSources: () => [],
    loadAustraliaExclusions: () => ({
      stationIds: new Set([UUID]),
      streamUrls: new Set([finiteUrl]),
    }),
    fetchImpl: async (url) =>
      String(url).includes('/json/servers')
        ? Response.json([{ name: 'de1.api.radio-browser.info' }])
        : Response.json([
            row({ geo_lat: -37, geo_long: 144 }),
            row({
              stationuuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              url_resolved: finiteUrl,
              geo_lat: -37,
              geo_long: 144,
            }),
            row({
              stationuuid: validId,
              name: 'Running radio',
              geo_lat: -37,
              geo_long: 144,
            }),
          ]),
  });
  const result = JSON.parse((await invoke(middleware, '/stations')).body);
  assert.deepEqual(
    result.stations.map((x) => x.id),
    [validId],
  );
});
