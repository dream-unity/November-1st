import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAustraliaRadioDirectory,
  melbourneRadioCatalog,
  normalizeAustraliaRadioSources,
} from '../../server/providers/radioAustralia.js';
import { createRadioProxyMiddleware } from '../../server/providers/radio.js';

const DATE = '2026-09-17T12:00:00.000Z';
const source = (id, overrides = {}) => ({
  id,
  name: id,
  streamUrl: `https://radio.example.org/${id}`,
  sourcePage: 'https://example.org/listen',
  codec: 'AAC',
  playbackKind: 'live',
  verifiedAt: DATE,
  state: 'Victoria',
  ...overrides,
});
const localSource = (id, overrides = {}) =>
  source(id, {
    city: 'Melbourne',
    region: 'Greater Melbourne',
    locality: 'Brunswick East',
    metroArea: 'melbourne',
    geographicScope: 'suburban',
    geographySourcePage: 'https://example.org/about',
    ...overrides,
  });
const row = (index, overrides = {}) => ({
  stationuuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  name: `Community ${index}`,
  url_resolved: `https://community.example.org/${index}`,
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

test('Melbourne publisher geography survives the country API without inventing coordinates', async () => {
  const curated = normalizeAustraliaRadioSources([
    localSource('Local station', {
      city: ' Melbourne\n',
      locality: ' Brunswick\t East ',
    }),
  ]);
  const directory = createAustraliaRadioDirectory({
    loadSources: () => curated,
    fetchPath: async () => {
      throw new Error('offline');
    },
  });
  const catalog = await directory.getCatalog();
  assert.deepEqual(
    Object.fromEntries(
      [
        'city',
        'region',
        'locality',
        'metroArea',
        'geographicScope',
        'geographySourcePage',
        'lat',
        'lon',
        'locationPrecision',
      ].map((key) => [key, catalog.stations[0][key]]),
    ),
    {
      city: 'Melbourne',
      region: 'Greater Melbourne',
      locality: 'Brunswick East',
      metroArea: 'melbourne',
      geographicScope: 'suburban',
      geographySourcePage: 'https://example.org/about',
      lat: null,
      lon: null,
      locationPrecision: 'unknown',
    },
  );
  assert.equal(
    normalizeAustraliaRadioSources([
      localSource('unsafe source', {
        geographySourcePage: 'http://127.0.0.1/private',
        metroArea: 'other-city',
      }),
    ])[0].geographySourcePage,
    null,
  );
});

test('Melbourne is a bounded projection with explicit curated scope and labelled community claims', async () => {
  const curated = normalizeAustraliaRadioSources([
    localSource('Inner suburb radio'),
    source('National radio', { city: 'Melbourne' }),
    source('ABC Radio Ballarat'),
  ]);
  const directory = createAustraliaRadioDirectory({
    loadSources: () => curated,
    fetchPath: async () => [
      row(1, { name: 'A Melbourne programme' }),
      row(2, { state: 'Melbourne, Victoria' }),
      row(3, { tags: 'community,greater melbourne' }),
      row(4, { state: 'Victoria' }),
      row(5, { name: 'Melbourneish radio' }),
      row(6, { name: 'Melbourne Florida', countrycode: 'US' }),
      row(7, { geo_lat: -37.81, geo_long: 144.96 }),
    ],
  });
  const country = await directory.getCatalog();
  const snapshot = structuredClone(country);
  const metro = melbourneRadioCatalog(country);
  assert.deepEqual(
    metro.stations.map((station) => station.name),
    [
      'Inner suburb radio',
      'A Melbourne programme',
      'Community 2',
      'Community 3',
    ],
  );
  assert.deepEqual(
    metro.stations.map((station) => station.metroMatch),
    [
      'curated',
      'community-metadata',
      'community-metadata',
      'community-metadata',
    ],
  );
  assert.equal(metro.coverage.countryStationCount, 9);
  assert.equal(metro.coverage.stationCount, 4);
  assert.equal(metro.coverage.curatedStationCount, 1);
  assert.equal(metro.coverage.directoryStationCount, 3);
  assert.equal(metro.coverage.inferredStationCount, 3);
  assert.equal(metro.updatedAt, country.updatedAt);
  assert.equal(metro.acceptedGeneration, country.acceptedGeneration);
  assert.deepEqual(country, snapshot);
  assert.ok(metro.stations.every((station) => station.lat === null));
});

test('Melbourne HTTP view shares AU cache and click identities while complete AU and UA remain distinct', async () => {
  const queried = [];
  const middleware = createRadioProxyMiddleware({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    loadAustraliaSources: () =>
      normalizeAustraliaRadioSources([
        localSource('Melbourne local'),
        source('National broadcaster'),
      ]),
    loadUkraineSources: () => [],
    fetchImpl: async (url) => {
      if (String(url).includes('/json/servers'))
        return Response.json([{ name: 'de1.api.radio-browser.info' }]);
      const country = new URL(url).searchParams.get('countrycode');
      queried.push(country);
      return Response.json([row(1, { countrycode: country })]);
    },
  });
  const [cityResponse, countryResponse] = await Promise.all([
    invoke(middleware, '/stations?country=au&city=Melbourne'),
    invoke(middleware, '/stations?country=AU'),
  ]);
  assert.equal(cityResponse.status, 200);
  const city = JSON.parse(cityResponse.body);
  const country = JSON.parse(countryResponse.body);
  assert.equal(city.stations.length, 1);
  assert.equal(country.stations.length, 3);
  assert.equal(city.coverage.countryStationCount, 3);
  assert.equal(city.coverage.metroArea, 'melbourne');
  assert.equal(city.catalogInstance, country.catalogInstance);
  assert.equal(city.acceptedGeneration, country.acceptedGeneration);
  assert.deepEqual(queried, ['AU']);
  assert.equal(
    (await invoke(middleware, `/click/${city.stations[0].id}`, 'POST')).status,
    204,
  );
  assert.deepEqual(queried, ['AU']);
  const ukrainian = JSON.parse(
    (await invoke(middleware, '/stations?country=UA')).body,
  );
  assert.equal(ukrainian.coverage.countryCode, 'UA');
  assert.deepEqual(queried, ['AU', 'UA']);
});

test('unsupported or ambiguous city queries fail closed before upstream discovery', async () => {
  let fetched = false;
  const middleware = createRadioProxyMiddleware({
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      fetched = true;
      throw new Error('must not fetch');
    },
  });
  for (const query of [
    'city=melbourne',
    'country=UA&city=melbourne',
    'country=AU&city=Sydney',
    'country=AU&city=',
    'country=AU&city=melbourne&city=melbourne',
    'country=AU&country=AU&city=melbourne',
    'country=AU&city=melbourne%00',
  ]) {
    assert.equal((await invoke(middleware, `/stations?${query}`)).status, 400);
  }
  assert.equal(fetched, false);
});

test('an empty Melbourne view preserves the country fallback and its degradation metadata', async () => {
  const directory = createAustraliaRadioDirectory({
    loadSources: () => normalizeAustraliaRadioSources([source('National')]),
    fetchPath: async () => {
      throw new Error('offline');
    },
  });
  const country = await directory.getCatalog();
  const metro = melbourneRadioCatalog(country);
  assert.deepEqual(metro.stations, []);
  assert.equal(metro.degraded, true);
  assert.equal(metro.degradedReason, country.degradedReason);
  assert.equal(metro.coverage.stationCount, 0);
  assert.equal(metro.coverage.countryStationCount, 1);
  assert.equal(country.stations.length, 1);
});
