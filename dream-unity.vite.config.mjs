import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from './build/vite.js';
import { resolveBuildSourceCommit } from './build/source-commit.mjs';
export { resolveBuildSourceCommit } from './build/source-commit.mjs';

// Compile the full upstream browser application without starting its local
// provider server or exposing its local credential-setting endpoint.
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const config = createBrowserViteConfig({
    googleApiKey: env.GOOGLE_MAPS_API_KEY,
    cesiumToken: env.CESIUM_ION_TOKEN,
    embedParentOrigins: (
      env.DU_EMBED_PARENT_ORIGINS || 'https://dreamunity.one'
    )
      .split(',')
      .map((value) => value.trim()),
    sourceCommit: resolveBuildSourceCommit(env),
  });
  config.define['import.meta.env.GEV_HOSTED'] = 'true';
  return config;
});
