/** Embed origins are build configuration, never URL-supplied authorization. */
export function validateEmbedOrigins(origins) {
  if (!Array.isArray(origins) || origins.length < 1 || origins.length > 8)
    throw new Error('Explicit embed parent origins are required');
  for (const origin of origins) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname))
      )
    )
      throw new Error('Invalid embed parent origin');
  }
  return [...new Set(origins)];
}

export function embedFramePolicyPlugin(origins) {
  const allowed = validateEmbedOrigins(origins);
  return {
    name: 'scoped-embed-frame-policy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const embedded = /^\/embed(?:\/|$)/.test((req.url || '').split('?')[0]);
        const writeHead = res.writeHead;
        res.writeHead = function (...args) {
          if (embedded) {
            res.removeHeader('X-Frame-Options');
            res.setHeader(
              'Content-Security-Policy',
              `frame-ancestors ${allowed.join(' ')}`,
            );
          } else {
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
          }
          return writeHead.apply(this, args);
        };
        next();
      });
    },
  };
}
