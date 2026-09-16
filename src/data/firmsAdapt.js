/**
 * Adapter from /api/firms proxy records (src/data/firmsCsv.js shape) to the
 * internal fire-record shape rendered by firmsHeatmap.js. Pure — no Cesium,
 * so the mapping is unit-testable. The normalization helpers previously
 * lived module-private in firmsHeatmap.js and moved here with the live-data
 * swap (2026-07-16).
 */

/**
 * Map proxy fire records into internal fire records. Records with
 * missing or invalid coordinates are skipped; `index` is the post-skip position
 * (it keys pick ids and context-store ids, so it must stay sequential).
 * `contextEntity`/`position` start null and are lazily filled by the layer.
 * @param {?Array<Object>} records - /api/firms `fires` array.
 * @returns {Array<Object>} Internal fire records.
 */
export function adaptFirmsRecords(records) {
  const fires = [];
  if (!Array.isArray(records)) return fires;
  const acqCache = new Map();
  for (const record of records) {
    if (
      !record ||
      !['number', 'string'].includes(typeof record.lat) ||
      !['number', 'string'].includes(typeof record.lon) ||
      String(record.lat).trim() === '' ||
      String(record.lon).trim() === ''
    )
      continue;
    const lat = Number(record?.lat);
    const lon = Number(record?.lon);
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180
    )
      continue;
    fires.push({
      index: fires.length,
      lat,
      lon,
      frp: finiteNumber(record.frp),
      confidence: normalizeConfidence(record.confidence),
      brightness: finiteNumber(record.brightness),
      night: record.daynight === 'N',
      acqMs: parseAcquisitionMs(record.acqDate, record.acqTime, acqCache),
      sensor: normalizeSensor(record.instrument),
      satellite: typeof record.satellite === 'string' ? record.satellite : '',
      contextEntity: null,
      position: null,
    });
  }
  return fires;
}

/**
 * Normalize FIRMS confidence to 0..1. VIIRS reports the categorical strings
 * low/nominal/high (`l`/`n`/`h`); MODIS reports 0..100 numeric.
 * @param {*} value - Raw confidence property.
 * @returns {number} Confidence in 0..1.
 */
export function normalizeConfidence(value) {
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'low' || text === 'l') return 0.3;
    if (text === 'nominal' || text === 'n') return 0.6;
    if (text === 'high' || text === 'h') return 0.9;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? clamp01(numeric / 100) : 0;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? clamp01(numeric / 100) : 0;
}

/**
 * Parse acq_date ("YYYY-MM-DD") + acq_time (unpadded "HHMM", UTC) into epoch
 * ms. Memoized per unique date:time pair — granule timestamps repeat heavily.
 * @param {*} date - acq_date property.
 * @param {*} time - acq_time property.
 * @param {Map<string, number>} [cache] - Per-batch memo cache.
 * @returns {number} Epoch milliseconds, or 0 when unparseable.
 */
export function parseAcquisitionMs(date, time, cache = new Map()) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  const key = `${date}:${time ?? ''}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  // Missing time is unknown, not an observed midnight. FIRMS permits unpadded
  // HHMM numbers, but Date.UTC must not normalize invalid dates or 24:60.
  const rawTime = String(time ?? '');
  const hhmm = rawTime.padStart(4, '0');
  const hours = Number(hhmm.slice(0, 2));
  const minutes = Number(hhmm.slice(2, 4));
  const valid =
    /^\d{1,4}$/.test(rawTime) &&
    year >= 100 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hours <= 23 &&
    minutes <= 59;
  let ms = valid ? Date.UTC(year, month - 1, day, hours, minutes) : 0;
  if (ms && new Date(ms).getUTCDate() !== day) ms = 0;
  cache.set(key, ms);
  return ms;
}

/**
 * Map sensor/instrument strings to a short display sensor name.
 * @param {*} value - Raw instrument property.
 * @returns {string}
 */
export function normalizeSensor(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('VIIRS')) return 'VIIRS';
  if (text.includes('MODIS')) return 'MODIS';
  return text ? text.slice(0, 12) : '';
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
