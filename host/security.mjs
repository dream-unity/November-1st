import { timingSafeEqual } from 'node:crypto';

export function json(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function equalSecret(a, b) {
  const first = Buffer.from(a || '');
  const second = Buffer.from(b || '');
  return first.length === second.length && timingSafeEqual(first, second);
}

export function hostSecurity(config, env = process.env) {
  // Bounded, process-wide quota is deliberately conservative behind proxies.
  // Never trust caller-provided X-Forwarded-For to mint fresh quota buckets.
  let windowStart = 0;
  let paidRequests = 0;
  const limit = Math.max(1, Math.min(1000, Number(env.GEV_PAID_REQUESTS_PER_MINUTE) || 30));
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    let pathname;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error();
      pathname = decodeURIComponent(req.url.split('?')[0]).toLowerCase();
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part === '..')) throw new Error();
    } catch {
      return json(res, 400, { error: 'Invalid request path' });
    }
    // Connect compares case-insensitively and accepts a dot as a mount
    // boundary. Match its complete admission surface before any providers.
    const under = (route) => pathname === route || pathname.startsWith(`${route}/`) || pathname.startsWith(`${route}.`);
    const isApi = under('/api');
    const origin = req.headers.origin;
    if (isApi && origin) {
      const sameOrigin = origin === `https://${req.headers.host}` || origin === `http://${req.headers.host}`;
      if (!sameOrigin && !config.allowedOrigins.includes(origin)) return json(res, 403, { error: 'Origin is not allowed' });
      if (!sameOrigin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges');
      }
    }
    if (isApi && req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const auth = String(req.headers.authorization || '');
    const serviceAuthenticated = isApi && config.serviceToken && equalSecret(auth, `Bearer ${config.serviceToken}`);
    let basicAuthenticated = false;
    if (config.basicAuth && auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      basicAuthenticated = equalSecret(decoded, `${config.basicAuth.username}:${config.basicAuth.password}`);
    }
    if (config.basicAuth && !basicAuthenticated && !serviceAuthenticated) {
      return json(res, 401, { error: 'Sign in to this deployment' }, { 'WWW-Authenticate': 'Basic realm="Dream Unity", charset="UTF-8"' });
    }
    // The development-only key editor and conversation log writer must never
    // be reachable from an internet deployment, regardless of credentials.
    if (under('/api/setup') || under('/api/realtime/debug-log')) {
      return json(res, 404, { error: 'Endpoint unavailable on hosted deployments' });
    }
    const hasOpenAi = Boolean(String(env.OPENAI_API_KEY || '').trim());
    const hasGoogle = Boolean(String(env.GOOGLE_MAPS_SERVER_API_KEY || env.GOOGLE_MAPS_API_KEY || '').trim());
    const paid = (hasOpenAi && (under('/api/realtime') || under('/api/openai')))
      || (hasGoogle && (under('/api/google') || under('/api/cctv/frame')));
    if (paid) {
      if (!basicAuthenticated && !serviceAuthenticated && !config.allowPaidPublic) {
        return json(res, 403, { error: 'This metered provider requires deployment authentication', configured: true });
      }
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; paidRequests = 0; }
      if (++paidRequests > limit) return json(res, 429, { error: 'Metered provider request limit reached' }, { 'Retry-After': '60' });
    }
    next();
  };
}
