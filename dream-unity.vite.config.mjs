import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from './build/vite.js';

// Compile the full upstream browser application without starting its local
// provider server or exposing its local credential-setting endpoint.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  return createBrowserViteConfig({
    googleApiKey: env.GOOGLE_MAPS_API_KEY,
    cesiumToken: env.CESIUM_ION_TOKEN,
  });
});
