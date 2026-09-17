import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCctvHlsResource, rewriteCctvHlsPlaylist, fetchCctvHlsResource } from '../../server/providers/cctv/hls.js';
import { fetchBoundedCctvVideoUpstream } from '../../server/providers/cctv/media.js';

const sourceUrl = 'https://camera.example/live/master.m3u8';

test('HLS relay confines resources to the registered origin and camera directory', () => {
  assert.equal(resolveCctvHlsResource(sourceUrl, 'variant/chunk.ts').href, 'https://camera.example/live/variant/chunk.ts');
  for (const resource of [
    'https://other.example/live/chunk.ts', 'http://camera.example/live/chunk.ts',
    '//127.0.0.1/private', 'https://user:secret@camera.example/live/a.ts',
    '../private', '/other/path.ts', '/live/%2e%2e/private',
    '/live/a%2f..%2fprivate', '/live/a%252f..%252fprivate', '/live/\\private',
  ]) assert.throws(() => resolveCctvHlsResource(sourceUrl, resource), /outside/);
});

test('HLS master, segments, encryption keys and initialization maps are rewritten to the same-origin relay', () => {
  const input = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/list.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=100\nvariant/low.m3u8\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4.0,\nsegment.ts\n';
  const output = rewriteCctvHlsPlaylist(input, { sourceUrl, playlistUrl: sourceUrl, cameraId: 'a/b' });
  for (const name of ['audio/list.m3u8', 'variant/low.m3u8', 'key.bin', 'init.mp4', 'segment.ts']) {
    assert.ok(output.includes('/api/cctv/media/a%2Fb?resource=' + encodeURIComponent('https://camera.example/live/' + name)));
  }
  assert.throws(() => rewriteCctvHlsPlaylist('<html>error</html>', { sourceUrl, playlistUrl: sourceUrl, cameraId: 'a' }), /invalid/);
  assert.throws(() => rewriteCctvHlsPlaylist('#EXTM3U\nhttps://attacker.example/private\n', { sourceUrl, playlistUrl: sourceUrl, cameraId: 'a' }), /outside/);
});

test('HLS playlist fetch follows a same-directory redirect and resolves nested references against the final URL', async () => {
  const requests = [];
  const response = await fetchCctvHlsResource({ sourceUrl, cameraId: 'a', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: 'variant/index.m3u8' } })
      : new Response('#EXTM3U\nchunk.ts', { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });
  } });
  assert.ok((await response.text()).includes(encodeURIComponent('https://camera.example/live/variant/chunk.ts')));
  assert.ok(requests.every(({ init }) => init.redirect === 'manual'));
  assert.equal(requests[0].init.signal.aborted, true, 'transport closes after bounded body consumption');
});

test('an HLS redirect cannot turn a registered camera into an arbitrary URL proxy', async () => {
  let calls = 0;
  await assert.rejects(fetchCctvHlsResource({ sourceUrl, cameraId: 'a', fetchImpl: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/metadata' } });
  } }), /outside/);
  assert.equal(calls, 1);
});

test('HLS binary resources retain ranges, enforce byte caps, and refuse HTML errors', async () => {
  const params = { sourceUrl, resource: 'segment.ts', cameraId: 'a' };
  const response = await fetchCctvHlsResource({ ...params, fetchImpl: async () => new Response('segment', {
    status: 206, headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-6/20' },
  }) });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-6/20');
  assert.equal(await response.text(), 'segment');
  await assert.rejects(fetchCctvHlsResource({ ...params, maxResourceBytes: 3, fetchImpl: async () => new Response('large', { headers: { 'content-type': 'video/mp2t' } }) }), { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' });
  await assert.rejects(fetchCctvHlsResource({ ...params, fetchImpl: async () => new Response('<html>blocked</html>', { headers: { 'content-type': 'text/html' } }) }), /unsupported/);
});

test('the HLS deadline includes a stalled response body, not only its headers', async () => {
  await assert.rejects(fetchCctvHlsResource({ sourceUrl, cameraId: 'a', timeoutMs: 5, fetchImpl: async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(new DOMException('Timeout', 'AbortError')), { once: true }); },
  }), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }) }), { name: 'AbortError' });
});

test('rewriting cannot expand a small manifest past the response budget', () => {
  const input = '#EXTM3U\n' + '#EXTINF:6,\na.ts\n'.repeat(20_000);
  assert.ok(Buffer.byteLength(input) < 512 * 1024);
  assert.throws(() => rewriteCctvHlsPlaylist(input, { sourceUrl, playlistUrl: sourceUrl, cameraId: 'camera'.repeat(9) }), { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' });
});

test('serverless finite video rejects an ignored range that exceeds its response cap', async () => {
  await assert.rejects(fetchBoundedCctvVideoUpstream(sourceUrl, { maxBytes: 3, fetchImpl: async () => new Response('too large', { headers: { 'content-type': 'video/mp4' } }) }), { code: 'CCTV_VIDEO_RESOURCE_TOO_LARGE' });
  const response = await fetchBoundedCctvVideoUpstream(sourceUrl, { maxBytes: 3, fetchImpl: async () => new Response('abc', { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-2/10' } }) });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 0-2/10');
  assert.equal(await response.text(), 'abc');
});

test('HLS byte-range fragments stay complete and oversized requests fail before contacting a camera', async () => {
  let calls = 0;
  await assert.rejects(fetchCctvHlsResource({
    sourceUrl, resource: 'parts.mp4', cameraId: 'a', maxResourceBytes: 4,
    headers: { Range: 'bytes=20-24' }, fetchImpl: async () => { calls++; },
  }), { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' });
  assert.equal(calls, 0);
  const response = await fetchCctvHlsResource({
    sourceUrl, resource: 'parts.mp4', cameraId: 'a', maxResourceBytes: 10,
    headers: { Range: 'bytes=3-6' }, fetchImpl: async () => new Response('0123456789', {
      headers: { 'content-type': 'video/mp4' },
    }),
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '3456');
});

test('HLS rejects incorrect or truncated byte-range fragments rather than reporting successful media', async () => {
  for (const [status, contentRange, body] of [
    [206, 'bytes 0-3/10', '0123'],
    [206, 'bytes 3-6/10', '345'],
    [206, '', '3456'],
    [200, '', '012'],
  ]) {
    await assert.rejects(fetchCctvHlsResource({
      sourceUrl, resource: 'parts.mp4', cameraId: 'a', headers: { Range: 'bytes=3-6' },
      fetchImpl: async () => new Response(body, { status, headers: {
        'content-type': 'video/mp4', 'content-range': contentRange,
      } }),
    }), /requested byte range/);
  }
});

test('native HLS open and suffix probes work without clipping complete resources', async () => {
  for (const [range, expectedRange, expectedBody] of [
    ['bytes=6-', 'bytes 6-9/10', '6789'],
    ['bytes=-4', 'bytes 6-9/10', '6789'],
    ['bytes=-20', 'bytes 0-9/10', '0123456789'],
  ]) {
    for (const status of [200, 206]) {
      const response = await fetchCctvHlsResource({
        sourceUrl, resource: 'part.ts', cameraId: 'a', headers: { Range: range },
        maxResourceBytes: 10, fetchImpl: async (_url, init) => {
          assert.equal(new Headers(init.headers).get('range'), range);
          return new Response(status === 200 ? '0123456789' : expectedBody, {
            status, headers: { 'content-type': 'video/mp2t', ...(status === 206 ? { 'content-range': expectedRange } : {}) },
          });
        },
      });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), expectedRange);
      assert.equal(await response.text(), expectedBody);
    }
  }
  await assert.rejects(fetchCctvHlsResource({
    sourceUrl, resource: 'part.ts', cameraId: 'a', headers: { Range: 'bytes=0-' },
    maxResourceBytes: 4, fetchImpl: async () => new Response('0123456789', { headers: { 'content-type': 'video/mp2t' } }),
  }), { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' });
});

test('HLS relay preserves expired-segment and throttling status and releases rejected bodies', async () => {
  for (const status of [404, 429, 503]) {
    let cancelled = false;
    const response = await fetchCctvHlsResource({
      sourceUrl, resource: 'expired.ts', cameraId: 'a', fetchImpl: async () => new Response(
        new ReadableStream({ cancel() { cancelled = true; } }), { status },
      ),
    });
    assert.equal(response.status, status);
    assert.equal(cancelled, true);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('live HLS manifest reloads preserve sequence advancement instead of replaying cached playlist bytes', async () => {
  let sequence = 4;
  const fetchImpl = async () => new Response(`#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:6,\npart-${sequence++}.ts\n`, {
    headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'public, max-age=3600' },
  });
  const first = await fetchCctvHlsResource({ sourceUrl, cameraId: 'a', fetchImpl });
  const second = await fetchCctvHlsResource({ sourceUrl, cameraId: 'a', fetchImpl });
  assert.match(await first.text(), /MEDIA-SEQUENCE:4/);
  assert.match(await second.text(), /MEDIA-SEQUENCE:5/);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(second.headers.get('cache-control'), 'no-store');
});
