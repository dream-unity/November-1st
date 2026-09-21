import { applicationHtmlPlugin } from './application-html.js';
import cesium from 'vite-plugin-cesium';

// Keep Cesium's development integration and copied workers/assets, but let the
// welcome entry load the production engine only after Continue. The stock tag
// blocks HTML parsing before the visitor can even see the entry choices.
function deferredCesiumPlugin() {
  const plugin = cesium();
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
} = {}) {
  return {
    plugins: [deferredCesiumPlugin(), applicationHtmlPlugin(), ...plugins],
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
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
}
