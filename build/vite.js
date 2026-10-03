import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';
import { fileURLToPath } from 'node:url';
import {
  embedFramePolicyPlugin,
  validateEmbedOrigins,
} from './embed-policy.js';

// Keep Cesium's development integration and copied workers/assets, but let the
// welcome entry load the production engine only after Continue. The stock tag
// blocks HTML parsing before the visitor can even see the entry choices.
function deferredCesiumPlugin(embedParentOrigins) {
  const plugin = cesium();
  const configureServer = plugin.configureServer;
  const framePolicy = embedFramePolicyPlugin(embedParentOrigins);
  // Preserve provider/plugin order while composing the scoped document policy
  // at the same build integration boundary that owns the Cesium middleware.
  plugin.configureServer = function (server) {
    const cleanup = configureServer?.call(this, server);
    framePolicy.configureServer(server);
    return cleanup;
  };
  const transform = plugin.transformIndexHtml;
  plugin.transformIndexHtml = function (...args) {
    const tags = transform.apply(this, args);
    return tags.filter(
      (tag) =>
        !(
          tag.tag === 'script' &&
          /(?:^|\/)cesium\/Cesium\.js$/.test(tag.attrs?.src || '')
        ),
    );
  };
  return plugin;
}

/** Build browser assets with explicit inputs; never load environment or providers. */
export function createBrowserViteConfig({
  plugins = [],
  publicDir,
  googleApiKey,
  cesiumToken,
  host = 'localhost',
  port = 4173,
  embedParentOrigins = ['https://dreamunity.one'],
  sourceCommit,
} = {}) {
  return {
    plugins: [
      deferredCesiumPlugin(embedParentOrigins),
      applicationHtmlPlugin(),
      ...plugins,
    ],
    ...(publicDir === undefined ? {} : { publicDir }),
    server: {
      host: host || 'localhost',
      port: parseInt(port, 10) || 4173,
      allowedHosts:
        host === '0.0.0.0' || host === '::'
          ? true
          : ['localhost', '127.0.0.1', '.local'],
      fs: {
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/ENVIRONMENT'],
      },
      // These headers protect the document containing Provider Settings.
      headers: {
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "frame-ancestors 'none'",
      },
    },
    define: {
      'import.meta.env.GOOGLE_MAPS_API_KEY': JSON.stringify(googleApiKey),
      'import.meta.env.CESIUM_ION_TOKEN': JSON.stringify(cesiumToken),
      'import.meta.env.DU_EMBED_PARENT_ORIGINS': JSON.stringify(
        validateEmbedOrigins(embedParentOrigins).join(','),
      ),
      'import.meta.env.DU_BUILD_COMMIT': JSON.stringify(sourceCommit),
    },
    build: {
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('../index.html', import.meta.url)),
          embed: fileURLToPath(new URL('../embed/index.html', import.meta.url)),
        },
      },
    },
  };
}
