import fs from 'node:fs';
import path from 'node:path';
import { normalizeCctvEmbedUrl } from '../../../src/sources/cctvTypes.js';
import { safePublicSourcePage } from './normalize.js';

/** Curated owner-published webcams. No arbitrary HTML, media scraping or private cameras. */
export function normalizeGlobalCctvSources(records) {
  if (!Array.isArray(records)) return [];
  const byCountry = new Map();
  const ids = new Set();
  const embeds = new Set();
  for (const row of records) {
    if (!row || typeof row !== 'object') continue;
    const embedUrl = normalizeCctvEmbedUrl(row.embedUrl);
    const sourcePage = safePublicSourcePage(row.sourcePage);
    const country = String(row.country || '').toUpperCase();
    const lat = row.lat;
    const lon = row.lon;
    if (
      typeof row.id !== 'string' ||
      !/^[a-z0-9][a-z0-9_-]{2,100}$/.test(row.id) ||
      ids.has(row.id) ||
      !embedUrl ||
      embeds.has(embedUrl) ||
      !sourcePage ||
      !/^[A-Z]{2}$/.test(country) ||
      ![row.countryName, row.name, row.credit].every(
        (value) => typeof value === 'string' && value.trim().length > 0,
      ) ||
      row.feedType !== 'embed' ||
      row.playbackKind !== 'live' ||
      !Number.isFinite(Date.parse(row.verifiedAt)) ||
      typeof lat !== 'number' ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      typeof lon !== 'number' ||
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180
    )
      continue;
    ids.add(row.id);
    embeds.add(embedUrl);
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country).push({
      ...row,
      country,
      embedUrl,
      url: embedUrl,
      sourcePage,
      provider: row.credit,
      sourceKind: 'public-owner-embed',
      headingConfidence: 'low',
      // A map location identifies the scene; it is not a surveyed camera pose.
      poseSource: undefined,
      license:
        row.rights ||
        'Owner-enabled official player; footage remains the publisher’s property.',
    });
  }
  // A lowered catalogue cap keeps geographical variety, not just the first country.
  const queues = [...byCountry.values()];
  const result = [];
  for (
    let index = 0;
    queues.some((queue) => index < queue.length);
    index += 1
  ) {
    for (const queue of queues) if (queue[index]) result.push(queue[index]);
  }
  return result;
}

export function loadGlobalCctvSources({ sourceRoot = process.cwd() } = {}) {
  try {
    return normalizeGlobalCctvSources(
      JSON.parse(
        fs.readFileSync(
          path.resolve(sourceRoot, 'config/cctv_sources.global.json'),
          'utf8',
        ),
      ),
    );
  } catch {
    return [];
  }
}
