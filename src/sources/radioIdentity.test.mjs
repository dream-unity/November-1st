import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRadioIdentity,
  reconcileRadioIdentities,
} from './radioIdentity.js';
import {
  normalizeRadioBrowserStation,
  publicRadioStation,
} from './radioBrowser.js';

const station = (overrides = {}) => ({
  id: 'b0fcc9da-9958-4729-9e23-4f7cc15e98b9',
  name: 'Local radio',
  streamUrl: 'https://stream.example.org/live',
  country: 'United Kingdom',
  countryCode: 'GB',
  state: 'London',
  lat: 52.13888133372091,
  lon: -1.124257231168735,
  metadataTrust: 'untrusted-community',
  ...overrides,
});

test('the known CNN domestic audio has one US identity despite misleading directory countries', () => {
  for (const [countryCode, country] of [
    ['GB', 'United Kingdom'],
    ['AU', 'Australia'],
    ['UG', 'Uganda'],
    ['US', 'United States'],
  ]) {
    const resolved = applyRadioIdentity(
      station({
        name: 'CNN UK',
        streamUrl: 'https://tunein.cdnstream1.com/2868_96.mp3',
        countryCode,
        country,
        city: 'London',
        locality: 'London',
        region: 'England',
        metroArea: 'melbourne',
      }),
    );
    assert.equal(resolved.name, 'CNN (US)');
    assert.equal(resolved.countryCode, 'US');
    assert.equal(resolved.country, 'United States');
    assert.equal(resolved.homepage, 'https://www.cnn.com/audio');
    assert.equal(resolved.countryStatus, 'verified');
    assert.equal(resolved.identitySource, 'https://tunein.com/cnn/');
    assert.equal(resolved.identityCheckedAt, '2026-09-23');
    assert.equal(resolved.metadataTrust, 'untrusted-community');
    assert.equal(resolved.state, '');
    assert.equal(resolved.city, '');
    assert.equal(resolved.locality, '');
    assert.equal(resolved.region, '');
    assert.equal(resolved.metroArea, '');
    assert.equal(resolved.lat, null);
    assert.equal(resolved.lon, null);
    assert.deepEqual(applyRadioIdentity(resolved), resolved);
  }
});

test('CNN identity correction does not guess from brand, host or another channel path', () => {
  for (const streamUrl of [
    'https://tunein.cdnstream1.com/3519_96.aac',
    'https://tunein.cdnstream1.com/3517_96_nn.mp3',
    'https://tunein.cdnstream1.com/2868_96.mp3?programme=other',
    'https://different.example/2868_96.mp3',
    'https://tunein.cdnstream1.com.evil.example/2868_96.mp3',
    'https://tunein.cdnstream1.com:444/2868_96.mp3',
    'http://tunein.cdnstream1.com/2868_96.mp3',
  ]) {
    const result = applyRadioIdentity(station({ name: 'CNN UK', streamUrl }));
    assert.equal(result.countryCode, 'GB', streamUrl);
    assert.equal(result.name, 'CNN UK', streamUrl);
    assert.equal(result.countryStatus, 'community');
  }
});

test('contradictory recognized country metadata remains playable without false geographic attribution', () => {
  const result = applyRadioIdentity(station({ countryCode: 'US' }));
  assert.equal(result.streamUrl, station().streamUrl);
  assert.equal(result.countryStatus, 'conflicting');
  assert.equal(result.country, '');
  assert.equal(result.countryCode, '');
  assert.equal(result.lat, null);
  assert.equal(result.lon, null);
  assert.equal(result.streamUrl, station().streamUrl);
  assert.deepEqual(applyRadioIdentity(result), result);
});

test('malformed country codes are never truncated and unrecognized formal names do not override valid codes', () => {
  assert.equal(
    applyRadioIdentity(station({ countryCode: 'USA', country: 'Atlantis' }))
      .countryCode,
    '',
  );
  assert.equal(
    applyRadioIdentity(station({ countryCode: 'GBrubbish', country: '' }))
      .countryStatus,
    'unknown',
  );
  assert.equal(
    applyRadioIdentity(station({ countryCode: '', country: 'France' }))
      .countryCode,
    'FR',
  );
  assert.equal(
    applyRadioIdentity(
      station({
        countryCode: 'GB',
        country: 'The United Kingdom Of Great Britain And Northern Ireland',
      }),
    ).countryCode,
    'GB',
  );
});

test('exact shared streams with different countries are deduplicated and marked unconfirmed', () => {
  const [result] = reconcileRadioIdentities([
    station(),
    station({
      id: 'other',
      country: 'France',
      countryCode: 'FR',
      state: 'Paris',
      streamUrl: `${station().streamUrl}#player`,
    }),
  ]);
  assert.equal(result.countryStatus, 'conflicting');
  assert.equal(result.countryCode, '');
  assert.equal(result.state, '');
  assert.equal(result.lat, null);
  assert.equal(result.lon, null);
  assert.equal(reconcileRadioIdentities([result]).length, 1);
  assert.equal(
    reconcileRadioIdentities([result])[0].countryStatus,
    'conflicting',
  );
});

test('distinct query-selected programmes and independent same-name stations stay distinct', () => {
  const rows = [
    station({ streamUrl: 'https://stream.example.org/live?channel=a' }),
    station({
      id: 'b',
      streamUrl: 'https://stream.example.org/live?channel=b',
      country: 'France',
      countryCode: 'FR',
    }),
    station({
      id: 'c',
      streamUrl: 'https://different.example.org/live',
      country: 'France',
      countryCode: 'FR',
    }),
  ];
  const result = reconcileRadioIdentities(rows);
  assert.equal(result.length, 3);
  assert.deepEqual(
    result.map((row) => row.countryCode),
    ['GB', 'FR', 'FR'],
  );
});

test('arbitrary community metadata cannot claim verification or inject an identity source', () => {
  const result = applyRadioIdentity(
    station({
      countryStatus: 'verified',
      identitySource: 'https://fake.example',
      identityCheckedAt: '2026-09-23',
    }),
  );
  assert.equal(result.countryStatus, 'community');
  assert.equal('identitySource' in result, false);
  assert.equal('identityCheckedAt' in result, false);
});

test('duplicates retain specialist tags and languages within the public record bounds', () => {
  const [result] = reconcileRadioIdentities([
    station({ tags: ['music'], languages: ['English'] }),
    station({
      id: 'specialist',
      tags: ['news', 'music'],
      languages: ['French', 'English'],
    }),
  ]);
  assert.deepEqual(result.tags, ['music', 'news']);
  assert.deepEqual(result.languages, ['English', 'French']);
  const [bounded] = reconcileRadioIdentities([
    station({
      tags: Array.from({ length: 24 }, (_, index) => `tag${index}`),
      languages: Array.from({ length: 8 }, (_, index) => `language${index}`),
    }),
    station({ tags: ['additional'], languages: ['additional'] }),
  ]);
  assert.equal(bounded.tags.length, 24);
  assert.equal(bounded.languages.length, 8);
});

test('source normalization corrects identity and the public projection retains its provenance', () => {
  const result = normalizeRadioBrowserStation({
    stationuuid: station().id,
    name: 'CNN UK',
    url_resolved: 'https://tunein.cdnstream1.com/2868_96.mp3',
    country: 'United Kingdom',
    countrycode: 'GB',
    state: 'London',
    geo_lat: 52,
    geo_long: -1,
    codec: 'MP3',
    lastcheckok: 1,
  });
  assert.equal(result.countryCode, 'US');
  const exposed = publicRadioStation(result);
  assert.equal(exposed.countryStatus, 'verified');
  assert.equal(exposed.identitySource, 'https://tunein.com/cnn/');
  assert.equal(exposed.lat, null);
});
