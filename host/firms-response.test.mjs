import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { firmsProxy, prepareFirmsJson } from '../server/providers/firms.js';

const fullSnapshot = {
  fetchedAt: 1800000000000,
  stale: false,
  ttlMs: 1800000,
  sources: [{ source: 'VIIRS_NOAA20_NRT', count: 26000, ok: true }],
  count: 26000,
  fires: Array.from({ length: 26000 }, (_, index) => ({
    lat: 30 + index / 100000,
    lon: -97 + index / 100000,
    frp: 10,
    confidence: 'h',
    brightness: 310,
    brightnessTi5: 299,
    daynight: 'D',
    acqDate: '2026-09-12',
    acqTime: '1200',
    satellite: 'NOAA-20',
    instrument: 'VIIRS',
  })),
};
assert.ok(Buffer.byteLength(JSON.stringify(fullSnapshot)) > 4 * 1024 * 1024);

test('serverless gzip carries every fire record and its metadata losslessly below the response ceiling', async () => {
  const response = await prepareFirmsJson(200, fullSnapshot, {
    serverless: true,
    acceptEncoding: 'br, gzip, deflate',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Encoding'], 'gzip');
  assert.equal(response.headers.Vary, 'Accept-Encoding');
  assert.ok(response.body.byteLength < 4 * 1024 * 1024);
  assert.equal(
    Number(response.headers['Content-Length']),
    response.body.byteLength,
  );
  assert.deepEqual(JSON.parse(gunzipSync(response.body)), fullSnapshot);
});

test('persistent hosting retains the complete uncompressed fire response without a serverless ceiling', async () => {
  const response = await prepareFirmsJson(200, fullSnapshot, {
    serverless: false,
    acceptEncoding: 'gzip',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Encoding'], undefined);
  assert.ok(response.body.byteLength > 4 * 1024 * 1024);
  assert.deepEqual(JSON.parse(response.body), fullSnapshot);
});

for (const acceptEncoding of [
  '',
  'identity',
  'gzip;q=0',
  'gzip;q=0, *;q=1',
  'gzip;q=invalid',
]) {
  test(`oversized uncompressed response with ${acceptEncoding || 'no accepted encoding'} returns actionable service error without truncating`, async () => {
    const response = await prepareFirmsJson(200, fullSnapshot, {
      serverless: true,
      acceptEncoding,
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers['Content-Encoding'], undefined);
    assert.ok(response.body.byteLength < 1024);
    const payload = JSON.parse(response.body);
    assert.equal(payload.code, 'FIRMS_PERSISTENT_HOST_REQUIRED');
    assert.equal(payload.count, fullSnapshot.count);
    assert.match(payload.message, /persistent Node deployment/);
    assert.equal(
      payload.fires,
      undefined,
      'an error cannot masquerade as a partial successful catalogue',
    );
  });
}

test('an accepted wildcard can carry a complete gzip catalogue', async () => {
  const response = await prepareFirmsJson(200, fullSnapshot, {
    serverless: true,
    acceptEncoding: '*;q=0.5',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Encoding'], 'gzip');
  assert.deepEqual(JSON.parse(gunzipSync(response.body)), fullSnapshot);
});

test('actual compressed bytes are checked even when an unexpected CSV text field is effectively incompressible', async () => {
  const record = {
    ...fullSnapshot.fires[0],
    instrument: randomBytes(6 * 1024 * 1024).toString('base64'),
  };
  const response = await prepareFirmsJson(
    200,
    { ...fullSnapshot, count: 1, fires: [record] },
    { serverless: true, acceptEncoding: 'gzip' },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers['Content-Encoding'], undefined);
  assert.equal(
    JSON.parse(response.body).code,
    'FIRMS_PERSISTENT_HOST_REQUIRED',
  );
  assert.equal(JSON.parse(response.body).count, 1);
  assert.ok(response.body.byteLength < 1024);
});

test('small optional-provider errors retain their original status and contract', async () => {
  const response = await prepareFirmsJson(
    503,
    { error: 'no_key' },
    { serverless: true, acceptEncoding: 'gzip' },
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers['Content-Encoding'], undefined);
  assert.deepEqual(JSON.parse(response.body), { error: 'no_key' });
});

test('FIRMS bounds upstream CSV and quota responses before retaining oversized bodies', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'gev-firms-bounds-'));
  const previous = process.cwd();
  const originalKey = process.env.FIRMS_MAP_KEY;
  process.chdir(root);
  process.env.FIRMS_MAP_KEY = 'fixture-key';
  t.after(async () => {
    process.chdir(previous);
    if (originalKey === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = originalKey;
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(console, 'warn', () => {});
  let cancelled = 0;
  let pulled = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(options.signal);
    const limit = String(url).includes('mapkey_status')
      ? 65 * 1024
      : 33 * 1024 * 1024;
    return new Response(
      new ReadableStream(
        {
          pull() {
            pulled++;
          },
          cancel() {
            cancelled++;
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { 'Content-Length': String(limit) } },
    );
  });
  let handler;
  firmsProxy().configurePreviewServer({
    middlewares: {
      use(_route, middleware) {
        handler = middleware;
      },
    },
  });
  async function request(url) {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url, method: 'GET', headers: {} }, res);
    return res;
  }
  const snapshot = await request('/');
  assert.equal(snapshot.status, 502);
  assert.equal(cancelled, 3);
  const quota = await request('/status');
  assert.equal(quota.status, 200);
  assert.equal(JSON.parse(quota.body).transactions, null);
  assert.equal(cancelled, 4);
  assert.equal(pulled, 0);
});
