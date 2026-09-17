import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProductionHost } from './application.mjs';
import { readHostConfig } from './config.mjs';
import { originalProviderRequestUrl } from './vercel-routing.mjs';
import { radioBrowserProxy } from '../server/providers/radio.js';

test('hosted Australia radio reads the immutable source archive after cwd moves to writable state', async (t) => {
  const previousCwd = process.cwd();
  const root = await mkdtemp(path.join(os.tmpdir(), 'gev-australia-radio-'));
  const sourceRoot = path.join(root, 'source-archive');
  const stateDir = path.join(root, 'writable-state');
  await mkdir(path.join(sourceRoot, 'config'), { recursive: true });
  await mkdir(stateDir);
  await writeFile(
    path.join(sourceRoot, 'config/radio_sources.australia.json'),
    JSON.stringify([
      {
        id: 'test-public-broadcaster',
        name: 'Public Australian radio',
        streamUrl: 'https://radio.example.org/live.m3u8',
        streamFormat: 'hls',
        liveOnly: true,
        sourcePage: 'https://example.org/listen',
        codec: 'AAC',
        playbackKind: 'live',
        verifiedAt: '2026-09-17T00:00:00Z',
        languages: ['English'],
        city: 'Melbourne',
        metroArea: 'melbourne',
        locality: 'Brunswick East',
        geographicScope: 'suburban',
        geographySourcePage: 'https://example.org/about',
      },
    ]),
  );
  // productionProviders moves cwd to this separate directory before constructing
  // the providers. The archive's config must continue to load from sourceRoot.
  process.chdir(stateDir);
  const plugin = radioBrowserProxy({
    sourceRoot,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => {
      throw new Error('directory temporarily offline');
    },
  });
  const host = await createProductionHost({
    config: { ...readHostConfig({}, 'serverless'), stateDir },
    serveStatic: false,
    providerPlugins: [plugin],
  });
  const server = createServer((req, res) => {
    req.url = originalProviderRequestUrl(req.url);
    host.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await host.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(
    `${origin}/api/radio/stations?country=AU&path=radio%2Fstations`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.degraded, true);
  assert.equal(result.stations.length, 1);
  assert.equal(result.stations[0].sourceKind, 'curated-australia');
  assert.equal(result.stations[0].name, 'Public Australian radio');
  assert.equal(result.stations[0].streamFormat, 'hls');
  assert.equal(result.stations[0].liveOnly, true);
  assert.equal(result.stations[0].lat, null);
  assert.equal(result.stations[0].lon, null);
  const metroResponse = await fetch(
    `${origin}/api/radio/stations?country=AU&city=melbourne&path=radio%2Fstations`,
  );
  assert.equal(metroResponse.status, 200);
  const metro = await metroResponse.json();
  assert.equal(metro.stations.length, 1);
  assert.equal(metro.stations[0].locality, 'Brunswick East');
  assert.equal(metro.stations[0].metroMatch, 'curated');
  assert.equal(metro.coverage.metroArea, 'melbourne');
  assert.equal(metro.coverage.countryStationCount, 1);
  assert.equal(metro.updatedAt, result.updatedAt);
  const click = await fetch(
    `${origin}/api/radio/click/${result.stations[0].id}`,
    { method: 'POST' },
  );
  assert.equal(click.status, 204);
});
