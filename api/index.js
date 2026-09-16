import { createProductionHost } from '../host/application.mjs';

let application;

/** Vercel's explicit /api/:path* rewrite forwards the original request URL. */
export default async function handler(req, res) {
  try {
    application ??= createProductionHost({ mode: 'serverless', serveStatic: false });
    const host = await application;
    host.handler(req, res);
  } catch {
    // Allow a failed cold start to retry; never disclose credentials in errors.
    application = undefined;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Provider host could not start' }));
  }
}
