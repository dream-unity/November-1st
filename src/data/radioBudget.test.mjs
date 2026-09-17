import test from 'node:test';
import assert from 'node:assert/strict';
import { createRadioProxyMiddleware } from '../../server/providers/radio/catalog.js';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const json = (value) => new Response(JSON.stringify(value));
const never = () => new Promise(() => {});
const rows = (url) =>
  Array.from({ length: 400 }, (_, index) => ({
    stationuuid: `30000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    name: `Station ${index}`,
    url_resolved: 'https://stream.example.org/live.mp3',
    homepage: 'https://station.example.org/',
    tags: new URL(url).searchParams.get('tag') || 'news',
    language: 'English',
    country: 'United States',
    countrycode: 'US',
    codec: 'MP3',
    bitrate: 128,
    hls: 0,
    lastcheckok: 1,
    geo_lat: 30,
    geo_long: -97,
    clickcount: index,
  }));
async function invoke(middleware) {
  let result;
  await middleware(
    { url: '/stations', method: 'GET' },
    {
      writeHead(status) {
        result = { status };
      },
      end(body) {
        result.body = JSON.parse(body);
      },
    },
  );
  return result;
}
function create(options) {
  return createRadioProxyMiddleware({
    lookupImpl: publicLookup,
    catalogTimeoutMs: 45,
    fetchTimeoutMs: 1000,
    discoveryTimeoutMs: 15,
    ...options,
  });
}

test(
  'one catalogue deadline bounds DNS that never resolves',
  { timeout: 2000 },
  async () => {
    let fetches = 0;
    const result = await invoke(
      create({
        lookupImpl: never,
        fetchImpl: async () => {
          fetches++;
          return json([]);
        },
      }),
    );
    assert.equal(result.status, 503);
    assert.equal(fetches, 0);
  },
);

test(
  'one catalogue budget cancels non-cooperative fetches without walking every discovered mirror',
  { timeout: 2000 },
  async () => {
    const signals = [];
    const middleware = create({
      fetchImpl: async (url, { signal }) => {
        if (url.includes('/json/servers'))
          return json(
            Array.from({ length: 100 }, (_, i) => ({
              name: `mirror${i}.api.radio-browser.info`,
            })),
          );
        signals.push(signal);
        return never();
      },
    });
    const result = await invoke(middleware);
    assert.equal(result.status, 503);
    assert.equal(
      signals.length,
      3,
      'only the three initial concurrent queries consume the shared budget',
    );
    assert.ok(signals.every((signal) => signal.aborted));
  },
);

test(
  'completed cold rows survive hung body timeouts as explicitly degraded data',
  { timeout: 2000 },
  async () => {
    let cancellations = 0;
    const result = await invoke(
      create({
        fetchImpl: async (url) => {
          if (url.includes('/json/servers'))
            return json([{ name: 'de1.api.radio-browser.info' }]);
          if (!new URL(url).searchParams.has('tag')) return json(rows(url));
          return new Response(
            new ReadableStream({
              cancel() {
                cancellations++;
              },
            }),
          );
        },
      }),
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.stations.length, 400);
    assert.equal(result.body.degraded, true);
    assert.equal(result.body.stale, false);
    assert.equal(result.body.acceptedGeneration, null);
    assert.equal(result.body.coverage.successfulQueries, 1);
    assert.ok(
      cancellations > 0,
      'pending response readers release their streams',
    );
  },
);

test(
  'a timed-out refresh retains the last healthy generation and recovers on the next request',
  { timeout: 2000 },
  async () => {
    let clock = Date.now();
    let failed = false;
    const middleware = create({
      now: () => clock,
      fetchImpl: async (url) => {
        if (url.includes('/json/servers'))
          return json([{ name: 'de1.api.radio-browser.info' }]);
        return failed ? never() : json(rows(url));
      },
    });
    const first = await invoke(middleware);
    assert.equal(first.body.degraded, false);
    clock += 46 * 60_000;
    failed = true;
    const retained = await invoke(middleware);
    assert.equal(retained.status, 200);
    assert.equal(retained.body.stale, true);
    assert.equal(retained.body.degraded, true);
    assert.equal(
      retained.body.acceptedGeneration,
      first.body.acceptedGeneration,
    );
    assert.deepEqual(retained.body.stations, first.body.stations);
    failed = false;
    const recovered = await invoke(middleware);
    assert.equal(recovered.body.stale, false);
    assert.equal(recovered.body.degraded, false);
    assert.equal(
      recovered.body.acceptedGeneration,
      first.body.acceptedGeneration + 1,
    );
  },
);

test(
  'an empty discovery response is cached while known mirrors serve the complete catalogue',
  { timeout: 2000 },
  async () => {
    let discoveries = 0;
    const middleware = create({
      fetchImpl: async (url) => {
        if (url.includes('/json/servers')) {
          discoveries++;
          return json([]);
        }
        return json(rows(url));
      },
    });
    const result = await invoke(middleware);
    assert.equal(result.body.degraded, false);
    assert.equal(discoveries, 1);
  },
);
