import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPOSITORY = 'dream-unity/November-1st';

function manifestCommit(cwd, filename, releaseOnly = false) {
  let bytes;
  try {
    bytes = readFileSync(path.join(cwd, filename), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes);
  } catch {
    throw new Error(`${filename} requires valid source identity metadata`);
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !/^[a-f0-9]{40}$/.test(manifest.commit || '') ||
    (releaseOnly &&
      (manifest.repository !== REPOSITORY ||
        Object.keys(manifest).some(
          (key) => !['repository', 'commit'].includes(key),
        )))
  )
    throw new Error(
      `${filename} requires a valid commit${releaseOnly ? ' and the fixed repository' : ''}`,
    );
  return manifest.commit;
}

/** Deployment ZIPs and hydrated API deployments may omit Git metadata. */
export function resolveBuildSourceCommit(env, cwd = process.cwd()) {
  const configured =
    env.DU_SOURCE_COMMIT || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA;
  if (configured) return configured;
  const pinned = manifestCommit(cwd, 'deploy-source.json');
  if (pinned) return pinned;
  // This deployment-only identity file never triggers bootstrap downloads and
  // is not part of publicDir or either HTML bundle input.
  const release = manifestCommit(cwd, 'release-source.json', true);
  if (release) return release;
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
