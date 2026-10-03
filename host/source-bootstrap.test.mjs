import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyVercelConfiguration } from '../scripts/vercel-source-bootstrap.mjs';

const bootstrapUrl = new URL(
  '../scripts/vercel-source-bootstrap.mjs',
  import.meta.url,
);
const pinnedBytes = await readFile(new URL('../vercel.json', import.meta.url));
const pinned = JSON.parse(pinnedBytes);
const secret = 'SECRET-bootstrap-regression-value';
const bytes = (value) => Buffer.from(JSON.stringify(value));

function reject(supplied, expected = pinned, hidden = []) {
  assert.throws(
    () => verifyVercelConfiguration(bytes(supplied), bytes(expected)),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /vercel\.json/);
      for (const value of hidden) assert.ok(!error.message.includes(value));
      return true;
    },
  );
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reverseObjectKeys(item)]),
  );
}

test('the pinned configuration permits JSON whitespace and recursive object key reordering', () => {
  assert.doesNotThrow(() =>
    verifyVercelConfiguration(pinnedBytes, pinnedBytes),
  );
  const reformatted = Buffer.from(
    `\n\t${JSON.stringify(reverseObjectKeys(pinned), null, '\t')}\r\n`,
  );
  assert.notDeepEqual(reformatted, pinnedBytes);
  assert.doesNotThrow(() =>
    verifyVercelConfiguration(reformatted, pinnedBytes),
  );
  assert.doesNotThrow(() =>
    verifyVercelConfiguration(pinnedBytes, reformatted),
  );
});

test('the actual pinned project can be renamed to dream-unity-runtime', () => {
  assert.equal(pinned.name, 'november-1st');
  const supplied = { ...pinned, name: 'dream-unity-runtime' };
  assert.doesNotThrow(() =>
    verifyVercelConfiguration(bytes(supplied), pinnedBytes),
  );
  assert.doesNotThrow(() =>
    verifyVercelConfiguration(bytes(reverseObjectKeys(supplied)), pinnedBytes),
  );
});

test('project slugs allow one through 100 characters and internal hyphens in either input', () => {
  for (const name of [
    'a',
    '0',
    'a0',
    '0-a-9',
    'a--b',
    'a'.repeat(100),
    `0${'-'.repeat(98)}9`,
  ]) {
    const changed = { ...pinned, name };
    assert.doesNotThrow(
      () => verifyVercelConfiguration(bytes(changed), pinnedBytes),
      name,
    );
    assert.doesNotThrow(
      () => verifyVercelConfiguration(pinnedBytes, bytes(changed)),
      name,
    );
  }
});

test('equal configurations with no name remain valid, but name cannot be added or removed', () => {
  const unnamed = structuredClone(pinned);
  delete unnamed.name;
  assert.doesNotThrow(() =>
    verifyVercelConfiguration(bytes(unnamed), bytes(unnamed)),
  );
  reject(unnamed);
  reject(pinned, unnamed);
});

for (const [label, name] of [
  ['empty', ''],
  ['too long', 'a'.repeat(101)],
  ['uppercase', secret],
  ['leading hyphen', '-runtime'],
  ['trailing hyphen', 'runtime-'],
  ['hyphen only', '-'],
  ['underscore', 'dream_unity'],
  ['dot', 'dream.unity'],
  ['slash', 'dream/unity'],
  ['space', 'dream unity'],
  ['newline suffix', 'runtime\n'],
  ['unicode', 'runtimé'],
  ['null', null],
  ['boolean', false],
  ['number', 123],
  ['array', [secret]],
  ['object', { value: secret }],
]) {
  test(`invalid project name (${label}) is rejected in either input and when unchanged`, () => {
    const invalid = { ...pinned, name };
    reject(invalid, pinned, [secret]);
    reject(pinned, invalid, [secret]);
    reject(invalid, invalid, [secret]);
  });
}

for (const [label, mutate] of [
  [
    'schema',
    (config) => {
      config.$schema = secret;
    },
  ],
  [
    'framework',
    (config) => {
      config.framework = secret;
    },
  ],
  [
    'install command',
    (config) => {
      config.installCommand = secret;
    },
  ],
  [
    'build command',
    (config) => {
      config.buildCommand = secret;
    },
  ],
  [
    'output directory',
    (config) => {
      config.outputDirectory = secret;
    },
  ],
  [
    'function duration',
    (config) => {
      config.functions['api/**/*.js'].maxDuration = 301;
    },
  ],
  [
    'function include files',
    (config) => {
      config.functions['api/**/*.js'].includeFiles = secret;
    },
  ],
  [
    'CSP value',
    (config) => {
      config.headers[0].headers[0].value = secret;
    },
  ],
  [
    'header source',
    (config) => {
      config.headers[0].source = secret;
    },
  ],
  [
    'header key',
    (config) => {
      config.headers[0].headers[0].key = secret;
    },
  ],
  [
    'header rule order',
    (config) => {
      config.headers.reverse();
    },
  ],
  [
    'nested header array order',
    (config) => {
      config.headers[1].headers.reverse();
    },
  ],
  [
    'rewrite source',
    (config) => {
      config.rewrites[0].source = secret;
    },
  ],
  [
    'rewrite destination',
    (config) => {
      config.rewrites[0].destination = secret;
    },
  ],
  [
    'additional rewrite',
    (config) => {
      config.rewrites.push({ source: '/extra', destination: secret });
    },
  ],
  [
    'added top-level key',
    (config) => {
      config.env = { TOKEN: secret };
    },
  ],
  [
    'added nested key',
    (config) => {
      config.functions['api/**/*.js'].memory = 1024;
    },
  ],
  [
    'removed nested key',
    (config) => {
      delete config.functions['api/**/*.js'].maxDuration;
    },
  ],
]) {
  test(`changed ${label} is rejected with and without a valid project rename`, () => {
    const supplied = structuredClone(pinned);
    mutate(supplied);
    reject(supplied, pinned, [secret]);
    supplied.name = 'dream-unity-runtime';
    reject(supplied, pinned, [secret]);
  });
}

test('every top-level key remains mandatory alongside a valid project rename', () => {
  for (const key of Object.keys(pinned)) {
    const supplied = { ...pinned, name: 'dream-unity-runtime' };
    delete supplied[key];
    reject(supplied);
  }
});

test('a nested name is configuration and cannot change alongside the project name', () => {
  const expected = structuredClone(pinned);
  expected.functions['api/**/*.js'].name = 'nested-original';
  const supplied = structuredClone(expected);
  supplied.name = 'dream-unity-runtime';
  assert.doesNotThrow(() =>
    verifyVercelConfiguration(bytes(supplied), bytes(expected)),
  );
  supplied.functions['api/**/*.js'].name = 'nested-renamed';
  reject(supplied, expected);
});

test('rewrite array order is significant even when all entries are preserved', () => {
  const expected = structuredClone(pinned);
  expected.rewrites.push({ source: '/:path*', destination: '/index.html' });
  const supplied = structuredClone(expected);
  supplied.name = 'dream-unity-runtime';
  supplied.rewrites.reverse();
  reject(supplied, expected);
});

test('malformed JSON is rejected from either input without exposing parse input', () => {
  for (const malformed of [
    `{"name":"${secret}"`,
    secret,
    `{"value":"${secret}",}`,
    '',
  ]) {
    const badBytes = Buffer.from(malformed);
    for (const [supplied, expected] of [
      [badBytes, pinnedBytes],
      [pinnedBytes, badBytes],
    ]) {
      assert.throws(
        () => verifyVercelConfiguration(supplied, expected),
        (error) => {
          assert.match(error.message, /vercel\.json/);
          assert.ok(!error.message.includes(secret));
          return true;
        },
      );
    }
  }
});

test('JSON roots must be objects in both inputs and errors do not echo their values', () => {
  for (const invalid of [null, [], [secret], secret, false, 123]) {
    reject(invalid, pinned, [secret]);
    reject(pinned, invalid, [secret]);
    reject(invalid, invalid, [secret]);
  }
});

test('importing the bootstrap with a hydration config performs no download or bootstrap work', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'source-bootstrap-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  const modulePath = path.join(root, 'scripts', 'vercel-source-bootstrap.mjs');
  await copyFile(bootstrapUrl, modulePath);
  await writeFile(
    path.join(root, 'deploy-source.json'),
    JSON.stringify({
      repository: 'dream-unity/November-1st',
      commit: 'a'.repeat(40),
      archiveSha256: 'b'.repeat(64),
    }),
  );

  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { pathToFileURL } from 'node:url';
    globalThis.fetch = async () => {
      process.stderr.write('unexpected bootstrap download\\n');
      throw new Error('fetch is forbidden during import');
    };
    const module = await import(pathToFileURL(process.argv[2]).href);
    assert.equal(typeof module.verifyVercelConfiguration, 'function');
    process.stdout.write('imported\\n');
  `,
      'source-bootstrap-import-probe',
      modulePath,
    ],
    { cwd: root, encoding: 'utf8', timeout: 5000 },
  );

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'imported\n');
  assert.equal(result.stderr, '');
  assert.deepEqual((await readdir(root)).sort(), [
    'deploy-source.json',
    'scripts',
  ]);
  assert.deepEqual(await readdir(path.join(root, 'scripts')), [
    'vercel-source-bootstrap.mjs',
  ]);
});
