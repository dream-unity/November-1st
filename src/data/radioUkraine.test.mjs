import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createUkraineRadioDirectory,
  mergeUkraineRadioStations,
  normalizeUkraineRadioSources,
  UKRAINE_RADIO_LIMIT,
  loadUkraineRadioSources,
  loadUkraineRadioExclusions,
} from '../../server/providers/radioUkraine.js';
import { createRadioProxyMiddleware } from '../../server/providers/radio.js';
import { normalizeRadioBrowserStation, RADIO_UUID_RE } from '../sources/radioBrowser.js';

const DATE = '2026-09-17T12:00:00.000Z';
const UUID = '12345678-1234-4234-8234-123456789abc';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('every shipped Ukraine broadcaster is admitted with provenance and no invented coordinates', () => {
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  const raw = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'config/radio_sources.ukraine.json'), 'utf8'));
  const stations = loadUkraineRadioSources({ sourceRoot });
  assert.equal(stations.length, raw.stations.length);
  assert.ok(stations.length >= 20);
  assert.equal(new Set(stations.map(station => station.streamUrl)).size, stations.length);
  for (const station of stations) {
    assert.equal(station.countryCode, 'UA');
    assert.equal(station.sourceKind, 'curated-ukraine');
    assert.ok(station.sourcePage && station.verifiedAt);
    assert.equal(station.lat, null);
    assert.equal(station.lon, null);
  }
  const excluded = loadUkraineRadioExclusions({ sourceRoot });
  assert.ok(excluded.streamUrls.has('https://www.myinstants.com/media/sounds/live-dy-chat-sound.mp3'));
});

function directoryRow(overrides = {}) {
  return {
    stationuuid: UUID,
    name: 'Українське радіо',
    url_resolved: 'https://radio.example.org/ukraine.mp3',
    homepage: 'https://example.org/',
    tags: 'news,talk',
    language: 'Ukrainian',
    countrycode: 'UA',
    country: 'Ukraine',
    state: '',
    codec: 'MP3',
    bitrate: 128,
    hls: 0,
    lastcheckok: 1,
    geo_lat: null,
    geo_long: null,
    clickcount: 30,
    ...overrides,
  };
}

function curatedRow(overrides = {}) {
  return {
    id: 'ua-public-radio',
    name: 'Public radio',
    streamUrl: 'https://radio.example.org/public',
    homepage: 'https://example.org/',
    sourcePage: 'https://example.org/listen',
    codec: 'MP3',
    languages: ['Ukrainian'],
    tags: ['news'],
    playbackKind: 'live',
    verifiedAt: DATE,
    ...overrides,
  };
}

function invoke(middleware, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const result = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(status, headers = {}) { result.status = status; result.headers = headers; },
      end(body = '') { result.body = String(body); resolve(result); },
    };
    Promise.resolve(middleware({ url, method }, res)).catch(reject);
  });
}

test('country audio discovery accepts absent coordinates without weakening globe admission', () => {
  assert.equal(normalizeRadioBrowserStation(directoryRow()), null);
  const station = normalizeRadioBrowserStation(directoryRow(), { requireGeo: false });
  assert.equal(station.lat, null);
  assert.equal(station.lon, null);
  assert.equal(station.countryCode, 'UA');
  const partial = normalizeRadioBrowserStation(directoryRow({ geo_lat: 50.45 }), { requireGeo: false });
  assert.equal(partial.lat, null, 'a partial coordinate pair must not create a fabricated map pin');
  assert.equal(partial.lon, null);
  for (const bad of [NaN, Infinity, true, {}, 91, 'bad']) {
    assert.equal(normalizeRadioBrowserStation(directoryRow({ geo_lat: bad }), { requireGeo: false }), null);
  }
  for (const overrides of [
    { lastcheckok: 0 }, { hls: 1 }, { codec: 'OGG' },
    { url_resolved: 'http://radio.example.org/live' },
    { url_resolved: 'https://127.0.0.1/live' },
  ]) assert.equal(normalizeRadioBrowserStation(directoryRow(overrides), { requireGeo: false }), null);
});

test('editorial registry requires documented live public streams and stable application IDs', () => {
  const [first] = normalizeUkraineRadioSources([curatedRow()]);
  const [second] = normalizeUkraineRadioSources([curatedRow({ name: 'Updated name' })]);
  assert.match(first.id, RADIO_UUID_RE);
  assert.equal(first.id, second.id);
  assert.equal(first.sourceKind, 'curated-ukraine');
  assert.equal(first.metadataTrust, 'curated-public-source');
  assert.equal(first.locationPrecision, 'unknown');
  assert.equal(first.lat, null);
  assert.equal(first.lon, null);
  for (const overrides of [
    { playbackKind: 'clip' }, { playbackKind: undefined },
    { verifiedAt: 'invalid' }, { sourcePage: 'https://localhost/listen' },
    { streamUrl: 'https://10.0.0.1/listen' }, { codec: 'HTML' },
    { lat: 95, lon: 30 },
  ]) assert.deepEqual(normalizeUkraineRadioSources([curatedRow(overrides)]), []);
  assert.equal(normalizeUkraineRadioSources([curatedRow(), curatedRow()]).length, 1);
});

test('merged directory prefers verified URLs and deduplicates identity, URL and codec variants', () => {
  const curated = normalizeUkraineRadioSources([curatedRow({ name: 'Public Radio 128 kbps' })]);
  const normalize = (row) => normalizeRadioBrowserStation(row, { requireGeo: false });
  const rows = [
    normalize(directoryRow({ name: 'Public Radio (AAC)', url_resolved: 'https://other.example.org/live' })),
    normalize(directoryRow({ stationuuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Same stream alternate name', url_resolved: curated[0].streamUrl })),
    normalize(directoryRow({ stationuuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Public Radio Jazz' })),
    normalize(directoryRow({ stationuuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Foreign station', countrycode: 'DE' })),
  ];
  const selected = mergeUkraineRadioStations(curated, rows);
  assert.equal(selected.length, 2);
  assert.equal(selected[0].sourceKind, 'curated-ukraine');
  assert.equal(selected[1].name, 'Public Radio Jazz');
});

test('country discovery is coalesced, bounded, cached and omits the geographic filter', async () => {
  let calls = 0;
  const directory = createUkraineRadioDirectory({
    loadSources: () => [],
    now: () => Date.parse(DATE),
    fetchPath: async (pathname) => {
      calls += 1;
      const url = new URL(pathname, 'https://example.org');
      assert.equal(url.searchParams.get('countrycode'), 'UA');
      assert.equal(url.searchParams.get('has_geo_info'), null);
      assert.equal(url.searchParams.get('limit'), '1000');
      return Array.from({ length: 800 }, (_, index) => directoryRow({
        stationuuid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
        name: `Programme ${index}`,
        url_resolved: `https://radio.example.org/${index}`,
      }));
    },
  });
  const [one, two] = await Promise.all([directory.getCatalog(), directory.getCatalog()]);
  const three = await directory.getCatalog();
  assert.equal(calls, 1);
  assert.equal(one.stations.length, UKRAINE_RADIO_LIMIT);
  assert.deepEqual(one.stations, two.stations);
  assert.deepEqual(one.stations, three.stations);
  assert.equal(one.coverage.countryCode, 'UA');
  assert.equal(one.acceptedGeneration, 1);
  assert.equal(one.degraded, false);
  assert.equal(one.stations[0].locationPrecision, 'unknown');
  assert.equal(one.stations[0].playbackKind, 'unknown', 'community metadata is not represented as publisher playback verification');
});

test('upstream outage keeps the bounded warm country catalogue and throttles partial retries', async () => {
  let clock = Date.parse(DATE);
  let fail = false;
  let calls = 0;
  const directory = createUkraineRadioDirectory({
    loadSources: () => normalizeUkraineRadioSources([curatedRow()]),
    now: () => clock,
    fetchPath: async () => {
      calls += 1;
      if (fail) throw new Error('offline');
      return [directoryRow()];
    },
  });
  const healthy = await directory.getCatalog();
  clock += 46 * 60 * 1000;
  fail = true;
  const stale = await directory.getCatalog();
  assert.equal(stale.stale, true);
  assert.equal(stale.degraded, true);
  assert.equal(stale.updatedAt, healthy.updatedAt);
  assert.equal(stale.acceptedGeneration, healthy.acceptedGeneration);
  await directory.getCatalog();
  assert.equal(calls, 2);
  clock += 8 * 24 * 60 * 60 * 1000;
  const expired = await directory.getCatalog();
  assert.equal(expired.stale, false);
  assert.equal(expired.degraded, true);
  assert.equal(expired.acceptedGeneration, null);
  assert.equal(expired.stations.length, 1, 'an expired community catalogue must not survive beyond the stale deadline');
  assert.equal(directory.stationKind(UUID), undefined);
});

test('country route exposes curated fallback without fake upstream clicks and preserves global lookup', async () => {
  let calls = 0;
  const curated = normalizeUkraineRadioSources([curatedRow()]);
  const middleware = createRadioProxyMiddleware({
    lookupImpl: publicLookup,
    loadUkraineSources: () => curated,
    fetchImpl: async (url) => {
      calls += 1;
      if (String(url).includes('/json/servers')) return Response.json([{ name: 'de1.api.radio-browser.info' }]);
      if (new URL(url).searchParams.get('countrycode') === 'UA') throw new Error('country mirror unavailable');
      return Response.json([directoryRow({ geo_lat: 50.45, geo_long: 30.52 })]);
    },
  });
  assert.equal((await invoke(middleware, '/stations?country=FR')).status, 400);
  assert.equal((await invoke(middleware, '/stations?country=UA&country=FR')).status, 400);
  assert.equal(calls, 0);
  const scoped = await invoke(middleware, '/stations?country=UA');
  assert.equal(scoped.status, 200);
  const payload = JSON.parse(scoped.body);
  assert.equal(payload.stations.length, 1);
  assert.equal(payload.degraded, true);
  assert.equal(payload.stations[0].lat, null);
  const previousCalls = calls;
  assert.equal((await invoke(middleware, `/click/${curated[0].id}`, 'POST')).status, 204);
  assert.equal(calls, previousCalls, 'curated UUIDs must not be submitted to Radio Browser');
  const global = await invoke(middleware, '/stations');
  assert.equal(global.status, 200);
  assert.equal(JSON.parse(global.body).stations[0].id, UUID);
  assert.equal((await invoke(middleware, `/click/${curated[0].id}`, 'POST')).status, 204);
});

test('bounded catalogue timeout still returns curated audio when a transport ignores cancellation', async () => {
  const middleware = createRadioProxyMiddleware({
    lookupImpl: publicLookup,
    catalogTimeoutMs: 20,
    fetchTimeoutMs: 20,
    discoveryTimeoutMs: 20,
    loadUkraineSources: () => normalizeUkraineRadioSources([curatedRow()]),
    fetchImpl: async (url) => String(url).includes('/json/servers')
      ? Response.json([{ name: 'de1.api.radio-browser.info' }])
      : new Promise(() => {}),
  });
  const response = await invoke(middleware, '/stations?country=UA');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).degraded, true);
});

test('the configured registry root supplies editorial streams and documented directory exclusions', async () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ukraine-radio-test-'));
  try {
    fs.mkdirSync(path.join(sourceRoot, 'config'));
    fs.writeFileSync(path.join(sourceRoot, 'config/radio_sources.ukraine.json'), JSON.stringify({
      stations: [curatedRow()],
      excludedStationIds: [UUID],
      excludedStreamUrls: ['https://recordings.example.org/finite.mp3'],
    }));
    const middleware = createRadioProxyMiddleware({
      sourceRoot,
      lookupImpl: publicLookup,
      fetchImpl: async (url) => String(url).includes('/json/servers')
        ? Response.json([{ name: 'de1.api.radio-browser.info' }])
        : Response.json([
          directoryRow(),
          directoryRow({ stationuuid: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', url_resolved: 'https://recordings.example.org/finite.mp3' }),
          directoryRow({ stationuuid: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'Another real station', url_resolved: 'https://radio.example.org/another' }),
        ]),
    });
    const response = await invoke(middleware, '/stations?country=UA');
    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.stations.length, 2);
    assert.equal(payload.coverage.curatedStationCount, 1);
    assert.equal(payload.coverage.directoryStationCount, 1);
    assert.equal(payload.stations.some((station) => station.id === UUID), false);
    assert.equal(payload.stations.some((station) => station.streamUrl.includes('finite.mp3')), false);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
