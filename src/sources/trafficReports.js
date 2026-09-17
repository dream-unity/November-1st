/** Official public incident coverage; this is separate from animated road flow. */
export const TRAFFIC_REPORT_REGIONS = Object.freeze([
  Object.freeze({
    id: 'austin',
    label: 'Austin / Travis County, Texas',
    source: 'City of Austin · CTECC',
    sourceUrl: 'https://data.austintexas.gov/d/dx9v-zd7x',
    coverage:
      'Active incidents reported by Austin / Travis County public safety agencies. The source updates approximately every five minutes.',
  }),
  Object.freeze({
    id: 'finland',
    label: 'Finland',
    source: 'Fintraffic · Digitraffic (CC BY 4.0)',
    sourceUrl: 'https://www.digitraffic.fi/en/road-traffic/',
    coverage:
      'Official Finnish road traffic announcements and roadworks. Some reports are available only in Finnish. Coverage is the publishing authority’s road network.',
  }),
]);

const text = (value, limit = 1200) =>
  typeof value === 'string' ? value.trim().slice(0, limit) : '';

export function trafficReportDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (
    !match ||
    Number(match[2]) > 23 ||
    Number(match[3]) > 59 ||
    Number(match[4]) > 59 ||
    Number(match[5] || 0) > 23 ||
    Number(match[6] || 0) > 59
  )
    return null;
  const calendarDate = Date.parse(match[1] + 'T00:00:00Z');
  if (
    !Number.isFinite(calendarDate) ||
    new Date(calendarDate).toISOString().slice(0, 10) !== match[1]
  )
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function number(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function coordinates(longitude, latitude) {
  const lon = number(longitude);
  const lat = number(latitude);
  return lon !== null &&
    lat !== null &&
    Math.abs(lon) <= 180 &&
    Math.abs(lat) <= 90
    ? { latitude: lat, longitude: lon }
    : null;
}

/** Keep an approximate first point for multi-point/line reports; never invent a centroid. */
function geometryPoint(geometry) {
  let value = geometry?.coordinates;
  for (let depth = 0; depth < 4 && Array.isArray(value); depth++) {
    if (!Array.isArray(value[0])) return coordinates(value[0], value[1]);
    value = value[0];
  }
  return null;
}

export function normalizeAustinTrafficReports(rows) {
  if (!Array.isArray(rows) || rows.length > 1000)
    throw new Error('Malformed Austin traffic reports');
  const reports = [];
  for (const row of rows) {
    if (row?.traffic_report_status !== 'ACTIVE') continue;
    const id = text(row.traffic_report_id, 180);
    const title = text(row.issue_reported, 180);
    const updatedAt = trafficReportDate(row.traffic_report_status_date_time);
    if (!id || !title || !updatedAt) continue;
    reports.push({
      id: `austin:${id}`,
      title,
      description: text(row.address),
      location: text(row.address),
      agency: text(row.agency, 180),
      status: 'active',
      kind: 'incident',
      updatedAt,
      startedAt: trafficReportDate(row.published_date),
      endsAt: null,
      position: coordinates(row.longitude, row.latitude),
      locationPrecision: 'reported point',
    });
  }
  // A schema drift must not masquerade as a successful empty road network.
  if (rows.length && !reports.length)
    throw new Error('Austin returned no usable active incident records');
  return deduplicateReports(reports);
}

export function normalizeFinlandTrafficReports(
  payload,
  { now = Date.now() } = {},
) {
  if (
    payload?.type !== 'FeatureCollection' ||
    !Array.isArray(payload.features) ||
    payload.features.length > 10000
  )
    throw new Error('Malformed Fintraffic reports');
  const reports = [];
  let validRecords = 0;
  for (const feature of payload.features) {
    const row = feature?.properties;
    if (!row || !Array.isArray(row.announcements)) continue;
    const announcement =
      row.announcements.find(
        (item) => text(item?.language).toLowerCase() === 'en',
      ) ||
      row.announcements.find(
        (item) => text(item?.language).toLowerCase() === 'fi',
      ) ||
      row.announcements[0];
    const id = text(row.situationId, 180);
    const title = text(announcement?.title, 240);
    const updatedAt = trafficReportDate(
      row.dataUpdatedTime || row.versionTime || row.releaseTime,
    );
    if (!id || !title || !updatedAt) continue;
    validRecords++;
    if (
      ['ended', 'retracted'].includes(row.trafficAnnouncementType) ||
      announcement.earlyClosing === 'closed'
    )
      continue;
    const startedAt = trafficReportDate(
      announcement.timeAndDuration?.startTime,
    );
    const endsAt = trafficReportDate(announcement.timeAndDuration?.endTime);
    if (endsAt && Date.parse(endsAt) < now) continue;
    const description = [
      text(announcement.comment),
      ...(Array.isArray(announcement.features)
        ? announcement.features
            .slice(0, 10)
            .map((entry) => text(entry?.name, 180))
        : []),
    ]
      .filter(Boolean)
      .join(' · ')
      .slice(0, 2400);
    reports.push({
      id: `finland:${id}`,
      title,
      description,
      location: text(announcement.location?.description),
      agency: text(announcement.sender, 180) || 'Fintraffic',
      status: startedAt && Date.parse(startedAt) > now ? 'planned' : 'active',
      kind: ['ROAD_WORK', 'road work'].includes(row.situationType)
        ? 'roadworks'
        : 'incident',
      updatedAt,
      startedAt,
      endsAt,
      position: geometryPoint(feature.geometry),
      locationPrecision:
        feature.geometry?.type === 'Point'
          ? 'reported point'
          : 'approximate report area',
      language: text(announcement.language, 8),
    });
  }
  if (payload.features.length && !validRecords)
    throw new Error('Fintraffic returned no usable records');
  return deduplicateReports(reports);
}

export function deduplicateReports(reports) {
  const byId = new Map();
  for (const report of reports) {
    const previous = byId.get(report.id);
    if (
      !previous ||
      Date.parse(report.updatedAt) > Date.parse(previous.updatedAt)
    )
      byId.set(report.id, report);
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
}
