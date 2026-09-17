import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readHostConfig, capabilityReport } from './config.mjs';
import { createProductionHost } from './application.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-host-test-'));
  const dist = path.join(dir, 'dist');
  await mkdir(dist);
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Globe</title>');
  const config = { ...readHostConfig({}, 'serverless'), distDir: dist, stateDir: dir, ...options.config };
  const host = await createProductionHost({ providerPlugins: [], ...options, config });
  const server = createServer(host.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await host.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, dist, host, origin, get: (url, init) => fetch(`${origin}${url}`, init) };
}

test('capability configuration never exposes secrets or claims live availability', () => {
  const env = { OPENAI_API_KEY: 'test-secret-not-a-real-key', AISSTREAM_API_KEY: 'vessel-secret' };
  const report = capabilityReport(readHostConfig(env, 'serverless'), env);
  assert.equal(report.providers.find((p) => p.id === 'voice').status, 'protected');
  assert.equal(report.providers.find((p) => p.id === 'vessels').status, 'requires-persistent-service');
  assert.equal(report.providers.find((p) => p.id === 'radio').status, 'keyless');
  assert.doesNotMatch(JSON.stringify(report), /test-secret|vessel-secret/);
  assert.match(report.note, /Configuration status only/);
  assert.match(report.state, /not coordinated/);
  const directGoogle = capabilityReport(readHostConfig({}, 'serverless'), { GOOGLE_MAPS_API_KEY: 'not-a-real-key' });
  assert.equal(directGoogle.providers.find((p) => p.id === 'photorealistic').status, 'configured');
});

test('host reports mount status, mounts stripped-prefix provider middleware, closes once', async (t) => {
  let closed = 0;
  const plugin = {
    name: 'test-provider',
    configurePreviewServer(server) {
      server.middlewares.use('/api/provider', (req, res) => res.end(req.url));
    },
    closeBundle() { closed++; },
  };
  const { get, host } = await fixture(t, { providerPlugins: [plugin] });
  assert.equal(await (await get('/api/provider/item?x=1')).text(), '/item?x=1');
  const health = await (await get('/api/health')).json();
  assert.deepEqual(health.providersMounted, ['test-provider']);
  assert.equal(health.runtime, 'serverless');
  assert.match(health.note, /does not establish/);
  assert.equal((await get('/api/health/other')).status, 404);
  await host.close(); await host.close(); assert.equal(closed, 1);
});

test('built HTML is served but unknown API, source, dotfile, and symlink escape are not', async (t) => {
  const { get, dir, dist } = await fixture(t);
  await writeFile(path.join(dir, 'secret.txt'), 'PRIVATE');
  await writeFile(path.join(dist, '.env'), 'PRIVATE');
  await symlink(path.join(dir, 'secret.txt'), path.join(dist, 'escaped.txt'));
  assert.match(await (await get('/')).text(), /<title>Globe/);
  const head = await get('/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const url of ['/api/not-real', '/src/main.js', '/.env', '/escaped.txt']) {
    const response = await get(url);
    assert.equal(response.status, 404, url);
    assert.doesNotMatch(await response.text(), /PRIVATE|<title>/);
  }
  assert.equal((await get('/%2e%2e%2fsecret.txt')).status, 400);
});

test('host never exposes the credential editor or conversation writer', async (t) => {
  let called = false;
  const { get } = await fixture(t, { providerPlugins: [{ name: 'upstream-sensitive-routes', configurePreviewServer(server) {
    server.middlewares.use('/api/setup/keys', (req, res) => { called = true; res.end('unsafe'); });
    server.middlewares.use('/api/realtime/debug-log', (req, res) => { called = true; res.end('unsafe'); });
  } }] });
  for (const url of ['/api/setup/keys', '/api/setup/status', '/api/realtime/debug-log', '/api/realtime/debug-log/extra', '/API/realtime/debug-log', '/API/realtime/debug-log.extra']) {
    assert.equal((await get(url, { method: 'POST', body: '{}' })).status, 404);
  }
  assert.equal(called, false);
});

test('serverless AIS does not start a socket or imply an empty successful feed', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/api/ais-live?maxRows=2000');
  assert.equal(response.status, 503);
  const data = await response.json();
  assert.equal(data.status, 'requires-persistent-service');
  assert.equal(data.refreshing, false);
  assert.deepEqual(data.rows, []);
  assert.equal((await get('/api/ais-live/anything')).status, 404);
});

test('AIS bridge fixes destination, does not forward caller auth, and caps snapshot size', async (t) => {
  let captured;
  const { get } = await fixture(t, {
    config: { ...readHostConfig({ GEV_PERSISTENT_API_ORIGIN: 'https://provider.example', GEV_PERSISTENT_API_TOKEN: 'backend-only' }, 'serverless') },
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return new Response(JSON.stringify({ rows: [], status: 'live' }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal((await get('/api/ais-live?maxRows=999999&url=http://127.0.0.1', { headers: { Authorization: 'Bearer attacker' } })).status, 200);
  assert.equal(captured.url, 'https://provider.example/api/ais-live?maxRows=5000');
  assert.equal(captured.options.headers.Authorization, 'Bearer backend-only');
  assert.equal(captured.options.redirect, 'error');
  assert.equal((await get('/api/ais-live', { method: 'POST' })).status, 405);
});

test('metered provider routes fail closed, including suffixes accepted by Connect', async (t) => {
  const env = { OPENAI_API_KEY: 'test-key', GOOGLE_MAPS_API_KEY: 'test-google' };
  const { get } = await fixture(t, { env });
  for (const url of ['/api/realtime/token', '/api/realtime/token/extra', '/API/realtime/token', '/api/realtime/token.extra', '/API/openai/hud-summary.extra', '/api/openai/hud-summary', '/api/google/nearby-places', '/API/GOOGLE/nearby-places', '/api/cctv/frame/test']) {
    assert.equal((await get(url)).status, 403, url);
  }
});

test('deployment Basic authentication allows paid access and throttles it', async (t) => {
  const env = { GEV_BASIC_AUTH_PASSWORD: 'test-password', OPENAI_API_KEY: 'test-key', GEV_PAID_REQUESTS_PER_MINUTE: '1' };
  const plugin = { name: 'token-test', configurePreviewServer(server) { server.middlewares.use('/api/realtime/token', (req, res) => res.end('{}')); } };
  const { get } = await fixture(t, { env, config: readHostConfig(env, 'serverless'), providerPlugins: [plugin] });
  const first = await get('/api/realtime/token');
  assert.equal(first.status, 401); assert.match(first.headers.get('www-authenticate'), /Basic/);
  const headers = { Authorization: `Basic ${Buffer.from('dream-unity:test-password').toString('base64')}` };
  assert.equal((await get('/api/realtime/token', { headers })).status, 200);
  assert.equal((await get('/api/realtime/token', { headers })).status, 429);
});

test('cross-origin API access is restricted to named portal origins', async (t) => {
  const { get } = await fixture(t);
  assert.equal((await get('/api/health', { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const response = await get('/api/health', { headers: { Origin: 'https://dream-unity.github.io' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://dream-unity.github.io');
  assert.equal((await get('/api/health', { method: 'OPTIONS', headers: { Origin: 'https://dream-unity.github.io' } })).status, 204);
});

test('rejected asynchronous provider requests return a sanitized response', async (t) => {
  const { get } = await fixture(t, { providerPlugins: [{ name: 'failure', configurePreviewServer(server) {
    server.middlewares.use('/api/failure', async () => { throw new Error('secret-token-hidden'); });
  } }] });
  const response = await get('/api/failure');
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /secret-token/);
});

test('all upstream request providers mount without Vite and retain local request validation', async (t) => {
  const previousCwd = process.cwd();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-real-provider-test-'));
  const config = { ...readHostConfig({}, 'serverless'), stateDir: dir };
  const host = await createProductionHost({ config, serveStatic: false });
  const server = createServer(host.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await host.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    process.chdir(previousCwd); await rm(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(host.providerNames.length, 21);
  assert.ok(host.providerNames.includes('cctv-proxy'));
  assert.ok(host.providerNames.includes('openai-realtime-proxy'));
  assert.ok(host.providerNames.includes('traffic-reports-proxy'));
  assert.ok(!host.providerNames.includes('ais-live-proxy'));
  assert.ok(!host.providerNames.includes('gev-key-setup'));
  const transit = await fetch(`${origin}/api/transit/not-a-registered-route`);
  assert.equal(transit.status, 404);
  assert.match(transit.headers.get('content-type'), /json/);
  assert.equal((await fetch(`${origin}/api/not-registered`)).status, 404);
  const regions = await fetch(`${origin}/api/traffic/regions`);
  assert.equal(regions.status, 200);
  assert.deepEqual((await regions.json()).regions.map((region) => region.id), ['austin', 'finland']);
  assert.equal((await fetch(`${origin}/api/traffic/reports?region=unknown`)).status, 400);
});
