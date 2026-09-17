import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('hosted global cameras retain country and owner players without proxying HTML or substituting snapshots', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gev-global-video-'));
  const saved = { ...process.env };
  Object.assign(process.env, {
    VERCEL: '1', GEV_STATE_DIR: stateDir, CCTV_PREFER_AUSTIN: '0', CCTV_FORCE_AUSTIN: '0',
    CCTV_SOURCES_FILE: path.join(stateDir, 'no-file.json'),
    CCTV_SOURCES_JSON: JSON.stringify([
      { id: 'global-fi', name: 'Public square', country: 'FI', countryName: 'Finland', city: 'Rovaniemi',
        lat: 66.543, lon: 25.847, feedType: 'embed', playbackKind: 'live',
        embedUrl: 'https://www.youtube.com/embed/Cp4RRAEgpeU', url: 'https://www.youtube.com/embed/Cp4RRAEgpeU',
        sourcePage: 'https://www.visitfinland.com/en/practical-tips/live-from-finland/',
        verifiedAt: '2026-09-17', credit: 'City of Rovaniemi' },
      { id: 'snapshot-only', name: 'Snapshot', lat: 60, lon: 24, feedType: 'image', url: 'https://example.test/camera.jpg' },
    ]),
  });
  delete process.env.GEV_BASIC_AUTH_PASSWORD;
  delete process.env.GEV_BASIC_AUTH_USER;
  const { default: handler } = await import('../api/index.js');
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(stateDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = route => {
    const url = new URL(route, origin);
    url.searchParams.set('path', url.pathname.slice('/api/'.length));
    return fetch(url);
  };
  const listed = await (await get('/api/cctv/sources')).json();
  const camera = listed.sources.find(s => s.id === 'global-fi');
  assert.equal(camera.country, 'FI');
  assert.equal(camera.countryName, 'Finland');
  assert.equal(camera.credit, 'City of Rovaniemi');
  assert.equal(camera.embedUrl, 'https://www.youtube-nocookie.com/embed/Cp4RRAEgpeU');
  const info = await (await get('/api/cctv/stream/global-fi')).json();
  assert.equal(info.mediaUrl, null);
  assert.equal(info.frameUrl, null);
  assert.equal(info.embedUrl, camera.embedUrl);
  for (const route of ['/api/cctv/media/global-fi', '/api/cctv/frame/global-fi', '/api/cctv/frame/global-fi?strict=1']) {
    const response = await get(route);
    assert.equal(response.status, 409, route);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await response.json()).code, 'CCTV_OFFICIAL_PLAYER_REQUIRED');
  }
  assert.equal((await get('/api/cctv/embed-status/not-registered')).status, 404);
  assert.equal((await get('/api/cctv/embed-status/snapshot-only')).status, 409);
});
