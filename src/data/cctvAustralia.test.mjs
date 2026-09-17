import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadAustraliaCctvSources,
  loadAustraliaPublisherCameras,
  normalizeAustraliaCctvSources,
} from '../../server/providers/cctv/australiaSources.js';
import { loadGlobalCctvSources } from '../../server/providers/cctv/globalSources.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { allocateSourceCap } from '../../server/providers/cctv/cap.js';

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
  const publisher = { ...sample, access: 'publisher-only' };
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
