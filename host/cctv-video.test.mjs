import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('native hosted CCTV dispatch preserves advancing HLS playlists and binary segments through rewrite queries', async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'gev-live-video-'));
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  let sequence = 100;
  let ended = false;
  const upstreamRequests = [];
  const segment = Buffer.from([0x47, 0x40, 0x00, 0x10, 0xff, 0x00, 0x80]);
  const upstream = createServer((req, res) => {
    upstreamRequests.push(req.url);
    if (req.url === '/camera/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=400000\nlow/index.m3u8\n');
    } else if (req.url === '/camera/low/index.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(
        `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:10,\nsegment${sequence++}.ts\n${ended ? '#EXT-X-ENDLIST\n' : ''}`,
      );
    } else if (/^\/camera\/low\/segment\d+\.ts$/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(segment);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    await rm(stateDir, { recursive: true, force: true });
  });
  const sourceOrigin = `http://127.0.0.1:${upstream.address().port}`;
  Object.assign(process.env, {
    VERCEL: '1',
    GEV_STATE_DIR: stateDir,
    CCTV_PREFER_AUSTIN: '0',
    CCTV_FORCE_AUSTIN: '0',
    CCTV_SOURCES_FILE: path.join(stateDir, 'no-file.json'),
    CCTV_SOURCES_JSON: JSON.stringify([
      {
        id: 'live-test',
        name: 'Registered live fixture',
        lat: 38,
        lon: -121,
        feedType: 'hls',
        playbackKind: 'live',
        liveOnly: true,
        url: `${sourceOrigin}/camera/master.m3u8`,
      },
    ]),
  });
  delete process.env.GEV_BASIC_AUTH_PASSWORD;
  delete process.env.GEV_BASIC_AUTH_USER;
  const { default: handler } = await import('../api/index.js');
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (url) => {
    const request = new URL(url, origin);
    // Match Vercel's unused /api/:path* rewrite capture, including resource URLs.
    request.searchParams.set('path', request.pathname.slice('/api/'.length));
    return fetch(request);
  };
  const sources = await get('/api/cctv/sources');
  assert.equal(sources.status, 200);
  const listed = (await sources.json()).sources[0];
  assert.equal(listed.feedType, 'hls');
  assert.equal(listed.liveOnly, true);
  const streamInfo = await (await get('/api/cctv/stream/live-test')).json();
  assert.equal(streamInfo.liveOnly, true);
  assert.equal(streamInfo.frameUrl, null);
  for (const route of ['/api/cctv/frame/live-test', '/api/cctv/frame/live-test?strict=1']) {
    const response = await get(route);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, 'CCTV_LIVE_VIDEO_REQUIRED');
  }
  const master = await get('/api/cctv/media/live-test');
  assert.equal(master.status, 200);
  const variant = (await master.text())
    .split('\n')
    .find((line) => line.startsWith('/api/'));
  assert.ok(variant, 'the player receives a same-origin variant URL');
  const first = await get(variant);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const firstPlaylist = await first.text();
  assert.match(firstPlaylist, /MEDIA-SEQUENCE:100/);
  assert.doesNotMatch(firstPlaylist, /ENDLIST/);
  const segmentPath = firstPlaylist
    .split('\n')
    .find((line) => line.startsWith('/api/'));
  const media = await get(segmentPath);
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-type'), /video\/mp2t/);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), segment);
  const nextPlaylist = await (await get(variant)).text();
  assert.match(nextPlaylist, /MEDIA-SEQUENCE:101/);
  assert.notEqual(
    nextPlaylist,
    firstPlaylist,
    'live playlists are fetched again',
  );
  const before = upstreamRequests.length;
  const refused = await get(
    `/api/cctv/media/live-test?resource=${encodeURIComponent(sourceOrigin + '/private')}`,
  );
  assert.ok(refused.status >= 400);
  assert.equal(
    upstreamRequests.length,
    before,
    'unregistered directories never reach the upstream',
  );
  ended = true;
  const archive = await get(`${variant}&requireLive=false`);
  assert.equal(archive.status, 410, 'client queries cannot disable the server live-only policy');
  assert.equal(archive.headers.get('cache-control'), 'no-store');
  assert.equal((await archive.json()).code, 'CCTV_BROADCAST_ENDED');
});
