#!/usr/bin/env node
// Hydrate the exact public source revision before Vercel installs or traces it.
// No dependencies, credentials, arbitrary URLs, shell commands, or remote code.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, writeFile, lstat, rename, rm } from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = 'dream-unity/November-1st';
const configPath = path.join(root, 'deploy-source.json');
const markerPath = path.join(root, '.vercel-source-manifest.json');
const lockPath = path.join(root, '.vercel-source-bootstrap.lock');
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 15000;
const requiredFiles = [
  'package.json', 'package-lock.json', 'vercel.json', 'index.html',
  'vite.config.js', 'api/[...path].js', 'host/application.mjs',
  'server/providers/local.js', 'src/main.js',
  'scripts/vercel-source-bootstrap.mjs',
];
const payloadFiles = [
  'package.json', 'package-lock.json', 'vercel.json',
  'api/[...path].js', 'scripts/vercel-source-bootstrap.mjs',
];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Vercel can rewrite JSON formatting before running installation. Preserve
// every configuration value and array position while ignoring object order.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function verifyVercelConfiguration(suppliedBytes, pinnedBytes) {
  let supplied;
  let pinned;
  try {
    supplied = JSON.parse(suppliedBytes.toString('utf8'));
    pinned = JSON.parse(pinnedBytes.toString('utf8'));
  } catch {
    // JSON parse errors can contain input values; never print those values.
    throw new Error('Initial deployment payload differs from pinned source: vercel.json (invalid JSON).');
  }
  if (!supplied || !pinned || typeof supplied !== 'object' || typeof pinned !== 'object' ||
      Array.isArray(supplied) || Array.isArray(pinned)) {
    throw new Error('Initial deployment payload differs from pinned source: vercel.json (expected JSON objects).');
  }
  const added = Object.keys(supplied).filter((key) => !Object.hasOwn(pinned, key)).sort();
  const removed = Object.keys(pinned).filter((key) => !Object.hasOwn(supplied, key)).sort();
  const changed = Object.keys(pinned).filter((key) => Object.hasOwn(supplied, key) &&
    canonicalJson(supplied[key]) !== canonicalJson(pinned[key])).sort();
  if (added.length || removed.length || changed.length) {
    throw new Error(`Initial deployment payload differs from pinned source: vercel.json (added: ${JSON.stringify(added)}; removed: ${JSON.stringify(removed)}; changed: ${JSON.stringify(changed)}).`);
  }
}

async function optionalRead(file) {
  try { return await readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function hasCompleteCheckout() {
  for (const file of requiredFiles) {
    try { if (!(await lstat(path.join(root, file))).isFile()) return false; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  return true;
}

function readConfig(bytes) {
  const config = JSON.parse(bytes.toString('utf8'));
  if (config.repository !== repository ||
      !/^[a-f0-9]{40}$/.test(config.commit || '') ||
      !/^[a-f0-9]{64}$/.test(config.archiveSha256 || '')) {
    throw new Error('deploy-source.json requires the fixed repository, a lowercase 40-digit commit, and a lowercase SHA-256 archive checksum.');
  }
  return { repository, commit: config.commit, archiveSha256: config.archiveSha256 };
}

async function downloadArchive(commit) {
  const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${commit}`, {
    signal: AbortSignal.timeout(90000),
    redirect: 'error',
    headers: { Accept: 'application/gzip', 'User-Agent': 'Dream-Unity-pinned-source-bootstrap' },
  });
  if (!response.ok || !response.body) throw new Error(`Pinned source download failed (HTTP ${response.status}).`);
  if (Number(response.headers.get('content-length')) > MAX_ARCHIVE_BYTES) {
    await response.body.cancel();
    throw new Error('Pinned source archive exceeds the download limit.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) throw new Error('Pinned source archive exceeds the download limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  return bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8');
}

function octal(bytes) {
  const text = tarString(bytes).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Unsupported TAR number encoding.');
  const number = text ? parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(number)) throw new Error('Invalid TAR entry size.');
  return number;
}

function paxFields(bytes) {
  const result = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw new Error('Invalid TAR extended header.');
    const rawLength = bytes.subarray(offset, space).toString('ascii');
    const length = /^\d+$/.test(rawLength) ? Number(rawLength) : 0;
    if (!Number.isSafeInteger(length) || length <= space - offset + 2 ||
        offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
      throw new Error('Invalid TAR extended header length.');
    }
    const record = bytes.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = record.indexOf('=');
    if (equal < 1) throw new Error('Invalid TAR extended header field.');
    const key = record.slice(0, equal);
    if (key.startsWith('GNU.sparse') || key === 'linkpath') throw new Error('Archive links and sparse entries are forbidden.');
    result[key] = record.slice(equal + 1);
    offset += length;
  }
  return result;
}

function sourceFiles(archive, commit) {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_EXPANDED_BYTES });
  const prefix = `November-1st-${commit}/`;
  const files = new Map();
  const seen = new Set();
  let extended = {};
  let entries = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    if (++entries > MAX_ENTRIES) throw new Error('Source archive contains too many entries.');
    const storedChecksum = octal(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== storedChecksum) throw new Error('Invalid TAR header checksum.');
    const size = octal(header.subarray(124, 136));
    const start = offset + 512;
    if (start + size > tar.length) throw new Error('Truncated source archive.');
    const bytes = tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
    const type = String.fromCharCode(header[156] || 48);
    if (type === 'g' || type === 'x') {
      const fields = paxFields(bytes);
      if (type === 'g') {
        if (fields.path || fields.size) throw new Error('Global TAR path/size overrides are forbidden.');
      } else extended = fields;
      continue;
    }
    if (type !== '0' && type !== '5') throw new Error('Archive contains a link or unsupported entry type.');
    const headerPrefix = tarString(header.subarray(345, 500));
    const headerName = tarString(header.subarray(0, 100));
    const name = extended.path || (headerPrefix ? `${headerPrefix}/${headerName}` : headerName);
    if (extended.size && Number(extended.size) !== size) throw new Error('TAR size override is unsupported.');
    extended = {};
    if (!name.startsWith(prefix)) throw new Error('Archive path does not match the pinned commit.');
    const relative = name.slice(prefix.length).replace(/\/$/, '');
    if (!relative && type === '5') continue;
    const segments = relative.split('/');
    if (!relative || /[\\\x00-\x1f\x7f]/.test(relative) ||
        segments.some((part) => !part || part === '.' || part === '..' || part === '.git' || part === 'node_modules') ||
        relative === 'deploy-source.json' || relative.startsWith('.vercel-source-') ||
        path.posix.normalize(relative) !== relative || seen.has(relative)) {
      throw new Error('Archive contains an unsafe or duplicate path.');
    }
    seen.add(relative);
    if (type === '0') files.set(relative, { bytes, sha256: digest(bytes), executable: Boolean(octal(header.subarray(100, 108)) & 0o111) });
    else if (size !== 0) throw new Error('TAR directory contains unexpected data.');
  }
  for (const file of requiredFiles) if (!files.has(file)) throw new Error(`Pinned source is incomplete: ${file}`);
  return files;
}

async function verifyMaterialized(config) {
  const bytes = await optionalRead(markerPath);
  if (!bytes) return false;
  const marker = JSON.parse(bytes.toString('utf8'));
  if (marker.commit !== config.commit || marker.archiveSha256 !== config.archiveSha256) {
    throw new Error('This build directory was hydrated from another revision; use a clean deployment.');
  }
  if (!Array.isArray(marker.files) || !marker.files.length) return false;
  for (const { file, sha256 } of marker.files) {
    if (typeof file !== 'string' || file.startsWith('/') || file.includes('\\') ||
        file.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error('Invalid source manifest path.');
    }
    const data = await optionalRead(path.join(root, file));
    if (!data || digest(data) !== sha256) return false;
  }
  return hasCompleteCheckout();
}

async function assertSafeDestination(relative) {
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Refusing to hydrate through an existing symbolic link.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

async function hydrate(config) {
  if (await verifyMaterialized(config)) {
    console.log(`[source] Verified ${config.commit}; source is already present.`);
    return;
  }
  const archive = await downloadArchive(config.commit);
  if (digest(archive) !== config.archiveSha256) throw new Error('Pinned source archive SHA-256 does not match; nothing was extracted.');
  const files = sourceFiles(archive, config.commit);
  // Ensure Vercel discovered precisely the configuration/entrypoint we build.
  for (const file of payloadFiles) {
    const supplied = await optionalRead(path.join(root, file));
    if (file === 'vercel.json' && supplied) {
      verifyVercelConfiguration(supplied, files.get(file).bytes);
      continue;
    }
    if (!supplied || digest(supplied) !== files.get(file)?.sha256) {
      throw new Error(`Initial deployment payload differs from pinned source: ${file}`);
    }
  }
  for (const file of files.keys()) await assertSafeDestination(file);
  for (const [file, entry] of files) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.bytes, { mode: entry.executable ? 0o755 : 0o644 });
  }
  const manifest = { ...config, files: [...files].map(([file, entry]) => ({ file, sha256: entry.sha256 })) };
  const temporary = `${markerPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await rename(temporary, markerPath);
  console.log(`[source] Verified and hydrated ${files.size} files from ${config.commit}.`);
}

async function main() {
  const bytes = await optionalRead(configPath);
  if (!bytes) {
    if (!(await hasCompleteCheckout())) throw new Error('No deploy-source.json and the source checkout is incomplete.');
    console.log('[source] Full checkout present; no deployment bootstrap required.');
    return;
  }
  const config = readConfig(bytes);
  const deadline = Date.now() + 180000;
  while (true) {
    try { await mkdir(lockPath); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error('Another source hydration did not finish; retry with a clean build.');
      await pause(250);
    }
  }
  try { await hydrate(config); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
}

main().catch((error) => {
  console.error(`[source] ${error.message}`);
  process.exitCode = 1;
});
