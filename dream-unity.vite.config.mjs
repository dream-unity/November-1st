import { defineConfig, loadEnv } from 'vite';
import { createBrowserViteConfig } from './build/vite.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Hydrated API deployments have pinned source metadata but no Git checkout. */
export function resolveBuildSourceCommit(env, cwd = process.cwd()) {
  const configured =
    env.DU_SOURCE_COMMIT || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA;
  if (configured) return configured;
  try {
    const pinned = JSON.parse(
      readFileSync(path.join(cwd, 'deploy-source.json'), 'utf8'),
    );
    if (!/^[a-f0-9]{40}$/.test(pinned.commit || ''))
      throw new Error('Pinned deployment source requires a valid commit');
    return pinned.commit;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'local-unversioned';
  }
}

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
