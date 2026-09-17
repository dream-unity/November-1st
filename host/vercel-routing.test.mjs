import test from 'node:test';
import assert from 'node:assert/strict';
import { originalProviderRequestUrl } from './vercel-routing.mjs';
import { createTrafficReportsMiddleware } from '../server/providers/traffic-reports.js';

test('Vercel capture is removed without changing application values or the raw request path', () => {
  assert.equal(
    originalProviderRequestUrl(
      '/api/traffic/reports?path=traffic%2Freports&region=austin',
    ),
    '/api/traffic/reports?region=austin',
  );
  assert.equal(
    originalProviderRequestUrl(
      '/api/traffic/reports?region=finland&path=traffic%2Freports',
    ),
    '/api/traffic/reports?region=finland',
  );
  assert.equal(
    originalProviderRequestUrl('/api/radio/stations?path=radio%2Fstations'),
    '/api/radio/stations',
  );
  const result = originalProviderRequestUrl(
    '/api/test?path=test&value=a%2Bb%26c&value=&empty=',
  );
  assert.deepEqual(
    [...new URLSearchParams(result.split('?')[1])],
    [
      ['value', 'a+b&c'],
      ['value', ''],
      ['empty', ''],
    ],
  );
  assert.equal(
    originalProviderRequestUrl('/api/a/../test?path=a%2F..%2Ftest'),
    '/api/a/../test',
    'path validation remains the host security layer’s job',
  );
});

test('unrelated, malformed and duplicate path parameters remain subject to normal provider validation', () => {
  for (const url of [
    '/api/traffic/reports?path=other&region=austin',
    '/api/traffic/reports?path=traffic/reports&path=other',
    '/api/%zz?path=test',
    '//api/test?path=test',
    '/api/test?unknown=value',
    '/api/test',
  ])
    assert.equal(originalProviderRequestUrl(url), url);
});

test('a platform-rewritten traffic request reaches the official provider while arbitrary parameters still fail', async () => {
  const now = Date.now();
  let calls = 0;
  const middleware = createTrafficReportsMiddleware({
    now: () => now,
    fetchImpl: async (url) => {
      calls++;
      return Response.json(
        url.includes('/api/views/')
          ? { rowsUpdatedAt: Math.floor(now / 1000) }
          : [],
      );
    },
  });
  async function request(url) {
    let status, body;
    await middleware(
      {
        url: originalProviderRequestUrl(url).slice('/api/traffic'.length),
        method: 'GET',
      },
      {
        writeHead(code) {
          status = code;
        },
        end(value) {
          body = JSON.parse(value);
        },
      },
    );
    return { status, body };
  }
  const accepted = await request(
    '/api/traffic/reports?path=traffic%2Freports&region=austin',
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.region.id, 'austin');
  assert.equal(calls, 2);
  assert.equal(
    (
      await request(
        '/api/traffic/reports?path=traffic%2Freports&region=austin&url=https://attacker.invalid',
      )
    ).status,
    400,
  );
  assert.equal(calls, 2);
});
