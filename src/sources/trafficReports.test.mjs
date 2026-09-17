import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeAustinTrafficReports,
  normalizeFinlandTrafficReports,
  trafficReportDate,
} from './trafficReports.js';

const updated = '2026-09-17T02:00:00.000Z';
const now = Date.parse(updated);
const austin = (extra = {}) => ({
  traffic_report_id: '1',
  issue_reported: 'Collision',
  traffic_report_status: 'ACTIVE',
  traffic_report_status_date_time: updated,
  published_date: updated,
  latitude: '30.2',
  longitude: '-97.7',
  address: 'First / Main',
  ...extra,
});
const finnish = (extra = {}, announcement = {}) => ({
  type: 'Feature',
  geometry: {
    type: 'MultiLineString',
    coordinates: [
      [
        [24, 61],
        [25, 61],
      ],
    ],
  },
  properties: {
    situationId: '1',
    situationType: 'road work',
    versionTime: updated,
    announcements: [
      {
        language: 'fi',
        title: 'Finnish title',
        timeAndDuration: {
          startTime: '2026-09-17T01:00:00Z',
          endTime: '2026-09-18T01:00:00Z',
        },
        ...announcement,
      },
    ],
    ...extra,
  },
});
const collection = (features) => ({
  type: 'FeatureCollection',
  dataUpdatedTime: updated,
  features,
});

test('Austin only exposes active reports, preserving incident source timestamps', () => {
  const result = normalizeAustinTrafficReports([
    austin(),
    austin({ traffic_report_id: 'old', traffic_report_status: 'ARCHIVED' }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].updatedAt, updated);
  assert.deepEqual(result[0].position, { latitude: 30.2, longitude: -97.7 });
});
test('invalid coordinates stay absent rather than becoming an invented zero point', () => {
  for (const longitude of ['', null, false, 181, 'n/a'])
    assert.equal(
      normalizeAustinTrafficReports([austin({ longitude })])[0].position,
      null,
    );
});
test('empty official feed is valid; malformed nonempty schema is not an empty success', () => {
  assert.deepEqual(normalizeAustinTrafficReports([]), []);
  assert.throws(() => normalizeAustinTrafficReports({ error: 'down' }));
  assert.throws(() => normalizeAustinTrafficReports([{ status: 'active' }]));
  assert.throws(() =>
    normalizeFinlandTrafficReports(collection([{ properties: {} }])),
  );
});
test('Fintraffic v2 lower-case language and road work taxonomy are normalized', () => {
  const english = {
    language: 'en',
    title: 'English title',
    timeAndDuration: { startTime: updated },
  };
  const feature = finnish();
  feature.properties.announcements.push(english);
  const [report] = normalizeFinlandTrafficReports(collection([feature]), {
    now,
  });
  assert.equal(report.title, 'English title');
  assert.equal(report.kind, 'roadworks');
  assert.equal(report.language, 'en');
  assert.equal(report.locationPrecision, 'approximate report area');
  assert.deepEqual(report.position, { latitude: 61, longitude: 24 });
});
test('ended, retracted, closed and expired reports never remain active', () => {
  const features = [
    finnish({ trafficAnnouncementType: 'ended' }),
    finnish({ trafficAnnouncementType: 'retracted' }),
    finnish({}, { earlyClosing: 'closed' }),
    finnish({}, { timeAndDuration: { endTime: '2026-09-16T01:00:00Z' } }),
  ];
  assert.deepEqual(
    normalizeFinlandTrafficReports(collection(features), { now }),
    [],
  );
});
test('future works are planned and duplicate IDs retain their newest report', () => {
  const old = finnish({ versionTime: '2026-09-16T01:00:00Z' });
  const fresh = finnish(
    {},
    {
      title: 'Scheduled closure',
      timeAndDuration: { startTime: '2026-09-18T01:00:00Z' },
    },
  );
  const reports = normalizeFinlandTrafficReports(collection([fresh, old]), {
    now,
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'planned');
  assert.equal(reports[0].title, 'Scheduled closure');
});
test('date parsing rejects ambiguous input and impossible calendar or time values', () => {
  for (const value of [
    '',
    true,
    'September 17',
    '2026-02-30T01:00:00Z',
    '2026-09-17T24:00:00Z',
    '2026-09-17T01:60:00Z',
  ])
    assert.equal(trafficReportDate(value), null);
  assert.equal(trafficReportDate('2026-09-17T04:00:00+02:00'), updated);
});
