import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchCctvHlsResource } from '../../server/providers/cctv/hls.js';

const sourceUrl = 'https://prideshares.intjbilling.com/live/stream.m3u8';
const parameters = {
  sourceUrl,
  resource: 'stream20.ts',
  cameraId: 'yard',
  requireLive: true,
};
// MPEG-TS packets with payload-only headers and stuffing bytes. The relay only
// validates the container; the browser decoder still owns actual video playback.
const transportStream = (count = 8) => {
  const bytes = Buffer.alloc(count * 188, 0xff);
  for (let index = 0; index < count; index++) {
    bytes.set([0x47, 0x40, 0x11, 0x10 | (index % 16)], index * 188);
  }
  return bytes;
};
const mislabeled = (bytes, options = {}) =>
  new Response(bytes, {
    ...options,
    headers: {
      'Content-Type': 'text/vnd.trolltech.linguist',
      ...options.headers,
    },
  });

test('a reviewed live TS segment with the Apache translation MIME is returned as video only after container validation', async () => {
  const bytes = transportStream();
  const response = await fetchCctvHlsResource({
    ...parameters,
    fetchImpl: async () => mislabeled(bytes),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('translation MIME recovery rejects HTML, text, short or corrupt containers and non-TS paths', async () => {
  const brokenSync = transportStream();
  brokenSync[188 * 3] = 0x46;
  const reservedHeader = transportStream();
  reservedHeader[3] = 0;
  const invalidAdaptation = transportStream();
  invalidAdaptation[3] = 0x30;
  invalidAdaptation[4] = 183;
  for (const bytes of [
    Buffer.from('<html>Camera unavailable</html>'),
    Buffer.from('#EXTM3U\n#EXT-X-ENDLIST\n'),
    transportStream(2),
    Buffer.concat([transportStream(), Buffer.from('extra')]),
    brokenSync,
    reservedHeader,
    invalidAdaptation,
  ])
    await assert.rejects(
      fetchCctvHlsResource({
        ...parameters,
        fetchImpl: async () => mislabeled(bytes),
      }),
      /unsupported HLS resource/,
    );
  await assert.rejects(
    fetchCctvHlsResource({
      ...parameters,
      resource: 'unrelated.txt',
      fetchImpl: async () => mislabeled(transportStream()),
    }),
    /unsupported HLS resource/,
  );
});

test('other text and HTML MIME types remain rejected without reading their bodies', async () => {
  for (const contentType of ['text/html', 'text/plain', 'application/json']) {
    let cancelled = false;
    await assert.rejects(
      fetchCctvHlsResource({
        ...parameters,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { 'Content-Type': contentType } },
          ),
      }),
      /unsupported HLS resource/,
    );
    assert.equal(cancelled, true);
  }
});

test('mislabelled TS ranges preserve their offsets and still require complete identifiable packets', async () => {
  const full = transportStream();
  const first = 17;
  const last = 1200;
  const bytes = full.subarray(first, last + 1);
  const response = await fetchCctvHlsResource({
    ...parameters,
    headers: { Range: `bytes=${first}-${last}` },
    fetchImpl: async () =>
      mislabeled(bytes, {
        status: 206,
        headers: { 'Content-Range': `bytes ${first}-${last}/${full.length}` },
      }),
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp2t');
  assert.equal(
    response.headers.get('content-range'),
    `bytes ${first}-${last}/${full.length}`,
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await assert.rejects(
    fetchCctvHlsResource({
      ...parameters,
      headers: { Range: 'bytes=0-1' },
      fetchImpl: async () =>
        mislabeled(full.subarray(0, 2), {
          status: 206,
          headers: { 'Content-Range': `bytes 0-1/${full.length}` },
        }),
    }),
    /unsupported HLS resource/,
  );
});

test('MIME recovery cannot bypass resource caps or registered stream confinement', async () => {
  await assert.rejects(
    fetchCctvHlsResource({
      ...parameters,
      maxResourceBytes: 188 * 3,
      fetchImpl: async () => mislabeled(transportStream()),
    }),
    { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' },
  );
  let requested = false;
  await assert.rejects(
    fetchCctvHlsResource({
      ...parameters,
      resource: 'https://other.example/live/stream20.ts',
      fetchImpl: async () => {
        requested = true;
        return mislabeled(transportStream());
      },
    }),
    /outside its registered stream directory/,
  );
  assert.equal(requested, false);
});
