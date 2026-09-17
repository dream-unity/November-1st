import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const registry = JSON.parse(
  await readFile(
    new URL('../../config/radio_sources.australia.json', import.meta.url),
    'utf8',
  ),
).stations;

test('Melbourne registry has distinct local services with explicit provenance', () => {
  const local = registry.filter((station) => station.metroArea === 'melbourne');
  assert.ok(local.length >= 25);
  assert.equal(new Set(local.map((station) => station.id)).size, local.length);
  assert.equal(
    new Set(local.map((station) => station.streamUrl)).size,
    local.length,
  );
  for (const station of local) {
    assert.equal(station.city, 'Melbourne', station.name);
    assert.equal(station.region, 'Greater Melbourne', station.name);
    assert.equal(station.state, 'Victoria', station.name);
    assert.ok(
      ['metro', 'suburban'].includes(station.geographicScope),
      station.name,
    );
    assert.match(station.geographySourcePage, /^https:\/\//, station.name);
    assert.match(station.streamUrl, /^https:\/\//, station.name);
    assert.equal(station.playbackKind, 'live', station.name);
    assert.equal(station.lat, null, station.name);
    assert.equal(station.lon, null, station.name);
    const verification = station.verification;
    if (station.streamFormat === 'hls') {
      assert.equal(
        verification.advancingLiveSegments ?? verification.advance,
        true,
        station.name,
      );
      assert.ok(
        verification.endList === false || verification.liveVerified === true,
        station.name,
      );
      assert.equal(verification.segmentStatus, 200, station.name);
      assert.ok(
        (verification.segmentBytesSampled ?? verification.bytesSampled) > 0,
        station.name,
      );
    } else {
      assert.equal(verification.status, 200, station.name);
      assert.equal(verification.continuousTransport, true, station.name);
      assert.equal(verification.contentLength, null, station.name);
      assert.ok(verification.bytesSampled > 0, station.name);
    }
  }
});

test('national and regional Victorian services are not classified as Melbourne', () => {
  const outsideMelbourne = [
    'ABC Radio Ballarat',
    'ABC Radio Goulburn Murray',
    'ABC Jazz',
    'ABC NewsRadio',
    'SBS Radio 1',
    'SBS Radio 3',
    'Radio Mansfield 99.7FM',
  ];
  for (const name of outsideMelbourne) {
    const station = registry.find((entry) => entry.name === name);
    assert.ok(station, name);
    assert.notEqual(station.metroArea, 'melbourne', name);
  }
});
