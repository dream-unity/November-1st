// src/data/firmsAdapt.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adaptFirmsRecords,
  normalizeConfidence,
  normalizeSensor,
  parseAcquisitionMs,
} from './firmsAdapt.js';

/** A proxy record as served by /api/firms (firmsCsv.js parser shape). */
const proxyRecord = (overrides = {}) => ({
  lat: 38.99488,
  lon: -121.67046,
  frp: 0.53,
  confidence: 'n',
  brightness: 303.6,
  brightnessTi5: 290.73,
  daynight: 'N',
  acqDate: '2026-07-16',
  acqTime: '1006',
  satellite: 'N20',
  instrument: 'VIIRS',
  ...overrides,
});

test('adapter maps a proxy record into the internal fire-record shape', () => {
  const [fire] = adaptFirmsRecords([proxyRecord()]);
  assert.equal(fire.index, 0);
  assert.equal(fire.lat, 38.99488);
  assert.equal(fire.lon, -121.67046);
  assert.equal(fire.frp, 0.53);
  assert.equal(fire.confidence, 0.6); // 'n' (nominal) → 0.6
  assert.equal(fire.brightness, 303.6);
  assert.equal(fire.night, true); // daynight 'N'
  assert.equal(fire.acqMs, Date.UTC(2026, 6, 16, 10, 6));
  assert.equal(fire.sensor, 'VIIRS');
  assert.equal(fire.satellite, 'N20');
  assert.equal(fire.contextEntity, null);
  assert.equal(fire.position, null);
});

test('categorical confidence → 0..1 (l/n/h and word forms)', () => {
  assert.equal(normalizeConfidence('l'), 0.3);
  assert.equal(normalizeConfidence('n'), 0.6);
  assert.equal(normalizeConfidence('h'), 0.9);
  assert.equal(normalizeConfidence('low'), 0.3);
  assert.equal(normalizeConfidence('nominal'), 0.6);
  assert.equal(normalizeConfidence('high'), 0.9);
});

test('numeric confidence (MODIS-style) → value/100, clamped', () => {
  assert.equal(normalizeConfidence(85), 0.85);
  assert.equal(normalizeConfidence('85'), 0.85);
  assert.equal(normalizeConfidence(120), 1);
  assert.equal(normalizeConfidence('garbage'), 0);
});

test('unpadded acq_time parses in the adapter path ("45" = 00:45Z)', () => {
  const [fire] = adaptFirmsRecords([proxyRecord({ acqTime: '45' })]);
  assert.equal(fire.acqMs, Date.UTC(2026, 6, 16, 0, 45));
});

test('parseAcquisitionMs: memo cache is honored, invalid input → 0', () => {
  const cache = new Map();
  assert.equal(
    parseAcquisitionMs('2026-07-16', '1006', cache),
    Date.UTC(2026, 6, 16, 10, 6),
  );
  assert.equal(cache.size, 1);
  assert.equal(
    parseAcquisitionMs('2026-07-16', '1006', cache),
    Date.UTC(2026, 6, 16, 10, 6),
  );
  assert.equal(parseAcquisitionMs(undefined, '1006', cache), 0);
});

test('daynight "D" → night false', () => {
  const [fire] = adaptFirmsRecords([proxyRecord({ daynight: 'D' })]);
  assert.equal(fire.night, false);
});

test('sensor normalization: VIIRS/MODIS detected, junk truncated', () => {
  assert.equal(normalizeSensor('VIIRS'), 'VIIRS');
  assert.equal(normalizeSensor('some_modis_file'), 'MODIS');
  assert.equal(normalizeSensor(''), '');
  assert.equal(normalizeSensor('ABCDEFGHIJKLMNOP'), 'ABCDEFGHIJKL'); // 12-char cap
});

test('records with non-finite lat/lon are skipped; index stays sequential', () => {
  const fires = adaptFirmsRecords([
    proxyRecord(),
    proxyRecord({ lat: 'nope' }),
    proxyRecord({ lon: Infinity }),
    proxyRecord({ lat: 40.1 }),
  ]);
  assert.equal(fires.length, 2);
  assert.deepEqual(
    fires.map((f) => f.index),
    [0, 1],
  );
});

test('non-finite frp/brightness → 0; empty input → []', () => {
  const [fire] = adaptFirmsRecords([
    proxyRecord({ frp: 'n/a', brightness: undefined }),
  ]);
  assert.equal(fire.frp, 0);
  assert.equal(fire.brightness, 0);
  assert.deepEqual(adaptFirmsRecords([]), []);
  assert.deepEqual(adaptFirmsRecords(null), []);
});

test('missing and out-of-range coordinates do not turn into real detections at zero', () => {
  const invalid = [null, undefined, '', ' ', true, false, [], {}];
  const fires = adaptFirmsRecords([
    ...invalid.flatMap((value) => [
      proxyRecord({ lat: value }),
      proxyRecord({ lon: value }),
    ]),
    proxyRecord({ lat: 90.001 }),
    proxyRecord({ lat: -90.001 }),
    proxyRecord({ lon: 180.001 }),
    proxyRecord({ lon: -180.001 }),
    proxyRecord({ lat: 0, lon: 0 }),
    proxyRecord({ lat: '-90', lon: '180' }),
  ]);
  assert.deepEqual(
    fires.map(({ index, lat, lon }) => ({ index, lat, lon })),
    [
      { index: 0, lat: 0, lon: 0 },
      { index: 1, lat: -90, lon: 180 },
    ],
  );
});

test('invalid acquisition dates and times cannot normalize into a plausible observation', () => {
  for (const [date, time] of [
    ['2026-02-29', '1230'],
    ['2026-04-31', '1230'],
    ['2026-00-10', '1230'],
    ['2026-13-10', '1230'],
    ['2026-07-00', '1230'],
    ['2026x07x16', '1230'],
    ['2026-07-16junk', '1230'],
    ['2026-07-16', '2400'],
    ['2026-07-16', '1260'],
    ['2026-07-16', '12345'],
    ['2026-07-16', '-1'],
    ['2026-07-16', undefined],
    ['2026-07-16', ''],
    ['2026-07-16', '  '],
    ['2026-07-16', true],
  ])
    assert.equal(parseAcquisitionMs(date, time), 0, `${date} ${time}`);
  assert.equal(parseAcquisitionMs('2024-02-29', '0'), Date.UTC(2024, 1, 29));
  assert.equal(
    parseAcquisitionMs('2026-07-16', 45),
    Date.UTC(2026, 6, 16, 0, 45),
  );
});
