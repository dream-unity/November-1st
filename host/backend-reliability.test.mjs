import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProductionHost } from './application.mjs';
import { readHostConfig } from './config.mjs';
import { openAiRealtimeProxy } from '../server/providers/openai.js';
import { handleHudSummary } from '../server/providers/openai/hud-summary.js';
import { configuredCredential } from '../server/providers/openai/status.js';

async function hostFixture(
  t,
  { env = {}, providerPlugins = [], metadata } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-reliability-'));
  const distDir = path.join(dir, 'dist');
  await mkdir(distDir);
  if (metadata)
    await writeFile(
      path.join(distDir, 'build-info.json'),
      JSON.stringify(metadata),
    );
  const host = await createProductionHost({
    env,
    providerPlugins,
    serveStatic: false,
    config: { ...readHostConfig(env, 'serverless'), stateDir: dir, distDir },
  });
  const server = createServer(host.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await host.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { get: (url, init) => fetch(`${origin}${url}`, init) };
}

function valueEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test('voice preflight is free, explicit, and never reveals or tests credentials', async (t) => {
  let calls = 0;
  for (const key of [
    '',
    'your_api_key_here',
    'replace_me',
    'example',
    '<secret>',
    '  ',
  ]) {
    const { get } = await hostFixture(t, {
      env: { OPENAI_API_KEY: key },
      providerPlugins: [
        openAiRealtimeProxy({
          realtime: {
            resolveApiKey: () => key,
            fetchImpl: () => {
              calls++;
              throw new Error('must not contact provider');
            },
          },
        }),
      ],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const status = await get('/api/realtime/status?tier=mini');
      assert.equal(status.status, 200);
      assert.equal(status.headers.get('cache-control'), 'no-store');
      const payload = await status.json();
      assert.equal(payload.available, false);
      assert.equal(payload.code, 'VOICE_NOT_CONFIGURED');
      const token = await get('/api/realtime/token');
      assert.equal(token.status, 503);
      assert.equal((await token.json()).code, 'VOICE_NOT_CONFIGURED');
    }
  }
  assert.equal(calls, 0);
});

test('credential presence rejects templates and embedded whitespace without guessing provider validity', () => {
  for (const key of [
    'your_key_here',
    'replace_key',
    'changeme',
    '<YOUR_KEY>',
    'key with spaces',
    'key\nnewline',
  ])
    assert.equal(configuredCredential(key), false, key);
  assert.equal(configuredCredential(' fixture-real-format '), true);
});

test('real-only camera snapshots stay public when optional paid Street View is configured', async (t) => {
  let calls = 0;
  const { get } = await hostFixture(t, {
    env: { GOOGLE_MAPS_SERVER_API_KEY: 'fixture-google-key' },
    providerPlugins: [
      {
        name: 'camera-snapshot-fixture',
        configurePreviewServer(server) {
          server.middlewares.use('/api/cctv/frame', (_req, res) => {
            calls++;
            res.writeHead(204);
            res.end();
          });
        },
      },
    ],
  });
  assert.equal((await get('/api/cctv/frame/camera?strict=1')).status, 204);
  for (const query of ['', '?strict=0', '?strict=0&strict=1'])
    assert.equal((await get(`/api/cctv/frame/camera${query}`)).status, 403);
  assert.equal(
    calls,
    1,
    'only requests that cannot call the paid fallback reach the provider',
  );
});

test('voice status and capability access reflect the caller and do not consume paid quota', async (t) => {
  const env = {
    OPENAI_API_KEY: 'fixture-private-key',
    GEV_SERVICE_TOKEN: 'fixture-access',
    GEV_PAID_REQUESTS_PER_MINUTE: '1',
  };
  let calls = 0;
  const { get } = await hostFixture(t, {
    env,
    providerPlugins: [
      openAiRealtimeProxy({
        realtime: {
          resolveApiKey: () => env.OPENAI_API_KEY,
          fetchImpl: async () => {
            calls++;
            return Response.json({ value: 'fixture-short-lived-secret' });
          },
        },
      }),
    ],
  });
  assert.equal(
    (await (await get('/api/realtime/status')).json()).code,
    'VOICE_AUTH_REQUIRED',
  );
  const capabilities = await (await get('/api/capabilities')).json();
  assert.equal(
    capabilities.providers.find((provider) => provider.id === 'voice').status,
    'protected',
  );
  const headers = { Authorization: 'Bearer fixture-access' };
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(
      (await (await get('/api/realtime/status', { headers })).json()).available,
      true,
    );
  }
  assert.equal(calls, 0);
  assert.equal((await get('/api/realtime/token', { headers })).status, 200);
  const limited = await get('/api/realtime/token', { headers });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, 'VOICE_RATE_LIMITED');
  assert.equal(calls, 1);
});

test('Basic-protected voice preflight can explain access without creating a session or login loop', async (t) => {
  const env = {
    OPENAI_API_KEY: 'fixture-private-key',
    GEV_BASIC_AUTH_PASSWORD: 'fixture-pass',
  };
  const { get } = await hostFixture(t, { env });
  const status = await get('/api/realtime/status');
  assert.equal(status.status, 200);
  assert.equal((await status.json()).code, 'VOICE_AUTH_REQUIRED');
  assert.equal((await get('/api/realtime/token')).status, 401);
  const headers = {
    Authorization: `Basic ${Buffer.from('dream-unity:fixture-pass').toString('base64')}`,
  };
  assert.equal(
    (await (await get('/api/realtime/status', { headers })).json()).available,
    true,
  );
});

test('exact voice route checks reject suffixes before paid provider calls', async (t) => {
  let calls = 0;
  const env = { OPENAI_API_KEY: 'fixture-key', GEV_ALLOW_PAID_PUBLIC: '1' };
  const { get } = await hostFixture(t, {
    env,
    providerPlugins: [
      openAiRealtimeProxy({
        realtime: {
          resolveApiKey: () => env.OPENAI_API_KEY,
          fetchImpl: () => {
            calls++;
            throw new Error('not expected');
          },
        },
      }),
    ],
  });
  for (const route of [
    '/api/realtime/token.extra',
    '/api/realtime/token/extra',
    '/api/realtime/status/extra',
    '/api/openai/hud-summary/extra',
  ]) {
    assert.equal((await get(route)).status, 404, route);
  }
  assert.equal(
    (await get('/api/realtime/status', { method: 'POST' })).status,
    405,
  );
  assert.equal(calls, 0);
});

test('Realtime provider errors have accurate actions and cannot reflect provider secrets', async (t) => {
  const cases = [
    [401, {}, 'VOICE_PROVIDER_ACCESS_DENIED', 502],
    [403, {}, 'VOICE_PROVIDER_ACCESS_DENIED', 502],
    [429, { code: 'insufficient_quota' }, 'VOICE_QUOTA_EXHAUSTED', 429],
    [429, {}, 'VOICE_RATE_LIMITED', 429],
    [400, {}, 'VOICE_CONFIGURATION_ERROR', 502],
    [500, {}, 'VOICE_PROVIDER_UNAVAILABLE', 502],
    [200, {}, 'VOICE_INVALID_RESPONSE', 502],
  ];
  for (const [status, error, code, responseStatus] of cases) {
    const { get } = await hostFixture(t, {
      env: { OPENAI_API_KEY: 'fixture-key', GEV_ALLOW_PAID_PUBLIC: '1' },
      providerPlugins: [
        openAiRealtimeProxy({
          realtime: {
            resolveApiKey: () => 'fixture-key',
            fetchImpl: async () =>
              Response.json(
                { error: { ...error, message: 'secret-key-DO-NOT-REFLECT' } },
                { status },
              ),
          },
        }),
      ],
    });
    const response = await get('/api/realtime/token');
    assert.equal(response.status, responseStatus);
    const body = await response.text();
    assert.equal(JSON.parse(body).code, code);
    assert.doesNotMatch(body, /DO-NOT-REFLECT/);
  }
});

test('HUD rejects invalid and oversized JSON without calling a paid provider or dropping the response', async (t) => {
  valueEnv(t, 'OPENAI_API_KEY', 'fixture-key');
  let calls = 0;
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:'))
      return realFetch(url, options);
    calls++;
    return Promise.resolve(Response.json({ output_text: '' }));
  });
  const { get } = await hostFixture(t, {
    env: { OPENAI_API_KEY: 'fixture-key', GEV_ALLOW_PAID_PUBLIC: '1' },
    providerPlugins: [
      {
        name: 'hud-only',
        configurePreviewServer(server) {
          server.middlewares.use('/api/openai/hud-summary', handleHudSummary);
        },
      },
    ],
  });
  for (const [body, status] of [
    ['{', 400],
    ['null', 400],
    ['[]', 400],
    [JSON.stringify({ text: 'x'.repeat(66000) }), 413],
  ]) {
    const response = await get('/api/openai/hud-summary', {
      method: 'POST',
      body,
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal(calls, 0);
  const empty = await get('/api/openai/hud-summary', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(empty.status, 502);
  assert.equal((await empty.json()).code, 'HUD_INVALID_RESPONSE');
  assert.equal(calls, 1);
});

test('health identifies the built commit when deployment environment omits it', async (t) => {
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const { get } = await hostFixture(t, { metadata: { commit } });
  assert.equal((await (await get('/api/health')).json()).commit, commit);
});

test('Realtime rejects empty tokens and caps both declared and streamed upstream responses', async (t) => {
  for (const payload of [
    { value: '' },
    { value: '   ' },
    { value: 'line\nbreak' },
    { value: 123 },
    { value: 'x'.repeat(4097) },
  ]) {
    const { get } = await hostFixture(t, {
      env: { OPENAI_API_KEY: 'fixture-key', GEV_ALLOW_PAID_PUBLIC: '1' },
      providerPlugins: [
        openAiRealtimeProxy({
          realtime: {
            resolveApiKey: () => 'fixture-key',
            fetchImpl: async () => Response.json(payload),
          },
        }),
      ],
    });
    const response = await get('/api/realtime/token');
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'VOICE_INVALID_RESPONSE');
  }
  for (const declared of [true, false]) {
    let canceled = false;
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(260 * 1024));
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: declared ? { 'Content-Length': String(260 * 1024) } : {} },
    );
    const { get } = await hostFixture(t, {
      env: { OPENAI_API_KEY: 'fixture-key', GEV_ALLOW_PAID_PUBLIC: '1' },
      providerPlugins: [
        openAiRealtimeProxy({
          realtime: {
            resolveApiKey: () => 'fixture-key',
            fetchImpl: async () => upstream,
          },
        }),
      ],
    });
    const response = await get('/api/realtime/token');
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, 'VOICE_INVALID_RESPONSE');
    assert.equal(canceled, true);
  }
});

test('cross-site requests cannot spend through cached browser Basic credentials', async (t) => {
  const env = {
    OPENAI_API_KEY: 'fixture-key',
    GEV_BASIC_AUTH_PASSWORD: 'fixture-pass',
  };
  let called = false;
  const { get } = await hostFixture(t, {
    env,
    providerPlugins: [
      {
        name: 'token-fixture',
        configurePreviewServer(server) {
          server.middlewares.use('/api/realtime/token', (req, res) => {
            called = true;
            res.end('{}');
          });
        },
      },
    ],
  });
  const headers = {
    Authorization: `Basic ${Buffer.from('dream-unity:fixture-pass').toString('base64')}`,
    'Sec-Fetch-Site': 'cross-site',
  };
  const response = await get('/api/realtime/token', { headers });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'PROVIDER_CROSS_SITE_BLOCKED');
  assert.equal(called, false);
  assert.equal(
    (
      await get('/api/realtime/token', {
        headers: { Authorization: headers.Authorization },
      })
    ).status,
    200,
  );
  assert.equal(called, true);
});

test('HUD oversized-body drain handles a sender disconnect without an uncaught error', async (t) => {
  valueEnv(t, 'OPENAI_API_KEY', 'fixture-key');
  const request = new PassThrough();
  request.method = 'POST';
  request.headers = {};
  const response = {
    setHeader() {},
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  const completed = handleHudSummary(request, response);
  request.write(Buffer.alloc(66 * 1024));
  request.destroy(new Error('sender disconnected during oversized body drain'));
  await completed;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.statusCode, 413);
  assert.equal(response.body.code, 'BODY_TOO_LARGE');
  assert.equal(request.listenerCount('error'), 0);
});

test('Google fallback credentials remain protected when a server-key override is whitespace', async (t) => {
  const { get } = await hostFixture(t, {
    env: {
      GOOGLE_MAPS_SERVER_API_KEY: '   ',
      GOOGLE_MAPS_API_KEY: 'fixture-browser-key',
    },
  });
  for (const route of [
    '/api/google/nearby-places',
    '/api/cctv/frame/fixture',
  ]) {
    const response = await get(route);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'PROVIDER_AUTH_REQUIRED');
  }
});
