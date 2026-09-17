import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  cleanRadioText,
  normalizeRadioBrowserStation,
  publicRadioHttpsUrl,
  publicRadioStation,
} from './radio/stations.js';
import {
  RADIO_DIRECTORY_CACHE_MS,
  RADIO_DIRECTORY_STALE_MS,
  RADIO_CATALOG_TIMEOUT_MS,
  RADIO_UUID_RE,
} from './radio/constants.js';

export const UKRAINE_RADIO_LIMIT = 600;
const PARTIAL_RETRY_MS = 60_000;
const UUID_URL_NAMESPACE = Buffer.from(
  '6ba7b8119dad11d180b400c04fd430c8',
  'hex',
);

function curatedStationId(key) {
  const bytes = createHash('sha1')
    .update(UUID_URL_NAMESPACE)
    .update(`https://dream-unity.github.io/November-1st/radio/ukraine/${key}`)
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Editorial entries are public broadcaster streams, never fabricated map pins. */
export function normalizeUkraineRadioSources(records) {
  if (!Array.isArray(records)) return [];
  const result = [];
  const seenIds = new Set();
  for (const row of records.slice(0, UKRAINE_RADIO_LIMIT)) {
    if (!row || typeof row !== 'object') continue;
    const streamUrl = publicRadioHttpsUrl(row.streamUrl);
    const sourcePage = publicRadioHttpsUrl(row.sourcePage || row.homepage);
    const verifiedAt =
      typeof row.verifiedAt === 'string' &&
      Number.isFinite(Date.parse(row.verifiedAt))
        ? new Date(row.verifiedAt).toISOString()
        : null;
    if (!streamUrl || !sourcePage || !verifiedAt || row.playbackKind !== 'live')
      continue;
    const id = curatedStationId(cleanRadioText(row.id, 200) || streamUrl);
    if (seenIds.has(id)) continue;
    const station = normalizeRadioBrowserStation(
      {
        stationuuid: id,
        name: row.name,
        url_resolved: streamUrl,
        homepage: row.homepage || sourcePage,
        geo_lat: row.lat,
        geo_long: row.lon,
        country: 'Ukraine',
        countrycode: 'UA',
        state: row.state || row.city,
        tags: Array.isArray(row.tags) ? row.tags.join(',') : row.tags,
        language: Array.isArray(row.languages)
          ? row.languages.join(',')
          : row.languages,
        codec: row.codec,
        bitrate: row.bitrate,
        lastcheckok: 1,
        hls: 0,
      },
      { requireGeo: false },
    );
    if (!station) continue;
    seenIds.add(id);
    result.push({
      ...station,
      sourceKind: 'curated-ukraine',
      metadataTrust: 'curated-public-source',
      sourcePage,
      verifiedAt,
      playbackKind: 'live',
      locationPrecision: station.lat === null ? 'unknown' : 'publisher-city',
    });
  }
  return result;
}

function readUkraineRegistry(sourceRoot) {
  try {
    const filename = path.resolve(
      sourceRoot,
      'config/radio_sources.ukraine.json',
    );
    if (fs.statSync(filename).size > 512 * 1024) return null;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

export function loadUkraineRadioSources({ sourceRoot = process.cwd() } = {}) {
  const records = readUkraineRegistry(sourceRoot);
  return normalizeUkraineRadioSources(
    Array.isArray(records) ? records : records?.stations,
  );
}

/** Only editorially documented mislabels/finite recordings are excluded. */
export function loadUkraineRadioExclusions({
  sourceRoot = process.cwd(),
} = {}) {
  const records = readUkraineRegistry(sourceRoot);
  const bounded = (values) =>
    Array.isArray(values) ? values.slice(0, 1000) : [];
  return {
    stationIds: new Set(
      bounded(records?.excludedStationIds)
        .filter((id) => typeof id === 'string' && RADIO_UUID_RE.test(id))
        .map((id) => id.toLowerCase()),
    ),
    streamUrls: new Set(
      bounded(records?.excludedStreamUrls)
        .map(publicRadioHttpsUrl)
        .filter(Boolean),
    ),
  };
}

function stationNameKey(name) {
  return name
    .normalize('NFKC')
    .toLocaleLowerCase('uk')
    .replace(/\b\d{2,4}\s*k(?:b(?:it)?s?|bps)?\b/gi, '')
    .replace(/\b(?:mp3|aac(?:\+|-lc|-he)?)\b/gi, '')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/(?:\s+(?:hd|hq|lq)|\s*[\[(]\s*(?:hd|hq|lq)\s*[\])])\s*$/i, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function stationNameKeys(station) {
  // Editorial bilingual titles explicitly separate aliases with an en/em dash.
  // Ordinary hyphens and community titles are not interpreted as alias lists.
  const components = station.name.split(/\s+[–—]\s+/);
  const bilingual =
    components.some((name) => /\p{Script=Cyrillic}/u.test(name)) &&
    components.some((name) => /\p{Script=Latin}/u.test(name) && !/\p{Script=Cyrillic}/u.test(name));
  const names =
    station.sourceKind === 'curated-ukraine' && bilingual
      ? [station.name, ...components]
      : [station.name];
  return [...new Set(names.map(stationNameKey).filter(Boolean))];
}

/** Prefer verified editorial URLs, then keep distinct programmes from the directory. */
export function mergeUkraineRadioStations(curated, directory) {
  const selected = [];
  const ids = new Set();
  const streams = new Set();
  const programmes = new Set();
  for (const station of [...curated, ...directory]) {
    if (!station || station.countryCode !== 'UA') continue;
    const programmeKeys = stationNameKeys(station);
    if (
      ids.has(station.id) ||
      streams.has(station.streamUrl) ||
      programmeKeys.some((key) => programmes.has(key))
    )
      continue;
    ids.add(station.id);
    streams.add(station.streamUrl);
    for (const key of programmeKeys) programmes.add(key);
    selected.push(station);
    if (selected.length >= UKRAINE_RADIO_LIMIT) break;
  }
  return selected;
}

function publicUkraineStation(station) {
  return {
    ...publicRadioStation(station),
    sourceKind: station.sourceKind || 'radio-browser',
    sourcePage: station.sourcePage || station.homepage,
    verifiedAt: station.verifiedAt || null,
    playbackKind: station.playbackKind || 'unknown',
    locationPrecision:
      station.locationPrecision ||
      (station.lat === null ? 'unknown' : 'directory'),
  };
}

/** Separate bounded country cache: expanding audio coverage does not inflate globe geometry. */
export function createUkraineRadioDirectory({
  fetchPath,
  now = Date.now,
  timeoutMs = RADIO_CATALOG_TIMEOUT_MS,
  loadSources = loadUkraineRadioSources,
  loadExclusions = loadUkraineRadioExclusions,
} = {}) {
  let cache = null;
  let lastResult = null;
  let retryAt = 0;
  let inflight = null;
  let generation = 0;
  let knownStations = new Map();

  async function refresh() {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Ukraine radio directory timed out', 'TimeoutError'),
        ),
      timeoutMs,
    );
    try {
      let curated = [];
      try {
        curated = loadSources();
      } catch {
        /* A bad local registry must not break upstream discovery. */
      }
      if (!Array.isArray(curated)) curated = [];
      let exclusions = { stationIds: new Set(), streamUrls: new Set() };
      try {
        exclusions = loadExclusions();
      } catch {
        /* An unavailable exclusion file does not broaden network destinations. */
      }
      const isIncluded = (station) =>
        !exclusions?.stationIds?.has(station.id) &&
        !exclusions?.streamUrls?.has(station.streamUrl);
      curated = curated.filter(isIncluded);
      let directory = [];
      let directoryHealthy = false;
      try {
        const params = new URLSearchParams({
          countrycode: 'UA',
          is_https: 'true',
          hidebroken: 'true',
          order: 'clickcount',
          reverse: 'true',
          limit: '1000',
        });
        const rows = await fetchPath(
          `/json/stations/search?${params}`,
          controller.signal,
        );
        if (!Array.isArray(rows))
          throw new Error('Malformed Ukraine radio directory');
        directory = rows
          .map((row) =>
            normalizeRadioBrowserStation(row, { requireGeo: false }),
          )
          .filter(
            (station) => station?.countryCode === 'UA' && isIncluded(station),
          );
        directoryHealthy = directory.length > 0;
      } catch {
        /* Serve a verified editorial or previously healthy directory during an outage. */
      }

      const timestamp = now();
      if (
        !directoryHealthy &&
        cache &&
        timestamp - cache.cachedAt <= RADIO_DIRECTORY_STALE_MS
      ) {
        return {
          ...cache,
          stale: true,
          degraded: true,
          degradedReason: 'ukraine-directory-refresh-unavailable',
        };
      }
      const selected = mergeUkraineRadioStations(curated, directory);
      if (!selected.length) throw new Error('No usable Ukraine radio stations');
      const next = {
        cachedAt: timestamp,
        updatedAt: new Date(timestamp).toISOString(),
        stations: selected.map(publicUkraineStation),
        stale: false,
        degraded: !directoryHealthy,
        degradedReason: directoryHealthy
          ? null
          : 'ukraine-directory-unavailable-using-curated',
        acceptedGeneration: directoryHealthy ? ++generation : null,
        coverage: {
          countryCode: 'UA',
          stationCount: selected.length,
          curatedStationCount: selected.filter(
            (station) => station.sourceKind === 'curated-ukraine',
          ).length,
          directoryStationCount: selected.filter(
            (station) => station.sourceKind !== 'curated-ukraine',
          ).length,
        },
      };
      knownStations = new Map(
        selected.map((station) => [
          station.id,
          station.sourceKind || 'radio-browser',
        ]),
      );
      if (directoryHealthy) cache = next;
      return next;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return {
    stationKind(id) {
      return knownStations.get(id);
    },
    async getCatalog() {
      const timestamp = now();
      if (cache && timestamp - cache.cachedAt < RADIO_DIRECTORY_CACHE_MS)
        return { ...cache, stale: false };
      if (
        lastResult &&
        timestamp < retryAt &&
        timestamp - lastResult.cachedAt <= RADIO_DIRECTORY_STALE_MS
      )
        return lastResult;
      if (!inflight) {
        inflight = refresh()
          .then((result) => {
            lastResult = result;
            retryAt = now() + PARTIAL_RETRY_MS;
            return result;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
  };
}
