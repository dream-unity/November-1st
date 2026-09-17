import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTrafficReportsMiddleware } from '../../server/providers/traffic-reports.js';

const timestamp = Date.parse('2026-09-17T02:00:00Z');
const iso = new Date(timestamp).toISOString();
const active = {
  traffic_report_id: '1',
  issue_reported: 'Collision',
  traffic_report_status: 'ACTIVE',
  traffic_report_status_date_time: iso,
  published_date: iso,
  latitude: '30',
  longitude: '-97',
};
function call(middleware, url = '/reports?region=austin', method = 'GET') {
  return new Promise((resolve, reject) => {
    let status, headers;
    const res = {
      writeHead(s, h) {
        status = s;
        headers = h;
      },
      end(body) {
        resolve({ status, headers, body: body ? JSON.parse(body) : null });
      },
    };
    Promise.resolve(middleware({ url, method }, res)).catch(reject);
  });
}
function fixture({ future = false } = {}) {
  let time = timestamp;
  let failure = false;
  let requests = 0;
  const middleware = createTrafficReportsMiddleware({
    now: () => time,
    fetchImpl: async (url) => {
      requests++;
      if (failure)
        throw new Error('Private upstream URL and key must not be exposed');
      return Response.json(
        url.includes('/api/views/')
          ? { rowsUpdatedAt: (time + (future ? 600_000 : 0)) / 1000 }
          : [active],
      );
    },
  });
  return {
    middleware,
    fail() {
      failure = true;
    },
    advance(ms) {
      time += ms;
    },
    get requests() {
      return requests;
    },
  };
}
test('concurrent clients coalesce and fresh cache avoids repeated public API calls', async () => {
  const fx = fixture();
  const results = await Promise.all([
    call(fx.middleware),
    call(fx.middleware),
    call(fx.middleware),
  ]);
  assert.equal(fx.requests, 2);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.stale, false);
    assert.equal(result.body.reports.length, 1);
  }
});
test('upstream outage retains bounded stale data and then explicitly expires it', async () => {
  const fx = fixture();
  await call(fx.middleware);
  fx.advance(61_000);
  fx.fail();
  const stale = await call(fx.middleware);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.fetchedAt, iso);
  assert.equal(stale.body.sourceUpdatedAt, iso);
  assert.match(stale.body.message, /Refresh failed/);
  const requests = fx.requests;
  await call(fx.middleware);
  assert.equal(fx.requests, requests, 'outage retries are bounded');
  fx.advance(16 * 60_000);
  assert.equal((await call(fx.middleware)).status, 503);
});
test('arbitrary region, URL parameters, duplicates and mutation methods make no outbound request', async () => {
  const fx = fixture();
  for (const url of [
    '/reports?region=https://localhost',
    '/reports?region=austin&url=https://localhost',
    '/reports?region=austin&region=finland',
  ])
    assert.equal((await call(fx.middleware, url)).status, 400);
  assert.equal((await call(fx.middleware, '/reports', 'POST')).status, 405);
  assert.equal((await call(fx.middleware, '/missing')).status, 404);
  assert.equal(fx.requests, 0);
});
test('region catalogue and HEAD have correct response semantics', async () => {
  const fx = fixture();
  const regions = await call(fx.middleware, '/regions');
  assert.deepEqual(
    regions.body.regions.map((region) => region.id),
    ['austin', 'finland'],
  );
  assert.equal((await call(fx.middleware, '/regions', 'HEAD')).body, null);
  assert.equal(fx.requests, 0);
});
test('future source metadata is rejected and private failure details stay private', async () => {
  const fx = fixture({ future: true });
  const result = await call(fx.middleware);
  assert.equal(result.status, 503);
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /Private|key|https:\/\/localhost/,
  );
});
test('HTTP 200 with frozen Austin dataset is explicitly stale', async () => {
  const middleware = createTrafficReportsMiddleware({
    now: () => timestamp,
    fetchImpl: async (url) =>
      Response.json(
        url.includes('/api/views/')
          ? { rowsUpdatedAt: (timestamp - 30 * 60_000) / 1000 }
          : [active],
      ),
  });
  const result = await call(middleware);
  assert.equal(result.body.stale, true);
  assert.match(result.body.message, /authority has not updated/);
});
test('Finland rejects a frozen or missing category timestamp rather than masking it with a fresh peer', async () => {
  for (const missing of [false, true]) {
    const middleware = createTrafficReportsMiddleware({
      now: () => timestamp,
      fetchImpl: async (url, init) => {
        assert.equal(init.headers['Accept-Encoding'], 'gzip');
        return Response.json({
          type: 'FeatureCollection',
          features: [],
          dataUpdatedTime: url.endsWith('roadworks')
            ? missing
              ? null
              : new Date(timestamp - 30 * 60_000).toISOString()
            : iso,
        });
      },
    });
    const result = await call(middleware, '/reports?region=finland');
    assert.equal(result.status, missing ? 503 : 200);
    if (!missing) assert.equal(result.body.stale, true);
  }
});
test('oversized or error-shaped HTTP 200 cannot become an empty successful feed', async () => {
  for (const response of [
    () => Response.json({ error: 'bad schema' }),
    () =>
      new Response('{}', {
        headers: { 'content-length': String(13 * 1024 * 1024) },
      }),
  ]) {
    const middleware = createTrafficReportsMiddleware({
      now: () => timestamp,
      fetchImpl: async () => response(),
    });
    assert.equal((await call(middleware)).status, 503);
  }
});
