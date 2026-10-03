import test from 'node:test';
import assert from 'node:assert/strict';
import {
  embedFramePolicyPlugin,
  validateEmbedOrigins,
} from '../../build/embed-policy.js';

test('dev frame exception applies only to embed document and approved exact origins', () => {
  let middleware;
  embedFramePolicyPlugin([
    'https://dreamunity.one',
    'http://127.0.0.1:5173',
  ]).configureServer({
    middlewares: {
      use: (fn) => {
        middleware = fn;
      },
    },
  });
  for (const [url, expected] of [
    ['/embed/', 'frame-ancestors https://dreamunity.one http://127.0.0.1:5173'],
    ['/api/setup/status', "frame-ancestors 'none'"],
    ['/', "frame-ancestors 'none'"],
    ['/embedded-elsewhere/', "frame-ancestors 'none'"],
  ]) {
    const headers = new Map();
    const res = {
      setHeader: (key, value) => headers.set(key, value),
      removeHeader: (key) => headers.delete(key),
      writeHead() {},
    };
    middleware({ url }, res, () => {});
    res.writeHead(200);
    assert.equal(headers.get('Content-Security-Policy'), expected);
    assert.equal(headers.has('X-Frame-Options'), !url.startsWith('/embed/'));
  }
  assert.throws(() =>
    validateEmbedOrigins(['https://dreamunity.one/somewhere']),
  );
  assert.throws(() => validateEmbedOrigins(['http://untrusted.example']));
});
