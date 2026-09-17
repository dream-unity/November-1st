import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCaltransSnapshotUrl,
  normalizeCaltransStreamUrl,
} from '../../server/providers/cctv/caltransStreaming.js';
import {
  loadAustinSourcesFromOpenData,
  loadCaltransSourcesFromOpenData,
  loadDriveBcSourcesFromOpenData,
  loadFintrafficSourcesFromOpenData,
  loadNswSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
  loadTflSourcesFromOpenData,
  loadTxdotSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

const stream =
  'https://wzmedia.dot.ca.gov/D3/5_Pocket_Rd_OC_SAC5_SB.stream/playlist.m3u8';
const snapshot =
  'https://cwwp2.dot.ca.gov/data/d3/cctv/image/hwy5atpocket/hwy5atpocket.jpg';

function env(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }
}

function setup(t, districts = '3') {
  env(t, {
    CCTV_CALTRANS_DISTRICTS: districts,
    CCTV_CALTRANS_MAX_SOURCES: '300',
  });
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
}

function row(id, overrides = {}) {
  return {
    cctv: {
      inService: 'true',
      location: {
        locationName: `TV${id} -- Hwy 5 at Pocket`,
        nearbyPlace: 'Sacramento',
        latitude: '38.481128',
        longitude: '-121.510528',
        elevation: '22',
        direction: 'South',
      },
      imageData: {
        streamingVideoURL: stream,
        static: { currentImageURL: snapshot },
      },
      ...overrides,
    },
  };
}

test('Caltrans accepts only declared official HTTPS HLS streams for the requested district', () => {
  assert.equal(normalizeCaltransStreamUrl(stream, 3), stream);
  for (const value of [
    '',
    'Not Reported',
    null,
    snapshot,
    stream.replace('https:', 'http:'),
    stream.replace('wzmedia.dot.ca.gov', 'wzmedia.dot.ca.gov.evil.example'),
    stream.replace('wzmedia.dot.ca.gov', 'user@wzmedia.dot.ca.gov'),
    stream.replace('/D3/', '/D7/'),
    stream.replace('/D3/', '/D3/../D7/'),
    stream.replace('.stream/', '.stream%2f'),
    `${stream}?url=https://example.test/`,
    `${stream}#fragment`,
    stream.replace('https://', 'https://\n'),
  ])
    assert.equal(normalizeCaltransStreamUrl(value, 3), '', String(value));
  assert.equal(normalizeCaltransStreamUrl(stream, 0), '');
});

test('Caltrans still previews stay on the exact official district image path', () => {
  assert.equal(normalizeCaltransSnapshotUrl(snapshot, 3), snapshot);
  for (const value of [
    '',
    null,
    stream,
    snapshot.replace('https:', 'http:'),
    snapshot.replace('cwwp2.dot.ca.gov', 'cwwp2.dot.ca.gov.evil.example'),
    snapshot.replace('/d3/', '/d4/'),
    snapshot.replace('/image/', '/image/%2e%2e/'),
    snapshot.replace('.jpg', '.m3u8'),
    `${snapshot}?redirect=1`,
    `${snapshot}#x`,
  ])
    assert.equal(normalizeCaltransSnapshotUrl(value, 3), '', String(value));
});

test('Caltrans registers running video with its separate still preview, and keeps snapshot-only cameras honest', async (t) => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        row(1),
        row(2, {
          imageData: {
            streamingVideoURL: 'Not Reported',
            static: { currentImageURL: snapshot },
          },
        }),
        row(3, { imageData: { streamingVideoURL: stream } }),
        row(4, {
          imageData: {
            streamingVideoURL: 'https://evil.test/playlist.m3u8',
            static: { currentImageURL: snapshot },
          },
        }),
        row(5, { inService: 'false' }),
        row(6, { location: { latitude: '0', longitude: '0' } }),
        row(7, { location: { latitude: null, longitude: '-121.5' } }),
      ],
    }),
  );
  const sources = await loadCaltransSourcesFromOpenData();
  assert.equal(sources.length, 4);
  const live = sources.find((camera) => camera.id === 'ca-d3-tv1');
  assert.equal(live.feedType, 'hls');
  assert.equal(live.playbackKind, 'live');
  assert.equal(live.url, stream);
  assert.equal(live.snapshotUrl, snapshot);
  assert.equal(live.groundElevationM, 22 * 0.3048);
  assert.equal(
    sources.find((camera) => camera.id === 'ca-d3-tv3').snapshotUrl,
    '',
  );
  for (const id of ['ca-d3-tv2', 'ca-d3-tv4']) {
    const camera = sources.find((item) => item.id === id);
    assert.equal(camera.feedType, 'image');
    assert.equal(camera.playbackKind, 'snapshot');
    assert.equal(camera.url, snapshot);
  }
});

test('Caltrans cap prefers usable stream declarations without exceeding capacity when stills exist', async (t) => {
  setup(t);
  env(t, { CCTV_CALTRANS_MAX_SOURCES: '8' });
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        ...Array.from({ length: 10 }, (_, i) =>
          row(i, { imageData: { static: { currentImageURL: snapshot } } }),
        ),
        ...Array.from({ length: 10 }, (_, i) => row(i + 20)),
      ],
    }),
  );
  const sources = await loadCaltransSourcesFromOpenData();
  assert.equal(sources.length, 8);
  assert.ok(sources.every((camera) => camera.playbackKind === 'live'));
  assert.equal(new Set(sources.map((camera) => camera.id)).size, 8);
});

test('Caltrans fetches each district once and isolates oversized or failed district responses', async (t) => {
  setup(t, '3,3,4,7,0,13,nope');
  const requested = [];
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(String(url));
    if (String(url).includes('/d4/'))
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Length': String(9 * 1024 * 1024) } },
      );
    if (String(url).includes('/d7/'))
      return new Response('offline', { status: 503 });
    return Response.json({ data: [row(1)] });
  });
  const sources = await loadCaltransSourcesFromOpenData();
  assert.equal(requested.length, 3);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'ca-d3-tv1');
  assert.equal(cancelled, true);
});

test('Caltrans unnamed camera IDs survive row order and earlier district failures', async (t) => {
  setup(t, '4,3');
  let reversed = false;
  let districtFailure = false;
  const unnamed = (id) =>
    row(id, {
      location: {
        latitude: '38.481128',
        longitude: '-121.510528',
        locationName: `Hwy 5 camera ${id}`,
      },
      imageData: {
        streamingVideoURL: stream,
        static: { currentImageURL: snapshot.replace(/pocket/g, `pocket${id}`) },
      },
    });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/d4/')) {
      if (districtFailure) return new Response('offline', { status: 503 });
      return Response.json({
        data: [
          row(90, {
            imageData: {
              static: { currentImageURL: snapshot.replace('/d3/', '/d4/') },
            },
          }),
        ],
      });
    }
    return Response.json({
      data: reversed ? [unnamed(2), unnamed(1)] : [unnamed(1), unnamed(2)],
    });
  });
  const before = await loadCaltransSourcesFromOpenData();
  reversed = true;
  districtFailure = true;
  const after = await loadCaltransSourcesFromOpenData();
  for (const camera of after) {
    assert.match(camera.id, /^ca-d3-source-[0-9a-f]{20}$/);
    assert.equal(
      before.find((old) => old.snapshotUrl === camera.snapshotUrl)?.id,
      camera.id,
    );
  }
  assert.equal(new Set(after.map((camera) => camera.id)).size, 2);
});

test('duplicate Caltrans display codes cannot collapse different cameras', async (t) => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      data: [
        row(1),
        row(1, {
          imageData: {
            streamingVideoURL: stream,
            static: { currentImageURL: snapshot.replace(/pocket/g, 'florin') },
          },
        }),
      ],
    }),
  );
  const cameras = await loadCaltransSourcesFromOpenData();
  assert.equal(cameras.length, 2);
  assert.equal(new Set(cameras.map((camera) => camera.id)).size, 2);
});

test('camera normalization never guesses continuous video from a container or labels a still live', () => {
  assert.equal(
    normalizeSourceItem({ id: 'a', feedType: 'hls' }).playbackKind,
    'video',
  );
  assert.equal(
    normalizeSourceItem({ id: 'a', feedType: 'hls', playbackKind: 'live' })
      .playbackKind,
    'live',
  );
  assert.equal(
    normalizeSourceItem({ id: 'a', feedType: 'mp4', playbackKind: 'clip' })
      .playbackKind,
    'clip',
  );
  assert.equal(
    normalizeSourceItem({ id: 'a', feedType: 'jpeg', playbackKind: 'live' })
      .playbackKind,
    'snapshot',
  );
});

test('all network JSON camera catalogues reject oversized bodies and release their responses', async (t) => {
  setup(t);
  env(t, { CCTV_TXDOT_DISTRICTS: 'AUS' });
  let responses = 0;
  let cancelled = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    responses += 1;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled += 1;
        },
      }),
      {
        headers: { 'Content-Length': String(17 * 1024 * 1024) },
      },
    );
  });
  for (const loader of [
    loadAustinSourcesFromOpenData,
    loadCaltransSourcesFromOpenData,
    loadDriveBcSourcesFromOpenData,
    loadFintrafficSourcesFromOpenData,
    loadNswSourcesFromOpenData,
    loadOntarioSourcesFromOpenData,
    loadTflSourcesFromOpenData,
    loadTxdotSourcesFromOpenData,
  ]) {
    assert.deepEqual(await loader(), []);
  }
  assert.equal(responses, 8);
  assert.equal(cancelled, responses);
});
