import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveBuildSourceCommit } from '../../dream-unity.vite.config.mjs';

function gitlessSource(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'du-build-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('hydrated API deployments use the pinned source commit without Git metadata', (t) => {
  const root = gitlessSource(t);
  const commit = 'a'.repeat(40);
  writeFileSync(
    path.join(root, 'deploy-source.json'),
    JSON.stringify({ commit }),
  );
  assert.equal(resolveBuildSourceCommit({}, root), commit);
});

test('deployment environment identity has the same precedence as build metadata', (t) => {
  const root = gitlessSource(t);
  writeFileSync(path.join(root, 'deploy-source.json'), '{invalid');
  assert.equal(
    resolveBuildSourceCommit(
      {
        DU_SOURCE_COMMIT: 'owner',
        VERCEL_GIT_COMMIT_SHA: 'vercel',
        GITHUB_SHA: 'github',
      },
      root,
    ),
    'owner',
  );
  assert.equal(
    resolveBuildSourceCommit(
      { VERCEL_GIT_COMMIT_SHA: 'vercel', GITHUB_SHA: 'github' },
      root,
    ),
    'vercel',
  );
  assert.equal(
    resolveBuildSourceCommit({ GITHUB_SHA: 'github' }, root),
    'github',
  );
});

test('unversioned local builds remain usable while invalid pinned metadata fails explicitly', (t) => {
  const root = gitlessSource(t);
  assert.equal(resolveBuildSourceCommit({}, root), 'local-unversioned');
  writeFileSync(
    path.join(root, 'deploy-source.json'),
    JSON.stringify({ commit: 'invalid' }),
  );
  assert.throws(() => resolveBuildSourceCommit({}, root), /valid commit/);
});

test('complete source ZIP identity is strict and does not need a bootstrap archive', (t) => {
  const root = gitlessSource(t);
  const commit = 'b'.repeat(40);
  writeFileSync(
    path.join(root, 'release-source.json'),
    JSON.stringify({
      repository: 'dream-unity/November-1st',
      commit,
    }),
  );
  assert.equal(resolveBuildSourceCommit({}, root), commit);
  writeFileSync(
    path.join(root, 'deploy-source.json'),
    JSON.stringify({ commit: 'c'.repeat(40) }),
  );
  assert.equal(resolveBuildSourceCommit({}, root), 'c'.repeat(40));
  assert.equal(
    resolveBuildSourceCommit({ DU_SOURCE_COMMIT: 'owner' }, root),
    'owner',
  );
});

test('malformed or foreign ZIP identity manifests fail without disclosing their input', (t) => {
  const root = gitlessSource(t);
  for (const manifest of [
    '{"secret-input":',
    JSON.stringify({ repository: 'other/project', commit: 'b'.repeat(40) }),
    JSON.stringify({
      repository: 'dream-unity/November-1st',
      commit: 'B'.repeat(40),
    }),
    JSON.stringify({
      repository: 'dream-unity/November-1st',
      commit: 'b'.repeat(40),
      url: 'https://untrusted.invalid',
    }),
    'null',
  ]) {
    writeFileSync(path.join(root, 'release-source.json'), manifest);
    assert.throws(
      () => resolveBuildSourceCommit({}, root),
      (error) => {
        assert.match(error.message, /release-source.json requires/);
        assert.doesNotMatch(
          error.message,
          /secret-input|other\/project|untrusted/,
        );
        return true;
      },
    );
  }
});

test('metadata output and browser commit resolution share the exact ZIP source identity', (t) => {
  const root = gitlessSource(t);
  const commit = 'd'.repeat(40);
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(
    path.join(root, 'release-source.json'),
    JSON.stringify({
      repository: 'dream-unity/November-1st',
      commit,
    }),
  );
  const env = { ...process.env };
  for (const name of [
    'DU_SOURCE_COMMIT',
    'VERCEL_GIT_COMMIT_SHA',
    'GITHUB_SHA',
  ])
    delete env[name];
  execFileSync(
    process.execPath,
    [
      new URL('../../scripts/dream-unity-build-meta.mjs', import.meta.url)
        .pathname,
    ],
    { cwd: root, env },
  );
  const metadata = JSON.parse(
    readFileSync(path.join(root, 'dist/build-info.json'), 'utf8'),
  );
  assert.equal(metadata.commit, commit);
  assert.equal(metadata.commit, resolveBuildSourceCommit({}, root));
  assert.equal(metadata.repository, 'dream-unity/November-1st');
  assert.equal(typeof metadata.builtAt, 'string');
  assert.deepEqual(Object.keys(metadata).sort(), [
    'application',
    'builtAt',
    'commit',
    'repository',
    'upstream',
    'upstreamCommit',
  ]);
});
