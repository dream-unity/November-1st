import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadUkraineCctvSources, normalizeUkraineCctvSources } from '../../server/providers/cctv/ukraineSources.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = {
  id: 'ua-bukovel8', name: 'Mountain panorama', city: 'Bukovel', country: 'UA',
  lat: 48.361, lon: 24.385, credit: 'Bukovel resort',
  url: 'https://eu2.camflg.com:5443/LiveApp/streams/bukovel8.m3u8',
  sourcePage: 'https://bukovel.com/en/cams', verifiedAt: '2026-09-17T07:12:30Z',
  verification: 'Owner publication and advancing HLS playlist',
  feedType: 'hls', playbackKind: 'live', liveOnly: true,
};

test('Ukraine registry admits every shipped reviewed live source without duplicate streams', () => {
  const records = loadUkraineCctvSources({ sourceRoot: root });
  assert.ok(records.length >= 5);
  assert.equal(new Set(records.map(row => row.url)).size, records.length);
  for (const row of records) {
    assert.equal(row.country, 'UA');
    assert.equal(row.liveOnly, true);
    assert.equal(row.playbackKind, 'live');
    assert.equal(row.snapshotUrl, null);
    assert.ok(row.credit && row.sourcePage && row.verification);
    const normalized = normalizeSourceItem(row);
    assert.equal(normalized.liveOnly, true);
    assert.equal(normalized.playbackKind, 'live');
    assert.equal(normalized.country, 'UA');
  }
});

test('Ukraine source admission rejects unreviewed hosts, credentials, archives and invalid provenance', () => {
  for (const patch of [
    { url: 'https://example.com/live.m3u8' },
    { url: fixture.url + '?token=unknown' },
    { url: fixture.url.replace('eu2.', 'user:pass@eu2.') },
    { url: fixture.url.replace('bukovel8', 'unreviewed') },
    { url: fixture.url.replace(':5443', '') },
    { liveOnly: false }, { liveOnly: undefined }, { playbackKind: 'clip' },
    { feedType: 'image' }, { country: 'US' }, { verifiedAt: 'never' },
    { sourcePage: 'http://localhost/' }, { lat: null }, { lon: NaN },
    { verification: '' }, { credit: '' }, { id: '../camera' },
  ]) assert.deepEqual(normalizeUkraineCctvSources([{ ...fixture, ...patch }]), [], JSON.stringify(patch));
  assert.equal(normalizeUkraineCctvSources([fixture, fixture, { ...fixture, id: 'ua-duplicate' }]).length, 1);
});

test('official embeds retain strict live-only policy and never become proxy URLs or snapshots', () => {
  const [row] = normalizeUkraineCctvSources([{ ...fixture, feedType: 'embed', embedUrl: 'https://www.youtube.com/embed/abcdefghijk', snapshotUrl: 'https://example.com/snapshot.jpg' }]);
  assert.equal(row.embedUrl, 'https://www.youtube-nocookie.com/embed/abcdefghijk');
  assert.equal(row.liveOnly, true);
  assert.equal(row.snapshotUrl, null);
});

test('missing or malformed Ukraine registry is isolated; custom source roots are respected', async (t) => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'gev-ua-cameras-'));
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  assert.deepEqual(loadUkraineCctvSources({ sourceRoot }), []);
  await mkdir(path.join(sourceRoot, 'config'));
  const file = path.join(sourceRoot, 'config/cctv_sources.ukraine.json');
  await writeFile(file, '{broken');
  assert.deepEqual(loadUkraineCctvSources({ sourceRoot }), []);
  await writeFile(file, JSON.stringify([fixture]));
  assert.equal(loadUkraineCctvSources({ sourceRoot })[0].id, fixture.id);
});
