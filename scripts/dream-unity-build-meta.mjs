import { writeFile } from 'node:fs/promises';
import { resolveBuildSourceCommit } from '../build/source-commit.mjs';

const commit = resolveBuildSourceCommit(process.env);
await writeFile(
  'dist/build-info.json',
  JSON.stringify(
    {
      repository: 'dream-unity/November-1st',
      commit,
      upstream: 'bilawalsidhu/gods-eye-view',
      upstreamCommit: '0d41b6be5490db1f10a171f238be75db4d4ec3b4',
      builtAt: new Date().toISOString(),
      application: 'complete-upstream-with-dream-unity-host',
    },
    null,
    2,
  ) + '\n',
);
