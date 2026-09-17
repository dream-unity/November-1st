import fs from 'node:fs';
import path from 'node:path';
import { normalizeGlobalCctvSources } from './globalSources.js';
import { safePublicSourcePage } from './normalize.js';

const STATES = new Set([
  'Australian Capital Territory',
  'New South Wales',
  'Northern Territory',
  'Queensland',
  'South Australia',
  'Tasmania',
  'Victoria',
  'Western Australia',
  'External territories',
]);

/** Reviewed public players only. No image, clip, arbitrary iframe, or private camera. */
export function normalizeAustraliaCctvSources(records) {
  if (!Array.isArray(records)) return [];
  const valid = records.filter(
    (row) =>
      row &&
      typeof row === 'object' &&
      row.country === 'AU' &&
      typeof row.id === 'string' &&
      /^au-[a-z0-9_-]{2,97}$/.test(row.id) &&
      row.liveOnly === true &&
      row.playbackKind === 'live' &&
      STATES.has(row.state) &&
      Number.isFinite(Date.parse(row.verifiedAt)) &&
      safePublicSourcePage(row.sourcePage) &&
      typeof row.lat === 'number' &&
      Number.isFinite(row.lat) &&
      Math.abs(row.lat) <= 90 &&
      typeof row.lon === 'number' &&
      Number.isFinite(row.lon) &&
      Math.abs(row.lon) <= 180 &&
      [
        row.name,
        row.credit,
        row.city,
        row.verification,
        row.locationAccuracy,
      ].every((value) => typeof value === 'string' && value.trim().length > 0),
  );
  const sources = normalizeGlobalCctvSources(valid).map((row) => ({
    ...row,
    countryName: 'Australia',
    snapshotUrl: null,
  }));
  // If a deployment lowers the catalogue cap, retain a spread across states.
  const states = new Map();
  for (const row of sources) {
    if (!states.has(row.state)) states.set(row.state, []);
    states.get(row.state).push(row);
  }
  const queues = [...states.values()];
  const result = [];
  for (let index = 0; queues.some((queue) => index < queue.length); index++) {
    for (const queue of queues) if (queue[index]) result.push(queue[index]);
  }
  return result;
}

export function loadAustraliaCctvSources({ sourceRoot = process.cwd() } = {}) {
  try {
    const filename = path.resolve(
      sourceRoot,
      'config/cctv_sources.australia.json',
    );
    if (fs.statSync(filename).size > 2 * 1024 * 1024) return [];
    return normalizeAustraliaCctvSources(
      JSON.parse(fs.readFileSync(filename, 'utf8')),
    );
  } catch {
    return [];
  }
}

/** Sources that explicitly require watching on their publisher's website. */
export function loadAustraliaPublisherCameras({
  sourceRoot = process.cwd(),
} = {}) {
  try {
    const filename = path.resolve(
      sourceRoot,
      'config/cctv_sources.australia-publisher.json',
    );
    if (fs.statSync(filename).size > 512 * 1024) return [];
    const records = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!Array.isArray(records)) return [];
    const seen = new Set();
    return records
      .slice(0, 100)
      .filter((row) => {
        const sourcePage = safePublicSourcePage(row?.sourcePage);
        if (
          !row ||
          row.access !== 'publisher-only' ||
          row.country !== 'AU' ||
          row.liveOnly !== true ||
          row.playbackKind !== 'live' ||
          !STATES.has(row.state) ||
          ![row.id, row.name, row.city, row.verification].every(
            (value) => typeof value === 'string' && value.trim(),
          ) ||
          !Number.isFinite(Date.parse(row.verifiedAt)) ||
          !sourcePage ||
          seen.has(sourcePage)
        )
          return false;
        seen.add(sourcePage);
        return true;
      })
      .map((row) => ({
        id: row.id,
        name: row.name,
        city: row.city,
        state: row.state,
        country: 'AU',
        countryName: 'Australia',
        access: 'publisher-only',
        sourcePage: safePublicSourcePage(row.sourcePage),
        verifiedAt: new Date(row.verifiedAt).toISOString(),
      }));
  } catch {
    return [];
  }
}
