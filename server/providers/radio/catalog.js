import { lookup as lookupDns } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';

import { readResponseTextCapped } from '../common/http.js';
import {
  createUkraineRadioDirectory,
  loadUkraineRadioSources,
  loadUkraineRadioExclusions,
} from '../radioUkraine.js';
import {
  createAustraliaRadioDirectory,
  loadAustraliaRadioSources,
  loadAustraliaRadioExclusions,
} from '../radioAustralia.js';
import {
  normalizeRadioBrowserStation,
  publicRadioStation,
  cleanRadioText,
} from './stations.js';
import {
  radioMirrorOrigin,
  radioProxyDestination,
  resolveRadioProxyAddresses,
  fetchPinnedRadioResponse,
} from './transport.js';
import {
  RADIO_DIRECTORY_CACHE_MS,
  RADIO_DIRECTORY_STALE_MS,
  RADIO_MIRROR_CACHE_MS,
  RADIO_FETCH_TIMEOUT_MS,
  RADIO_CATALOG_TIMEOUT_MS,
  RADIO_DISCOVERY_TIMEOUT_MS,
  RADIO_CLICK_TIMEOUT_MS,
  RADIO_RESPONSE_MAX_BYTES,
  RADIO_DIRECTORY_LIMIT,
  RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES,
  RADIO_CATALOG_HEALTHY_MIN_STATIONS,
  RADIO_USER_AGENT,
  RADIO_UUID_RE,
  RADIO_FALLBACK_MIRRORS,
} from './constants.js';
export async function mapRadioConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Race every phase, including DNS or a non-cooperative upstream body, against cancellation. */
async function untilAborted(operation, signal) {
  signal.throwIfAborted();
  let abort;
  const cancellation = new Promise((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancellation]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Create the testable Connect middleware backing `/api/radio`. */
export function createRadioProxyMiddleware({
  fetchImpl = null,
  lookupImpl = lookupDns,
  now = Date.now,
  catalogTimeoutMs = RADIO_CATALOG_TIMEOUT_MS,
  fetchTimeoutMs = RADIO_FETCH_TIMEOUT_MS,
  discoveryTimeoutMs = RADIO_DISCOVERY_TIMEOUT_MS,
  sourceRoot = process.cwd(),
  loadUkraineSources = () => loadUkraineRadioSources({ sourceRoot }),
  loadUkraineExclusions = () => loadUkraineRadioExclusions({ sourceRoot }),
  loadAustraliaSources = () => loadAustraliaRadioSources({ sourceRoot }),
  loadAustraliaExclusions = () => loadAustraliaRadioExclusions({ sourceRoot }),
} = {}) {
  let mirrorCache = { origins: [...RADIO_FALLBACK_MIRRORS], cachedAt: 0 };
  let mirrorPromise = null;
  let catalogCache = null;
  let catalogGeneration = 0;
  // The generation counter is process-local, so it restarts from 1 with the
  // server. The instance token scopes each generation sequence: a client that
  // sees a new instance must treat the catalog as a fresh sequence, never as a
  // repeat ("still generation 1") or a regression ("generation went backward").
  const catalogInstance = randomUUID();
  let servedStationIds = new Set();
  let refreshPromise = null;

  async function fetchJson(
    url,
    maxBytes = RADIO_RESPONSE_MAX_BYTES,
    { signal, timeoutMs = fetchTimeoutMs } = {},
  ) {
    signal?.throwIfAborted();
    const destination = radioProxyDestination(url);
    if (!destination)
      throw new Error('Radio Browser destination is not permitted');
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Radio Browser request timed out', 'TimeoutError'),
        ),
      timeoutMs,
    );
    try {
      const addresses = await untilAborted(
        resolveRadioProxyAddresses(destination.hostname, lookupImpl),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const options = {
        headers: { Accept: 'application/json', 'User-Agent': RADIO_USER_AGENT },
        signal: controller.signal,
        redirect: 'manual',
      };
      const fetching = Promise.resolve(
        fetchImpl
          ? fetchImpl(destination.href, options)
          : fetchPinnedRadioResponse(destination, options, addresses),
      );
      // Some custom transports settle after cancellation. Release any late body
      // without admitting it to a newer catalogue or leaving its socket open.
      void fetching.then(
        (response) => {
          if (controller.signal.aborted)
            void response.body?.cancel?.().catch(() => {});
        },
        () => {},
      );
      const response = await untilAborted(fetching, controller.signal);
      if (!response.ok) {
        void response.body?.cancel?.().catch(() => {});
        if (response.status >= 300 && response.status < 400)
          throw new Error('Radio Browser redirects are refused');
        throw new Error(`Radio Browser returned ${response.status}`);
      }
      const text = await untilAborted(
        readResponseTextCapped(response, maxBytes, controller.signal),
        controller.signal,
      );
      controller.signal.throwIfAborted();
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function mirrors() {
    if (now() - mirrorCache.cachedAt < RADIO_MIRROR_CACHE_MS)
      return mirrorCache.origins;
    if (!mirrorPromise) {
      mirrorPromise = (async () => {
        try {
          const rows = await fetchJson(
            'https://all.api.radio-browser.info/json/servers',
            256 * 1024,
            { timeoutMs: discoveryTimeoutMs },
          );
          const discovered = [
            ...new Set(
              (Array.isArray(rows) ? rows : [])
                .map((row) => radioMirrorOrigin(row?.name))
                .filter(Boolean),
            ),
          ];
          if (discovered.length) {
            mirrorCache = {
              origins: [
                ...discovered,
                ...RADIO_FALLBACK_MIRRORS.filter(
                  (origin) => !discovered.includes(origin),
                ),
              ],
              cachedAt: now(),
            };
          } else {
            mirrorCache = { ...mirrorCache, cachedAt: now() };
          }
        } catch {
          mirrorCache = { ...mirrorCache, cachedAt: now() };
        }
        return mirrorCache.origins;
      })().finally(() => {
        mirrorPromise = null;
      });
    }
    return mirrorPromise;
  }

  async function fetchPath(pathname, signal) {
    signal.throwIfAborted();
    let lastError = null;
    for (const origin of await untilAborted(mirrors(), signal)) {
      signal.throwIfAborted();
      try {
        const result = await fetchJson(
          `${origin}${pathname}`,
          RADIO_RESPONSE_MAX_BYTES,
          { signal },
        );
        // Later specialist queries should begin with the mirror that just worked.
        // This avoids repeatedly spending the budget on an earlier dead mirror.
        mirrorCache.origins = [
          origin,
          ...mirrorCache.origins.filter((value) => value !== origin),
        ];
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('No Radio Browser mirror is available');
  }

  const ukraineDirectory = createUkraineRadioDirectory({
    fetchPath,
    now,
    timeoutMs: catalogTimeoutMs,
    loadSources: loadUkraineSources,
    loadExclusions: loadUkraineExclusions,
  });

  const australiaDirectory = createAustraliaRadioDirectory({
    fetchPath,
    now,
    timeoutMs: catalogTimeoutMs,
    loadSources: loadAustraliaSources,
    loadExclusions: loadAustraliaExclusions,
  });
  const countryDirectories = new Map([
    ['UA', ukraineDirectory],
    ['AU', australiaDirectory],
  ]);

  async function collectCatalog(signal) {
    // Documented finite recordings must stay excluded when a user returns to
    // the global directory as well as when browsing the relevant country.
    const excludedIds = new Set();
    const excludedUrls = new Set();
    for (const load of [loadUkraineExclusions, loadAustraliaExclusions]) {
      try {
        const exclusions = load();
        for (const id of exclusions?.stationIds || []) excludedIds.add(id);
        for (const url of exclusions?.streamUrls || []) excludedUrls.add(url);
      } catch {
        /* Optional editorial exclusions must not block the whole directory. */
      }
    }
    const queries = [
      null,
      'news',
      'talk',
      'weather',
      'emergency',
      'scanner',
      'aviation',
      'marine',
      'traffic',
    ];
    const outcomes = await mapRadioConcurrent(
      queries,
      3,
      async (tag, index) => {
        const params = new URLSearchParams({
          has_geo_info: 'true',
          is_https: 'true',
          hidebroken: 'true',
          order: 'clickcount',
          reverse: 'true',
          limit: index === 0 ? '1800' : '220',
        });
        if (tag) params.set('tag', tag);
        try {
          const rows = await fetchPath(
            `/json/stations/search?${params}`,
            signal,
          );
          if (!Array.isArray(rows))
            throw new Error('Radio Browser catalog payload was not an array');
          if (
            !rows.every(
              (row) =>
                row &&
                typeof row === 'object' &&
                !Array.isArray(row) &&
                typeof row.stationuuid === 'string' &&
                typeof row.name === 'string' &&
                (typeof row.url_resolved === 'string' ||
                  typeof row.url === 'string'),
            )
          )
            throw new Error(
              'Radio Browser catalog contained a malformed station row',
            );
          const stations = rows
            .map(normalizeRadioBrowserStation)
            .filter(
              (station) =>
                station &&
                !excludedIds.has(station.id) &&
                !excludedUrls.has(station.streamUrl),
            );
          const requestedTag = cleanRadioText(tag, 80)
            .toLocaleLowerCase()
            .replace(/[_-]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          const requestedTagCovered =
            !requestedTag ||
            stations.some((station) =>
              station.tags.some(
                (stationTag) =>
                  stationTag === requestedTag ||
                  stationTag.includes(requestedTag),
              ),
            );
          return {
            // Query coverage is based on accepted rows, not merely a payload that
            // happens to match the upstream schema. Specialist responses must
            // also contain an accepted station tagged for the requested category.
            succeeded: stations.length > 0 && requestedTagCovered,
            stations,
          };
        } catch {
          return { succeeded: false, stations: [] };
        }
      },
    );
    const resultSets = outcomes.map((outcome) => outcome.stations);

    const selected = [];
    const seen = new Set();
    const take = (station) => {
      if (
        !station ||
        seen.has(station.id) ||
        selected.length >= RADIO_DIRECTORY_LIMIT
      )
        return;
      seen.add(station.id);
      selected.push(station);
    };
    // Seed specialist station-tag queries before popularity fill so operational
    // categories remain represented even when global click charts skew musical.
    for (const rows of resultSets.slice(1)) rows.slice(0, 45).forEach(take);
    resultSets
      .flat()
      .sort(
        (a, b) => b.clickCount - a.clickCount || a.name.localeCompare(b.name),
      )
      .forEach(take);
    const timestamp = now();
    const successfulQueries = outcomes.filter(
      (outcome) => outcome.succeeded,
    ).length;
    const broadQueryHealthy =
      outcomes[0].succeeded && outcomes[0].stations.length > 0;
    const healthReasons = [];
    if (!broadQueryHealthy) healthReasons.push('broad-query-unhealthy');
    if (successfulQueries < RADIO_CATALOG_MIN_SUCCESSFUL_QUERIES)
      healthReasons.push('query-coverage-below-policy');
    if (selected.length < RADIO_CATALOG_HEALTHY_MIN_STATIONS)
      healthReasons.push('station-coverage-below-policy');
    const degraded = healthReasons.length > 0;
    const coverage = {
      successfulQueries,
      totalQueries: queries.length,
      stationCount: selected.length,
      healthyStationMinimum: RADIO_CATALOG_HEALTHY_MIN_STATIONS,
    };
    const nextCatalog = {
      cachedAt: timestamp,
      updatedAt: new Date(timestamp).toISOString(),
      stations: selected.map(publicRadioStation),
      stationIds: new Set(selected.map((station) => station.id)),
      degraded,
      degradedReason: degraded ? healthReasons.join(',') : null,
      coverage,
    };
    if (degraded && catalogCache) {
      const error = new Error(
        'Radio Browser catalog refresh did not meet health policy',
      );
      error.radioCatalogDegraded = true;
      error.radioDegradedReason = nextCatalog.degradedReason;
      error.radioCoverage = coverage;
      throw error;
    }
    if (degraded && !selected.length) {
      const error = new Error(
        'Radio Browser catalog refresh returned no usable stations',
      );
      error.radioCatalogDegraded = true;
      error.radioDegradedReason = nextCatalog.degradedReason;
      error.radioCoverage = coverage;
      throw error;
    }
    if (degraded) {
      servedStationIds = nextCatalog.stationIds;
      return { ...nextCatalog, acceptedGeneration: null };
    }
    catalogCache = {
      ...nextCatalog,
      acceptedGeneration: ++catalogGeneration,
    };
    servedStationIds = catalogCache.stationIds;
    return catalogCache;
  }

  async function refreshCatalog() {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException('Radio catalogue refresh timed out', 'TimeoutError'),
        ),
      catalogTimeoutMs,
    );
    try {
      // Each failed/timed-out query becomes an explicit unsuccessful outcome.
      // Completed queries still pass the same healthy/partial/stale admission.
      return await collectCatalog(controller.signal);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function getCatalog() {
    if (
      catalogCache &&
      now() - catalogCache.cachedAt < RADIO_DIRECTORY_CACHE_MS
    ) {
      return { ...catalogCache, stale: false };
    }
    if (!refreshPromise) {
      refreshPromise = refreshCatalog().finally(() => {
        refreshPromise = null;
      });
    }
    try {
      return { ...(await refreshPromise), stale: false };
    } catch (error) {
      if (
        catalogCache &&
        now() - catalogCache.cachedAt <= RADIO_DIRECTORY_STALE_MS
      ) {
        return {
          ...catalogCache,
          stale: true,
          degraded: true,
          degradedReason: error?.radioDegradedReason || 'refresh-failed',
          coverage: error?.radioCoverage || catalogCache.coverage,
        };
      }
      throw error;
    }
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  return async function radioProxyMiddleware(req, res) {
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    if (requestUrl.pathname === '/stations') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const country = requestUrl.searchParams.get('country');
      if (
        requestUrl.searchParams.getAll('country').length > 1 ||
        (country !== null && !countryDirectories.has(country.toUpperCase()))
      ) {
        sendJson(res, 400, {
          error:
            'The country directory currently supports country=UA or country=AU; omit country for the global directory.',
        });
        return;
      }
      try {
        const catalog = country
          ? await countryDirectories.get(country.toUpperCase()).getCatalog()
          : await getCatalog();
        sendJson(res, 200, {
          stations: catalog.stations,
          updatedAt: catalog.updatedAt,
          stale: catalog.stale,
          degraded: Boolean(catalog.degraded),
          degradedReason: catalog.degradedReason || null,
          coverage: catalog.coverage || null,
          acceptedGeneration: catalog.acceptedGeneration ?? null,
          catalogInstance,
        });
      } catch (error) {
        sendJson(res, 503, {
          error: 'Radio directory is temporarily unavailable',
          degraded: Boolean(error?.radioCatalogDegraded),
          degradedReason: error?.radioDegradedReason || null,
        });
      }
      return;
    }

    const clickMatch = requestUrl.pathname.match(/^\/click\/([0-9a-f-]+)$/i);
    if (clickMatch) {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      const id = clickMatch[1].toLowerCase();
      const countryStationKind = [...countryDirectories.values()]
        .map((directory) => directory.stationKind(id))
        .find(Boolean);
      if (
        !RADIO_UUID_RE.test(id) ||
        (!servedStationIds.has(id) && !countryStationKind)
      ) {
        sendJson(res, 404, { error: 'Unknown radio station' });
        return;
      }
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      // Editorial UUIDs are application identities, never Radio Browser vote IDs.
      if (countryStationKind?.startsWith('curated-')) return;
      void fetchPath(
        `/json/url/${id}`,
        AbortSignal.timeout(RADIO_CLICK_TIMEOUT_MS),
      ).catch(() => {});
      return;
    }

    sendJson(res, 404, { error: 'Unknown radio route' });
  };
}
