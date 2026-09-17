import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { normalizeGlobalCctvSources } from '../server/providers/cctv/globalSources.js';
import { createCctvEmbedStatus } from '../server/providers/cctv/embedStatus.js';

/**
 * Offline registry audit: node scripts/audit-global-cctv.mjs
 * Check current broadcasts: node scripts/audit-global-cctv.mjs --live
 * With a proxy: node --use-env-proxy scripts/audit-global-cctv.mjs --live --timeout-ms 30000
 * Live checks use four workers, default to eight seconds, and never extract media.
 * Provider outages are observations, not a failing registry-validation exit code.
 */
export async function auditGlobalCctv({
  registryPath = new URL('../config/cctv_sources.global.json', import.meta.url),
  live = false,
  timeoutMs = 8_000,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
    throw new RangeError('timeoutMs must be an integer from 1000 to 30000.');
  }
  const checkedAt = new Date(now()).toISOString();
  const invalid = [];
  let records;
  try {
    records = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch {
    invalid.push({
      id: null,
      status: 'invalid',
      message: 'The camera registry could not be read as JSON.',
      checkedAt,
    });
  }
  if (records !== undefined && (!Array.isArray(records) || !records.length)) {
    invalid.push({
      id: null,
      status: 'invalid',
      message: 'The camera registry must be a non-empty array.',
      checkedAt,
    });
  }

  const input = Array.isArray(records) ? records : [];
  const acceptedRows = [];
  const seenIds = new Set();
  const seenEmbeds = new Set();
  for (const [index, row] of input.entries()) {
    let normalized;
    try {
      normalized = normalizeGlobalCctvSources([row])[0];
    } catch {
      // Malformed field types are registry errors, not live-provider failures.
    }
    let message;
    if (!normalized) {
      message = 'This camera failed the application registry validation.';
    } else if (seenIds.has(normalized.id)) {
      message = 'This camera repeats an earlier source ID.';
    } else if (seenEmbeds.has(normalized.embedUrl)) {
      message = 'This camera repeats an earlier embedded broadcast.';
    }
    if (message) {
      invalid.push({
        index,
        id:
          typeof row?.id === 'string' &&
          /^[a-z0-9][a-z0-9_-]{2,100}$/.test(row.id)
            ? row.id
            : null,
        status: 'invalid',
        message,
        checkedAt,
      });
    } else {
      seenIds.add(normalized.id);
      seenEmbeds.add(normalized.embedUrl);
      acceptedRows.push(normalized);
    }
  }

  const cameras = normalizeGlobalCctvSources(acceptedRows);
  const sources = new Array(cameras.length);
  const getStatus = live
    ? createCctvEmbedStatus({ fetchImpl, now, timeoutMs, maxEntries: 4 })
    : null;
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < cameras.length) {
      const index = nextIndex++;
      const camera = cameras[index];
      let observation = {
        status: 'not-checked',
        message: 'Registry entry is valid; use --live to check the publisher.',
        checkedAt,
      };
      if (getStatus) {
        try {
          observation = await getStatus(camera);
        } catch {
          observation = {
            status: 'unknown',
            message: 'The publisher status check did not complete.',
            checkedAt: new Date(now()).toISOString(),
          };
        }
      }
      sources[index] = {
        id: camera.id,
        country: camera.country,
        ...observation,
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, cameras.length) }, worker),
  );

  const countries = {};
  for (const camera of cameras) {
    const country = (countries[camera.country] ??= {
      name: camera.countryName,
      cameras: 0,
      statuses: {},
    });
    country.cameras++;
  }
  const statuses = {};
  for (const source of [...sources, ...invalid]) {
    statuses[source.status] = (statuses[source.status] || 0) + 1;
    const country = countries[source.country];
    if (country) {
      country.statuses[source.status] =
        (country.statuses[source.status] || 0) + 1;
    }
  }
  return {
    mode: live ? 'live' : 'offline',
    checkedAt,
    completedAt: new Date(now()).toISOString(),
    validRegistry: invalid.length === 0,
    configuredCameras: input.length,
    validCameras: cameras.length,
    countryOrTerritoryCount: Object.keys(countries).length,
    timeoutMs: live ? timeoutMs : null,
    concurrency: live ? 4 : 0,
    statuses,
    countries: Object.fromEntries(
      Object.entries(countries).sort(([a], [b]) => a.localeCompare(b)),
    ),
    sources,
    invalid,
  };
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--live') options.live = true;
    else if (arg === '--timeout-ms' || arg.startsWith('--timeout-ms=')) {
      const value =
        arg === '--timeout-ms'
          ? args[++index]
          : arg.slice('--timeout-ms='.length);
      if (!/^\d+$/.test(value || '')) {
        throw new RangeError(
          '--timeout-ms requires an integer from 1000 to 30000.',
        );
      }
      options.timeoutMs = Number(value);
    } else {
      throw new Error('Expected --live and/or --timeout-ms 1000..30000.');
    }
  }
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const report = await auditGlobalCctv(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.validRegistry ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
