import test from 'node:test';
import assert from 'node:assert/strict';
import { createCatalogModel } from './catalogModel.js';
import { createModel } from './model.js';
import { isCuratedLiveRadioHls } from './hlsPlayback.js';

const catalog = createCatalogModel({});
const model = createModel({});
const station = {
  id: '00000000-0000-4000-8000-000000000031',
  name: 'Verified Australian radio fixture',
  lat: -42.88,
  lon: 147.33,
  streamUrl: 'https://broadcaster.example.org/live.m3u8',
  homepage: 'https://broadcaster.example.org/',
  sourcePage: 'https://broadcaster.example.org/listen',
  verifiedAt: '2026-09-17T08:00:00.000Z',
  tags: ['news'],
  languages: ['English'],
  state: 'Tasmania',
  country: 'Australia',
  countryCode: 'AU',
  metadataTrust: 'curated-public-source',
  codec: 'AAC',
  bitrate: 64,
  streamFormat: 'hls',
  liveOnly: true,
  playbackKind: 'live',
  sourceKind: 'curated-australia',
};

test('curated HLS admission and provenance survive both globe snapshot freezes', () => {
  assert.equal(catalog.isValidRadioDirectoryStation(station), true);
  const row = catalog.freezeRadioStation({
    ...station,
    privateExtension: { token: 'omit' },
  });
  const snapshot = catalog.createAcceptedCatalogSnapshot(
    'fixture',
    1,
    station.verifiedAt,
    [row],
  );
  const frozen = snapshot.stations[0];
  assert.equal(catalog.isValidRadioDirectoryStation(frozen), true);
  assert.equal(
    isCuratedLiveRadioHls(frozen),
    true,
    'globe playback receives the same strict HLS admission as the directory',
  );
  assert.equal(frozen.sourcePage, station.sourcePage);
  assert.equal(frozen.verifiedAt, station.verifiedAt);
  assert.equal('privateExtension' in frozen, false);
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.tags), true);
  assert.equal(Object.isFrozen(frozen.languages), true);
});

test('globe admission still requires real coordinates and rejects unverified or community HLS', () => {
  for (const changes of [
    { lat: null, lon: null },
    { lat: undefined },
    { metadataTrust: 'untrusted-community' },
    { sourceKind: 'radio-browser' },
    { countryCode: 'UA' },
    { playbackKind: 'recording' },
    { liveOnly: false },
    { sourcePage: 'http://broadcaster.example.org/' },
    { verifiedAt: 'invalid' },
  ]) {
    assert.equal(
      catalog.isValidRadioDirectoryStation({ ...station, ...changes }),
      false,
      JSON.stringify(changes),
    );
  }
});

test('frozen tuner resolution invalidates when any live playback permission changes', () => {
  const frozen = catalog.freezeRadioStation(station);
  assert.equal(
    model.radioStationResolutionMatches(frozen, { ...station }),
    true,
  );
  for (const [key, value] of [
    ['streamFormat', 'progressive'],
    ['liveOnly', false],
    ['playbackKind', 'recording'],
    ['sourceKind', 'radio-browser'],
  ]) {
    assert.equal(
      model.radioStationResolutionMatches(frozen, { ...station, [key]: value }),
      false,
      key,
    );
  }
});

test('existing progressive community stations retain their exact public snapshot shape', () => {
  const community = {
    ...station,
    streamUrl: 'https://broadcaster.example.org/live.mp3',
    metadataTrust: 'untrusted-community',
  };
  for (const key of [
    'sourcePage',
    'verifiedAt',
    'sourceKind',
    'streamFormat',
    'liveOnly',
    'playbackKind',
  ])
    delete community[key];
  assert.equal(catalog.isValidRadioDirectoryStation(community), true);
  assert.deepEqual(catalog.freezeRadioStation(community), community);
  for (const key of [
    'sourcePage',
    'verifiedAt',
    'sourceKind',
    'streamFormat',
    'liveOnly',
    'playbackKind',
  ]) {
    assert.equal(
      catalog.isValidRadioDirectoryStation({
        ...community,
        [key]: { mutable: true },
      }),
      false,
      key,
    );
  }
  assert.equal(
    catalog.isValidRadioDirectoryStation({
      ...community,
      sourceKind: 'radio-browser',
      streamFormat: 'progressive',
      liveOnly: false,
      playbackKind: 'unknown',
      verifiedAt: null,
      sourcePage: null,
    }),
    true,
  );
});
