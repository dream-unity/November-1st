import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gbfsProxy } from '../server/providers/gbfs.js';
import { adsbdbProxy } from '../server/providers/aircraft/enrichment.js';
import { adsbLolProxy } from '../server/providers/aircraft/adsb-lol.js';
import { trackBackfillProxies } from '../server/providers/aircraft/tracks.js';
import { googlePlacesContextProxy } from '../server/providers/places/google.js';
import { terrainHeightsProxy } from '../server/providers/terrain.js';
import { fetchOverpassPayload } from '../server/providers/overpass/transport.js';

function install(plugin) {
  const routes = new Map();
  plugin.configurePreviewServer({
    middlewares: { use: (route, handler) => routes.set(route, handler) },
  });
  return async (route, url = '/', method = 'GET') => {
    const response = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers || {}))
          this.setHeader(name, value);
      },
      end(body) {
        this.body = String(body);
      },
    };
    await routes.get(route)({ url, method }, response);
    return response;
  };
}

async function isolatedOpenSky(t) {
  const old = process.env.OPENSKY_AUTH_MODE;
  process.env.OPENSKY_AUTH_MODE = 'anon';
  t.after(() =>
    old === undefined
      ? delete process.env.OPENSKY_AUTH_MODE
      : (process.env.OPENSKY_AUTH_MODE = old),
  );
  const module = await import(
    `../server/providers/aircraft/opensky.js?audit=${Math.random()}`
  );
  return install(module.openSkyProxy());
}

test('OpenSky absent quota headers retain normal freshness and concurrent viewers share one acquisition', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls++;
    assert.ok(options.signal, 'acquisition must have a deadline');
    await Promise.resolve();
    return Response.json({ time: Math.floor(now / 1000), states: [] });
  });
  const request = await isolatedOpenSky(t);
  const responses = await Promise.all(
    Array.from({ length: 3 }, () => request('/api/opensky')),
  );
  assert.ok(responses.every((response) => response.statusCode === 200));
  assert.equal(calls, 1);
  now += 10000;
  await request('/api/opensky');
  assert.equal(
    calls,
    2,
    'absence of a quota header must not become a zero-credit five-minute cache',
  );
});

test('OpenSky rejects malformed successful snapshots and keeps a usable cache after HTTP503', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  let reply = () => new Response('<html>maintenance</html>');
  t.mock.method(globalThis, 'fetch', async () => reply());
  const request = await isolatedOpenSky(t);
  assert.equal((await request('/api/opensky')).statusCode, 502);
  reply = () => Response.json({ time: Math.floor(now / 1000), states: [] });
  const first = await request('/api/opensky');
  now += 10000;
  reply = () => new Response('unavailable', { status: 503 });
  const fallback = await request('/api/opensky');
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.headers['x-opensky-cache'], 'STALE');
  assert.equal(fallback.body, first.body);
});

test('military aircraft coalesce viewers and do not replace the last snapshot with malformed HTTP200 data', async (t) => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.ok(options.signal);
    calls++;
    await Promise.resolve();
    return calls === 1
      ? Response.json({ ac: [{ hex: 'abc123' }] })
      : Response.json({ error: 'outage' });
  });
  const request = install(adsbLolProxy());
  const [a, b] = await Promise.all([
    request('/api/adsblol/mil'),
    request('/api/adsblol/mil'),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.body, b.body);
  now += 13000;
  const stale = await request('/api/adsblol/mil');
  assert.equal(stale.body, a.body);
  assert.equal(stale.headers['x-ads-b-cache'], 'STALE');
  await request('/api/adsblol/mil');
  assert.equal(
    calls,
    2,
    'failed acquisition backs off instead of hammering the source',
  );
});

test('track history rejects oversized and malformed successful responses without caching an error as HTTP200', async (t) => {
  let mode = 'oversized';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 'oversized')
      return new Response('{}', {
        headers: { 'content-length': String(5 * 1024 * 1024) },
      });
    if (mode === 'malformed') return Response.json({ error: 'maintenance' });
    return Response.json({ trace: [[1, 2, 3]] });
  });
  const request = install(trackBackfillProxies());
  assert.equal(
    (await request('/api/adsblol/trace', '?hex=abc123')).statusCode,
    502,
  );
  mode = 'malformed';
  assert.equal(
    (await request('/api/adsblol/trace', '?hex=abc123')).statusCode,
    502,
  );
  mode = 'valid';
  assert.equal(
    (await request('/api/adsblol/trace', '?hex=abc123')).statusCode,
    200,
  );
  assert.equal(
    calls,
    3,
    'transient failures cannot poison the one-minute history cache',
  );
  assert.equal(
    (await request('/api/adsblol/trace', '?hex=a~c123')).statusCode,
    400,
  );
});

test('Google Places bounds acquisition and reports invalid JSON without caching it as an empty success or exposing upstream detail', async () => {
  const request = install(
    googlePlacesContextProxy({
      resolveApiKey: () => 'test-only-key',
      fetchImpl: async (_url, options) => {
        assert.ok(options.signal);
        return new Response('<html>private provider error</html>');
      },
    }),
  );
  for (const route of [
    '/api/google/nearby-places',
    '/api/google/text-search',
  ]) {
    const res = await request(route, '?lat=30&lon=-97&q=museum');
    assert.equal(res.statusCode, 502);
    assert.deepEqual(JSON.parse(res.body).places, []);
    assert.doesNotMatch(res.body, /private provider|test-only-key/);
  }
});

test('terrain rejects missing and impossible coordinates and cannot exceed its total server budget', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-terrain-audit-'));
  const previous = process.cwd();
  process.chdir(root);
  t.after(async () => {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  });
  const request = install(terrainHeightsProxy());
  let calls = 0;
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    now += 40000;
    const count = new URL(url).searchParams.get('points').split(';').length;
    return Response.json({
      results: Array.from({ length: count }, () => ({ ellipsoid: 10 })),
    });
  });
  for (const points of ['181,0', '0,91', ',0', '1,']) {
    assert.equal(
      (await request('/api/terrain/heights', `?points=${points}`)).statusCode,
      400,
    );
  }
  assert.equal(calls, 0);
  const points = Array.from(
    { length: 2000 },
    (_, i) => `${-100 + i / 1000},40`,
  ).join(';');
  const bounded = await request('/api/terrain/heights', `?points=${points}`);
  assert.equal(bounded.statusCode, 502);
  assert.equal(
    calls,
    6,
    'remaining chunks return incomplete data instead of running past platform duration',
  );
  assert.equal(
    (await request('/api/terrain/heights', `?points=${points};1,1`)).statusCode,
    400,
  );
});

test('Overpass rotates past malformed HTTP200 HTML instead of caching an empty map', async () => {
  const endpoints = [
    'https://example.invalid/one',
    'https://example.invalid/two',
  ];
  const calls = [];
  const response = await fetchOverpassPayload('data=fixture', 10000, {
    endpoints,
    fetchImpl: async (url) => {
      calls.push(url);
      return calls.length === 1
        ? new Response('<html>maintenance</html>')
        : Response.json({ elements: [] });
    },
  });
  assert.deepEqual(calls, endpoints);
  assert.deepEqual(JSON.parse(response.body), { elements: [] });
});

test('old source timestamps remain explicitly stale even when freshly fetched and no regional anchor is available', async (t) => {
  const now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ time: now / 1000 - 600, states: [] }),
  );
  const request = await isolatedOpenSky(t);
  for (let i = 0; i < 2; i++) {
    const response = await request('/api/opensky');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-opensky-cache'], 'STALE');
    assert.equal(response.headers['x-opensky-stale-seconds'], '600');
  }
});

test('bikeshare rejects invalid successful feeds and never caches upstream error pages', async (t) => {
  t.mock.method(console, 'error', () => {});
  let mode = 'failure';
  t.mock.method(globalThis, 'fetch', async () =>
    mode === 'failure'
      ? new Response('maintenance', { status: 503 })
      : Response.json({ error: 'broken feed' }),
  );
  const request = install(gbfsProxy());
  const url =
    '/' + encodeURIComponent('https://gbfs.lyft.com/station_information.json');
  const failure = await request('/api/gbfs', url);
  assert.equal(failure.statusCode, 503);
  assert.equal(failure.headers['cache-control'], 'no-store');
  mode = 'malformed';
  assert.equal((await request('/api/gbfs', url)).statusCode, 502);
});

test('aircraft metadata survives a failed refresh after its cache expires', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-enrichment-audit-'));
  const previous = process.cwd();
  process.chdir(root);
  t.after(async () => {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  });
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1
      ? Response.json({
          response: { aircraft: { icao_type: 'A320', registration: 'TEST' } },
        })
      : new Response('outage', { status: 503 }),
  );
  const request = install(adsbdbProxy());
  const first = await request('/api/adsbdb', '/type/abc123');
  now += 25 * 3600000;
  const fallback = await request('/api/adsbdb', '/type/abc123');
  assert.equal(JSON.parse(first.body).found, true);
  assert.equal(fallback.body, first.body);
});
