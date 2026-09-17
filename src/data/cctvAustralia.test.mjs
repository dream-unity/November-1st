import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  loadAustraliaCctvSources,
  loadAustraliaPublisherCameras,
  normalizeAustraliaCctvSources,
} from '../../server/providers/cctv/australiaSources.js';
import { loadGlobalCctvSources } from '../../server/providers/cctv/globalSources.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';
import { cctvProxy } from '../../server/providers/cctv.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sample = {
  id: 'au-public-view',
  name: 'Public coastal view',
  city: 'Busselton',
  state: 'Western Australia',
  country: 'AU',
  countryName: 'Australia',
  lat: -33.643,
  lon: 115.344,
  credit: 'Camera publisher',
  feedType: 'embed',
  playbackKind: 'live',
  liveOnly: true,
  embedUrl: 'https://www.youtube.com/embed/72vmq0Q3ueE',
  sourcePage: 'https://busseltonjetty.com.au/live-webcams/',
  verifiedAt: '2026-09-17T08:39:32Z',
  verification: 'Public owner stream status is live and embeddable.',
  locationAccuracy: 'Approximate scene location; not a surveyed camera pose',
};
const melbourneHls = {
  ...sample,
  id: 'au-spotswood-owner-live',
  name: 'Spotswood Trailers — public yard camera',
  city: 'Spotswood',
  state: 'Victoria',
  metroArea: 'melbourne',
  locality: 'Spotswood',
  region: 'Greater Melbourne',
  lat: -37.826125,
  lon: 144.877228,
  feedType: 'hls',
  url: 'https://prideshares.intjbilling.com/live/stream.m3u8',
  embedUrl: null,
  sourcePage: 'https://spotswoodtrailers.com.au/',
};

test('Melbourne geography is explicit, sanitized and retained for suburban scenes', () => {
  const camera = normalizeSourceItem({
    ...melbourneHls,
    locality: ' Spotswood\n ',
    region: ' Greater\t Melbourne ',
  });
  assert.equal(camera.metroArea, 'melbourne');
  assert.equal(camera.locality, 'Spotswood');
  assert.equal(camera.region, 'Greater Melbourne');
  for (const patch of [
    { metroArea: undefined },
    { metroArea: 'Melbourne' },
    { metroArea: 'melbourne\n' },
    { country: 'UA' },
  ])
    assert.equal(
      normalizeSourceItem({ ...melbourneHls, ...patch }).metroArea,
      '',
    );
  assert.equal(
    normalizeSourceItem({ ...melbourneHls, locality: 'x'.repeat(500) }).locality
      .length,
    100,
  );
  assert.equal(normalizeSourceItem({ ...melbourneHls, region: {} }).region, '');
});

test('Australian HLS admission requires the exact reviewed owner and stream pair', () => {
  const [accepted] = normalizeAustraliaCctvSources([melbourneHls]);
  assert.equal(accepted.url, melbourneHls.url);
  assert.equal(accepted.feedType, 'hls');
  assert.equal(accepted.embedUrl, null);
  assert.equal(accepted.snapshotUrl, null);
  assert.equal(accepted.sourceKind, 'public-owner-live');
  assert.equal(accepted.liveOnly, true);
  for (const patch of [
    { url: 'https://prideshares.intjbilling.com/live/other.m3u8' },
    { url: 'https://prideshares.intjbilling.com/private/stream.m3u8' },
    {
      url: 'https://prideshares.intjbilling.com.evil.example/live/stream.m3u8',
    },
    { url: 'http://prideshares.intjbilling.com/live/stream.m3u8' },
    { url: `${melbourneHls.url}?archive=1` },
    { url: `${melbourneHls.url}#archive` },
    { url: 'https://user:secret@prideshares.intjbilling.com/live/stream.m3u8' },
    { sourcePage: 'https://example.org/' },
    { sourcePage: 'https://spotswoodtrailers.com.au/unreviewed' },
    { liveOnly: false },
    { playbackKind: 'clip' },
    { verification: '' },
    { feedType: 'mp4' },
  ])
    assert.deepEqual(
      normalizeAustraliaCctvSources([{ ...melbourneHls, ...patch }]),
      [],
      JSON.stringify(patch),
    );
  assert.equal(
    normalizeAustraliaCctvSources([
      melbourneHls,
      { ...melbourneHls, id: 'au-duplicate-live' },
    ]).length,
    1,
  );
});

test('Melbourne source API retains metro metadata and live HLS cannot fall back to archives or frames', async (t) => {
  const sourceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'gev-melbourne-hls-'),
  );
  const configured = {
    CCTV_SOURCES_FILE: path.join(sourceRoot, 'absent.json'),
    CCTV_SOURCES_JSON: JSON.stringify(
      normalizeAustraliaCctvSources([melbourneHls]),
    ),
    CCTV_PREFER_AUSTIN: '0',
    CCTV_FORCE_AUSTIN: '0',
  };
  const previous = Object.fromEntries(
    Object.keys(configured).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, configured);
  const request = globalThis.fetch;
  let ended = false;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, melbourneHls.url);
    return new Response(
      '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXT-X-MEDIA-SEQUENCE:20\n#EXTINF:2.4,\nstream20.ts\n' +
        (ended ? '#EXT-X-ENDLIST\n' : ''),
      { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } },
    );
  });
  let middleware;
  cctvProxy({ sourceRoot }).configureServer({
    middlewares: {
      use(_path, callback) {
        middleware = callback;
      },
    },
  });
  const server = createServer((req, res) => middleware(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(sourceRoot, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const listed = await (await request(`${origin}/sources`)).json();
  assert.equal(listed.sources[0].metroArea, 'melbourne');
  assert.equal(listed.sources[0].locality, 'Spotswood');
  assert.equal(listed.sources[0].region, 'Greater Melbourne');
  const info = await (
    await request(`${origin}/stream/${melbourneHls.id}`)
  ).json();
  assert.equal(info.frameUrl, null);
  assert.equal(info.liveOnly, true);
  const frame = await request(`${origin}/frame/${melbourneHls.id}`);
  assert.equal(frame.status, 409);
  const live = await request(`${origin}/media/${melbourneHls.id}`);
  assert.equal(live.status, 200);
  assert.match(
    await live.text(),
    /\/api\/cctv\/media\/au-spotswood-owner-live/,
  );
  ended = true;
  const archive = await request(`${origin}/media/${melbourneHls.id}`);
  assert.equal(archive.status, 410);
  assert.equal((await archive.json()).code, 'CCTV_BROADCAST_ENDED');
});

test('Australian shipped cameras retain strict live policy, state and provenance without duplicate global media', async () => {
  const raw = JSON.parse(
    await readFile(
      new URL('../../config/cctv_sources.australia.json', import.meta.url),
      'utf8',
    ),
  );
  const local = loadAustraliaCctvSources({ sourceRoot: root });
  assert.ok(local.length > 2);
  assert.equal(
    local.length,
    raw.length,
    'no invalid shipped records may disappear silently',
  );
  const cameras = [
    ...local,
    ...loadGlobalCctvSources({ sourceRoot: root }).filter(
      (row) => row.country === 'AU',
    ),
  ];
  assert.equal(new Set(cameras.map((row) => row.id)).size, cameras.length);
  assert.equal(new Set(cameras.map((row) => row.url)).size, cameras.length);
  for (const camera of cameras) {
    const normalized = normalizeSourceItem(camera);
    assert.equal(normalized.liveOnly, true);
    assert.equal(normalized.playbackKind, 'live');
    assert.ok(['embed', 'hls'].includes(normalized.feedType));
    assert.equal(normalized.country, 'AU');
    assert.ok(
      normalized.state &&
        normalized.city &&
        normalized.sourcePage &&
        normalized.verifiedAt,
    );
    assert.ok(camera.verification && camera.locationAccuracy);
  }
});

test('Australian camera admission rejects finite media, unreviewed players, invalid geometry and missing provenance', () => {
  assert.equal(normalizeAustraliaCctvSources([sample]).length, 1);
  for (const patch of [
    { liveOnly: false },
    { liveOnly: undefined },
    { playbackKind: 'clip' },
    { feedType: 'image' },
    { feedType: 'mp4' },
    { feedType: 'hls' },
    { embedUrl: 'https://camera.example/live' },
    { embedUrl: 'https://www.youtube.com.evil.example/embed/72vmq0Q3ueE' },
    { sourcePage: 'https://localhost/camera' },
    { sourcePage: 'javascript:alert(1)' },
    { country: 'NZ' },
    { state: 'Unknown' },
    { city: '' },
    { lat: null },
    { lon: NaN },
    { lat: -91 },
    { lon: 181 },
    { verifiedAt: '' },
    { verification: '' },
    { locationAccuracy: '' },
    { credit: '' },
    { id: '../camera' },
    { id: 'other-camera' },
  ])
    assert.deepEqual(
      normalizeAustraliaCctvSources([{ ...sample, ...patch }]),
      [],
      JSON.stringify(patch),
    );
  const [camera] = normalizeAustraliaCctvSources([
    { ...sample, snapshotUrl: 'https://example.com/still.jpg' },
  ]);
  assert.equal(camera.snapshotUrl, null);
  assert.equal(
    normalizeAustraliaCctvSources([sample, { ...sample, id: 'au-duplicate' }])
      .length,
    1,
  );
});

test('a reduced shared catalogue cap keeps different Australian states represented', () => {
  const rows = [
    sample,
    {
      ...sample,
      id: 'au-wa-second',
      embedUrl: 'https://www.youtube.com/embed/4jB7YQpLvwo',
    },
    {
      ...sample,
      id: 'au-nsw-first',
      state: 'New South Wales',
      city: 'Bonny Hills',
      embedUrl: 'https://www.youtube.com/embed/ZXtKZjJedVw',
    },
  ];
  const sources = normalizeAustraliaCctvSources(rows);
  assert.deepEqual(
    allocateSourceCap([{ name: 'australia', sources }], 2).sources.map(
      (row) => row.state,
    ),
    ['Western Australia', 'New South Wales'],
  );
});

test('missing or malformed Australian registry stays isolated and immutable source roots are respected', async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gev-au-cameras-'));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  assert.deepEqual(loadAustraliaCctvSources({ sourceRoot }), []);
  await mkdir(path.join(sourceRoot, 'config'));
  const filename = path.join(sourceRoot, 'config/cctv_sources.australia.json');
  await writeFile(filename, '{bad');
  assert.deepEqual(loadAustraliaCctvSources({ sourceRoot }), []);
  await writeFile(filename, JSON.stringify([sample]));
  assert.equal(loadAustraliaCctvSources({ sourceRoot })[0].id, sample.id);
});

test('publisher-only cameras require explicit live-only provenance and deduplicate canonical public URLs', async (t) => {
  const sourceRoot = await mkdtemp(
    path.join(os.tmpdir(), 'gev-au-publishers-'),
  );
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await mkdir(path.join(sourceRoot, 'config'));
  const filename = path.join(
    sourceRoot,
    'config/cctv_sources.australia-publisher.json',
  );
  const publisher = {
    ...sample,
    access: 'publisher-only',
    metroArea: 'melbourne',
    locality: ' Spotswood\n',
    region: ' Greater\tMelbourne ',
  };
  const rejected = [
    { liveOnly: false },
    { liveOnly: undefined },
    { liveOnly: 'true' },
    { playbackKind: 'clip' },
    { playbackKind: 'unknown' },
    { verifiedAt: '' },
    { verification: '' },
    { sourcePage: 'https://localhost/camera' },
    { sourcePage: 'https://127.0.0.1/camera' },
    { sourcePage: 'javascript:alert(1)' },
  ].map((patch) => ({ ...publisher, ...patch }));
  await writeFile(filename, JSON.stringify(rejected));
  assert.deepEqual(loadAustraliaPublisherCameras({ sourceRoot }), []);

  await writeFile(
    filename,
    JSON.stringify([
      {
        ...publisher,
        sourcePage: 'https://BUSSELTONJETTY.COM.AU:443/old/../live-webcams/',
      },
      { ...publisher, id: 'au-equivalent-url' },
    ]),
  );
  const loaded = loadAustraliaPublisherCameras({ sourceRoot });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].sourcePage, publisher.sourcePage);
  assert.equal(loaded[0].id, publisher.id);
  assert.equal(loaded[0].access, 'publisher-only');
  assert.equal(loaded[0].metroArea, 'melbourne');
  assert.equal(loaded[0].locality, 'Spotswood');
  assert.equal(loaded[0].region, 'Greater Melbourne');
  assert.equal(
    loaded[0].embedUrl,
    undefined,
    'publisher links must not become playable embeds',
  );
});

test('shipped publisher-only cameras all satisfy strict admission', async () => {
  const raw = JSON.parse(
    await readFile(
      new URL(
        '../../config/cctv_sources.australia-publisher.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const loaded = loadAustraliaPublisherCameras({ sourceRoot: root });
  assert.ok(raw.length > 0);
  assert.equal(
    loaded.length,
    raw.length,
    'no invalid or duplicate shipped publisher links may disappear silently',
  );
});
