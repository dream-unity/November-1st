import fs from 'node:fs';
import path from 'node:path';
import { normalizeCctvEmbedUrl } from '../../../src/sources/cctvTypes.js';
import { safePublicSourcePage } from './normalize.js';

// These are owner-published civilian tourism streams, not discovered IP cameras.
// Adding a publisher requires an explicit review of its source page and player.
function approvedHls(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://eu2.camflg.com:5443' &&
      /^\/LiveApp\/streams\/bukovel(?:8|9|26|27|28)\.m3u8$/.test(
        url.pathname,
      ) &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Admit only reviewed, live-only public tourism sources with provenance. */
export function normalizeUkraineCctvSources(records) {
  if (!Array.isArray(records)) return [];
  const result = [];
  const ids = new Set();
  const media = new Set();
  for (const row of records) {
    if (!row || typeof row !== 'object') continue;
    const url =
      row.feedType === 'hls'
        ? approvedHls(row.url)
        : row.feedType === 'embed'
          ? normalizeCctvEmbedUrl(row.embedUrl)
          : null;
    const sourcePage = safePublicSourcePage(row.sourcePage);
    if (
      typeof row.id !== 'string' ||
      !/^ua-[a-z0-9_-]{2,97}$/.test(row.id) ||
      ids.has(row.id) ||
      !url ||
      media.has(url) ||
      !sourcePage ||
      row.country !== 'UA' ||
      row.playbackKind !== 'live' ||
      row.liveOnly !== true ||
      ![row.name, row.city, row.credit, row.verification].every(
        (value) => typeof value === 'string' && value.trim().length > 0,
      ) ||
      !Number.isFinite(Date.parse(row.verifiedAt)) ||
      typeof row.lat !== 'number' ||
      !Number.isFinite(row.lat) ||
      Math.abs(row.lat) > 90 ||
      typeof row.lon !== 'number' ||
      !Number.isFinite(row.lon) ||
      Math.abs(row.lon) > 180
    )
      continue;
    ids.add(row.id);
    media.add(url);
    result.push({
      ...row,
      url,
      sourcePage,
      countryName: 'Ukraine',
      embedUrl: row.feedType === 'embed' ? url : null,
      // A curated scene location is not a measured camera pose.
      headingConfidence: 'low',
      poseSource: undefined,
      provider: row.credit,
      sourceKind:
        row.feedType === 'embed' ? 'public-owner-embed' : 'public-owner-live',
      snapshotUrl: null,
      license:
        row.rights ||
        'Public owner-published tourism stream; footage remains the publisher’s property.',
    });
  }
  return result;
}

export function loadUkraineCctvSources({ sourceRoot = process.cwd() } = {}) {
  try {
    return normalizeUkraineCctvSources(
      JSON.parse(
        fs.readFileSync(
          path.resolve(sourceRoot, 'config/cctv_sources.ukraine.json'),
          'utf8',
        ),
      ),
    );
  } catch {
    return [];
  }
}
