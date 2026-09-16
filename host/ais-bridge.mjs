import { json } from './security.mjs';

/** Fixed deployment-owned destination, restricted to the two AIS read routes. */
export function aisBridge(config, fetchImpl = fetch) {
  return async (req, res) => {
    const incoming = new URL(req.url || '/', 'http://localhost');
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    if (!['/', '/track'].includes(incoming.pathname)) return json(res, 404, { error: 'AIS route not found' });
    if (!config.aisOrigin) return json(res, 503, {
      rows: [], samples: [], source: 'AISStream', status: 'requires-persistent-service', refreshing: false,
      error: 'Live vessels require a persistent Node service. Configure GEV_PERSISTENT_API_ORIGIN or run npm start on a persistent host with AISSTREAM_API_KEY.',
    });
    const target = new URL(`/api/ais-live${incoming.pathname === '/' ? '' : '/track'}`, config.aisOrigin);
    // Never accept a client-supplied destination, path, key, or arbitrary header.
    for (const key of ['maxRows', 'mmsi']) if (incoming.searchParams.has(key)) target.searchParams.set(key, incoming.searchParams.get(key));
    // A Vercel response has a finite payload budget. Keep snapshots below it.
    if (incoming.pathname === '/') target.searchParams.set('maxRows', String(Math.max(1, Math.min(5000, Number(target.searchParams.get('maxRows')) || 5000))));
    try {
      const response = await fetchImpl(target, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Accept: 'application/json', ...(config.aisToken ? { Authorization: `Bearer ${config.aisToken}` } : {}) },
      });
      if (!response.headers.get('content-type')?.includes('application/json')) return json(res, 502, { error: 'Persistent AIS service returned an invalid response', rows: [] });
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4_000_000) { await reader.cancel(); return json(res, 502, { error: 'AIS snapshot exceeded hosted response limit', rows: [] }); }
          chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : Buffer.concat(chunks));
    } catch {
      json(res, 502, { error: 'Persistent AIS service could not be reached', rows: [], status: 'unavailable' });
    }
  };
}
