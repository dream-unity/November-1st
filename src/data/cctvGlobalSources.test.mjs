import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeGlobalCctvSources, loadGlobalCctvSources } from '../../server/providers/cctv/globalSources.js';
import { normalizeSourceItem } from '../../server/providers/cctv/normalize.js';
import { normalizeCctvEmbedUrl, cameraMediaKind, isVideoFeedType } from '../sources/cctvTypes.js';

const sample = {
  id: 'test-fi-camera', name: 'Public square', country: 'FI', countryName: 'Finland',
  city: 'Helsinki', lat: 60.167, lon: 24.952, credit: 'Publisher',
  feedType: 'embed', playbackKind: 'live',
  embedUrl: 'https://www.youtube.com/embed/Cp4RRAEgpeU',
  sourcePage: 'https://example.org/camera', verifiedAt: '2026-09-17T00:00:00Z',
};

test('global catalogue validates every shipped entry, uniqueness, provenance and geographic ranges', () => {
  const records = JSON.parse(fs.readFileSync(new URL('../../config/cctv_sources.global.json', import.meta.url), 'utf8'));
  const sources = loadGlobalCctvSources();
  assert.ok(records.length >= 60);
  assert.equal(sources.length, records.length, 'invalid or duplicate shipped entries must fail CI');
  assert.ok(new Set(sources.map(s => s.country)).size >= 40);
  for (const source of sources) {
    assert.equal(cameraMediaKind(source), 'live');
    assert.equal(source.headingConfidence, 'low');
    assert.equal(source.poseSource, undefined);
    assert.ok(source.verification && source.sourcePage && source.credit && source.locationAccuracy);
  }
});

test('global catalogue excludes bad URLs, duplicate videos, invented geometry and unverified entries', () => {
  const valid = normalizeGlobalCctvSources([sample]);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].embedUrl, 'https://www.youtube-nocookie.com/embed/Cp4RRAEgpeU');
  const badPatches = [
    { id: '' }, { id: 123 }, { name: true }, { credit: {} }, { countryName: [] }, { country: 'Finland' }, { countryName: '' }, { credit: '' },
    { lat: null }, { lat: '60' }, { lat: 91 }, { lon: 181 }, { lon: NaN },
    { feedType: 'image' }, { playbackKind: 'clip' }, { verifiedAt: '' },
    { embedUrl: 'https://evil.example/embed/Cp4RRAEgpeU' },
    { sourcePage: 'javascript:alert(1)' }, { sourcePage: 'https://user:pass@example.org' },
  ];
  for (const patch of badPatches) assert.equal(normalizeGlobalCctvSources([{ ...sample, ...patch }]).length, 0, JSON.stringify(patch));
  assert.equal(normalizeGlobalCctvSources([sample, { ...sample, id: 'another-camera' }]).length, 1);
  assert.deepEqual(normalizeGlobalCctvSources(null), []);
});

test('global country rotation prevents the first large country pack occupying every early slot', () => {
  const rows = [
    sample,
    { ...sample, id: 'fi-second', embedUrl: 'https://www.youtube.com/embed/j88xuh4LBEc' },
    { ...sample, id: 'gb-first', country: 'GB', countryName: 'United Kingdom', embedUrl: 'https://www.youtube.com/embed/LMZQ7eFhm58' },
  ];
  assert.deepEqual(normalizeGlobalCctvSources(rows).map(s => s.id), ['test-fi-camera', 'gb-first', 'fi-second']);
});

test('official iframe URL validation excludes executable, credentialed, lookalike and injected URLs', () => {
  const good = 'https://www.youtube-nocookie.com/embed/Cp4RRAEgpeU';
  assert.equal(normalizeCctvEmbedUrl(good), good);
  for (const bad of [undefined, {}, 'javascript:alert(1)', 'http://www.youtube.com/embed/Cp4RRAEgpeU',
    good + '?autoplay=1', good + '#x', good + '/other', good + '\n',
    good.replace('www.youtube-nocookie.com', 'www.youtube-nocookie.com.evil.test'),
    good.replace('https://', 'https://user:pass@'), good.replace('.com/', '.com:8443/'),
    good.replace('/embed/', '/watch/'), good.replace('Cp4RRAEgpeU', 'too-short'),
  ]) assert.equal(normalizeCctvEmbedUrl(bad), '', String(bad));
  assert.equal(isVideoFeedType('embed'), false, 'protected embeds are not canvas-readable HTML video');
});

test('server normalization preserves global metadata while removing unsafe source links', () => {
  const source = normalizeSourceItem(sample);
  assert.equal(source.country, 'FI');
  assert.equal(source.countryName, 'Finland');
  assert.equal(source.embedUrl, 'https://www.youtube-nocookie.com/embed/Cp4RRAEgpeU');
  assert.equal(source.verifiedAt, '2026-09-17T00:00:00.000Z');
  assert.equal(normalizeSourceItem({ ...sample, country: 'Unknown', sourcePage: 'data:text/html,unsafe' }).sourcePage, '');
  assert.equal(normalizeSourceItem({ ...sample, country: 'Unknown' }).country, '');
});
