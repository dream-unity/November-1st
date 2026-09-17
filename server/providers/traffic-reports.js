import { readResponseJsonCapped } from './common/http.js';
import {
  TRAFFIC_REPORT_REGIONS,
  deduplicateReports,
  normalizeAustinTrafficReports,
  normalizeFinlandTrafficReports,
  trafficReportDate,
} from '../../src/sources/trafficReports.js';

const TTL_MS = 60_000;
const STALE_LIMIT_MS = 15 * 60_000;
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_REPORTS = 1500;
const AUSTIN_DATA = 'https://data.austintexas.gov/resource/dx9v-zd7x.json';
const AUSTIN_METADATA = 'https://data.austintexas.gov/api/views/dx9v-zd7x.json';
const FINLAND_ROOT = 'https://tie.digitraffic.fi/api/traffic-message/v2/';

function sourceTimestamp(value, now) {
  const date = trafficReportDate(value);
  if (!date || Date.parse(date) > now + 5 * 60_000)
    throw new Error('Invalid official traffic source timestamp');
  return date;
}

/** Preserve serverless response limits without hiding that coverage was capped. */
function boundReports(reports) {
  let bytes = 0;
  const selected = [];
  for (const report of reports) {
    bytes += Buffer.byteLength(JSON.stringify(report), 'utf8') + 1;
    if (bytes > 3_500_000 || selected.length >= MAX_REPORTS) break;
    selected.push(report);
  }
  return { reports: selected, partial: selected.length < reports.length };
}

/** No user-supplied URL, provider key, geocoder, or simulated incident source. */
export function createTrafficReportsMiddleware({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const retryAfter = new Map();

  async function request(url, signal) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'Digitraffic-User': 'DreamUnity-November1st/1.0',
      },
      signal,
      redirect: 'error',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Official traffic source unavailable');
    }
    return readResponseJsonCapped(response, MAX_BYTES, signal);
  }

  async function refresh(region) {
    const signal = AbortSignal.timeout(20_000);
    let reports;
    let sourceUpdatedAt = null;
    if (region === 'austin') {
      const url = new URL(AUSTIN_DATA);
      url.searchParams.set('$where', "traffic_report_status='ACTIVE'");
      url.searchParams.set('$order', 'published_date DESC');
      url.searchParams.set('$limit', '1000');
      const [rows, metadata] = await Promise.all([
        request(url.href, signal),
        request(AUSTIN_METADATA, signal),
      ]);
      reports = normalizeAustinTrafficReports(rows);
      if (
        !Number.isFinite(metadata?.rowsUpdatedAt) ||
        metadata.rowsUpdatedAt <= 0
      )
        throw new Error('Missing Austin source update time');
      sourceUpdatedAt = sourceTimestamp(
        new Date(metadata.rowsUpdatedAt * 1000).toISOString(),
        now(),
      );
      // Reaching the API cap is explicit, never presented as exhaustive coverage.
      return {
        ...boundReports(reports),
        fetchedAt: new Date(now()).toISOString(),
        sourceUpdatedAt,
        partial: rows.length >= 1000,
        sourceStale: now() - Date.parse(sourceUpdatedAt) > 20 * 60_000,
      };
    }
    const snapshots = await Promise.all([
      request(FINLAND_ROOT + 'traffic-announcements', signal),
      request(FINLAND_ROOT + 'roadworks', signal),
    ]);
    reports = deduplicateReports(
      snapshots.flatMap((payload) =>
        normalizeFinlandTrafficReports(payload, { now: now() }),
      ),
    );
    // Both categories must be current; the newest one cannot mask a frozen peer.
    const sourceTimes = snapshots.map((payload) =>
      sourceTimestamp(payload.dataUpdatedTime, now()),
    );
    sourceUpdatedAt = sourceTimes.sort()[0];
    return {
      ...boundReports(reports),
      fetchedAt: new Date(now()).toISOString(),
      sourceUpdatedAt,
      sourceStale: now() - Date.parse(sourceUpdatedAt) > 20 * 60_000,
    };
  }

  return async (req, res) => {
    const send = (status, payload, extra = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload));
    };
    if (!['GET', 'HEAD'].includes(req.method))
      return send(405, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' });
    const url = new URL(req.url || '/', 'https://localhost');
    if (url.pathname === '/regions')
      return send(200, { regions: TRAFFIC_REPORT_REGIONS });
    if (url.pathname !== '/reports') return send(404, { error: 'not_found' });
    const regionId = url.searchParams.get('region') || 'austin';
    const region = TRAFFIC_REPORT_REGIONS.find(
      (entry) => entry.id === regionId,
    );
    if (
      !region ||
      [...url.searchParams.keys()].some((key) => key !== 'region') ||
      url.searchParams.getAll('region').length > 1
    )
      return send(400, {
        error: 'invalid_region',
        regions: TRAFFIC_REPORT_REGIONS,
      });

    let snapshot = cache.get(regionId);
    let refreshFailed = false;
    if (!snapshot || now() - Date.parse(snapshot.fetchedAt) >= TTL_MS) {
      if ((retryAfter.get(regionId) || 0) > now()) {
        refreshFailed = true;
      } else {
        if (!inflight.has(regionId)) {
          const operation = refresh(regionId)
            .then((fresh) => {
              cache.set(regionId, fresh);
              retryAfter.delete(regionId);
              return fresh;
            })
            .catch(() => {
              retryAfter.set(regionId, now() + 30_000);
              return null;
            })
            .finally(() => inflight.delete(regionId));
          inflight.set(regionId, operation);
        }
        const fresh = await inflight.get(regionId);
        if (fresh) snapshot = fresh;
        else refreshFailed = true;
      }
    }
    if (!snapshot || now() - Date.parse(snapshot.fetchedAt) > STALE_LIMIT_MS)
      return send(
        503,
        {
          error: 'TRAFFIC_REPORTS_UNAVAILABLE',
          message:
            'The official traffic feed could not be refreshed. Try again shortly.',
          region,
        },
        { 'Retry-After': '30' },
      );

    const stale = refreshFailed || snapshot.sourceStale;
    return send(200, {
      ...snapshot,
      region,
      stale,
      status: stale ? 'stale' : snapshot.partial ? 'partial' : 'ready',
      message: refreshFailed
        ? 'Refresh failed. Showing the last successful snapshot; conditions may have changed.'
        : snapshot.sourceStale
          ? 'The publishing authority has not updated this feed recently; conditions may have changed.'
          : null,
    });
  };
}

export function trafficReportsProxy(options) {
  const middleware = createTrafficReportsMiddleware(options);
  const install = (server) => {
    server.middlewares.use('/api/traffic', middleware);
  };
  return {
    name: 'traffic-reports-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
