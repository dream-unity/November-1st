import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('native Vercel entry dispatches original nested API paths to upstream providers', async (t) => {
  const previousCwd = process.cwd();
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gev-entry-test-'));
  process.env.GEV_STATE_DIR = stateDir;
  // Test configuration is deliberately keyless and never reaches paid services.
  delete process.env.GEV_BASIC_AUTH_PASSWORD;
  delete process.env.GEV_BASIC_AUTH_USER;
  delete process.env.FIRMS_MAP_KEY;
  delete process.env.TOMTOM_API_KEY;
  const { default: handler } = await import('../api/index.js');
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    process.chdir(previousCwd);
    await rm(stateDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/api/firms/status', '/api/tomtom/status']) {
    const response = await fetch(`${origin}${route}`);
    assert.equal(response.status, 200, route);
    assert.equal((await response.json()).hasKey, false, route);
  }
  const radio = await fetch(`${origin}/api/radio/not-a-route`);
  assert.equal(radio.status, 404);
  assert.match(radio.headers.get('content-type'), /json/);
  const health = await fetch(`${origin}/api/health`);
  assert.equal((await health.json()).providersMounted.length, 21);
  const unity = await fetch(`${origin}/api/unity/status?path=unity%2Fstatus`, {
    headers: { Origin: 'https://dreamunity.one' },
  });
  assert.equal(unity.status, 200);
  assert.equal(
    unity.headers.get('Access-Control-Allow-Origin'),
    'https://dreamunity.one',
  );
  const status = await unity.json();
  assert.equal(status.version, 1);
  assert.equal(typeof status.ready, 'boolean');
  assert.ok(Array.isArray(status.reasonCodes));
  const missing = await fetch(`${origin}/api/unity/not-a-route`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'API_ROUTE_NOT_FOUND');
});
