import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.pbf': 'application/x-protobuf', '.ktx2': 'image/ktx2', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

/** Serve the built application only; source files and dotfiles are never public. */
export function staticApplication(distDir) {
  const root = path.resolve(distDir);
  return async (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) return next();
    const pathname = decodeURIComponent(req.url.split('?')[0]);
    if (pathname.split('/').some((part) => part.startsWith('.'))) return next();
    const candidate = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!candidate.startsWith(`${root}${path.sep}`)) return next();
    try {
      // Realpath also prevents an accidentally included symlink escaping dist.
      const real = await fs.realpath(candidate);
      const realRoot = await fs.realpath(root);
      if (!real.startsWith(`${realRoot}${path.sep}`)) return next();
      const stat = await fs.stat(real);
      if (!stat.isFile()) return next();
      res.setHeader('Content-Type', MIME[path.extname(real).toLowerCase()] || 'application/octet-stream');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', /\/assets\/[^/]+-[\w-]{8,}\./.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache');
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(real);
      stream.on('error', (error) => { if (res.headersSent) res.destroy(error); else next(error); });
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return next();
      next(error);
    }
  };
}
