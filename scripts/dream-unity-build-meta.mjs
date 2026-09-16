import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

let commit = process.env.DU_SOURCE_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
if (!commit) {
  try { commit = JSON.parse(await readFile('deploy-source.json', 'utf8')).commit; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (!commit) {
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); }
  catch { commit = 'local-unversioned'; }
}
await writeFile('dist/build-info.json', JSON.stringify({
  repository: 'dream-unity/November-1st',
  commit,
  upstream: 'bilawalsidhu/gods-eye-view',
  upstreamCommit: '0d41b6be5490db1f10a171f238be75db4d4ec3b4',
  builtAt: new Date().toISOString(),
  application: 'complete-upstream-with-dream-unity-host',
}, null, 2) + '\n');
