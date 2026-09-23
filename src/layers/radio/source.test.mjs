import test from 'node:test';
import assert from 'node:assert/strict';
import { createRadioSource, createRadioLayer } from './index.js';
import { rankRadioStationsForRequest, radioLayer } from '../../data/radio.js';

const id = '00000000-0000-4000-8000-000000000001';

test('radio ingestion validates every duplicate before omitting corrected and disputed map locations', async () => {
  const originalFetch = globalThis.fetch;
  const local = {
    id, name: 'Local station',
    streamUrl: 'https://radio.example.org/local.mp3',
    country: 'United Kingdom', countryCode: 'GB', state: '', lat: 51, lon: -1,
    homepage: null, tags: ['news'], languages: ['English'],
    metadataTrust: 'untrusted-community', codec: 'MP3', bitrate: 128,
  };
  const cnn = {
    ...local,
    id: '00000000-0000-4000-8000-000000000002',
    name: 'CNN UK', streamUrl: 'https://tunein.cdnstream1.com/2868_96.mp3',
    state: 'London', lat: 52,
  };
  const sharedGb = {
    ...local,
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Shared GB', streamUrl: 'https://radio.example.org/shared.mp3',
  };
  const sharedUs = {
    ...sharedGb,
    id: '00000000-0000-4000-8000-000000000004',
    name: 'Shared US', country: 'United States', countryCode: 'US', lat: 34, lon: -84,
  };
  const viewer = {
    camera: { positionWC: { x: 7_000_000, y: 0, z: 0 } },
    scene: { canvas: { disableRootEvents: true, onwheel: null, addEventListener() {}, removeEventListener() {} } },
    dataSources: { add() {}, remove() {} },
    entities: { add(entity) { return entity; }, remove() {} },
  };
  let generation = 0;
  const refresh = async (stations) => {
    generation += 1;
    globalThis.fetch = async () => new Response(JSON.stringify({
      stations,
      acceptedGeneration: generation,
      catalogInstance: 'identity-ingestion-test',
      updatedAt: new Date().toISOString(),
      stale: false, degraded: false,
    }));
    await radioLayer.update();
  };
  radioLayer.destroy();
  try {
    radioLayer.init(viewer);
    radioLayer.enable();
    await refresh([local, cnn, sharedGb, sharedUs]);
    const accepted = radioLayer.getAcceptedCatalogSnapshot();
    assert.deepEqual(accepted.stationIds, [local.id]);
    assert.equal(radioLayer.getUIState().error, null);
    assert.equal(radioLayer.selectStation(local.id, { autoplay: false }), true);

    for (const invalid of [
      { ...local, id: 'malformed' },
      { ...local, tags: 'news' },
      { ...cnn, tags: 'news' },
      { ...local, lat: null, lon: null, countryStatus: 'verified' },
    ]) {
      await refresh([local, invalid]);
      assert.equal(radioLayer.getAcceptedCatalogSnapshot(), accepted,
        'a malformed duplicate cannot be concealed by the earlier valid stream');
      assert.equal(radioLayer.getUIState().selected.id, local.id);
      assert.match(radioLayer.getUIState().error, /refresh failed/i);
    }

    // A new healthy catalog that only contains corrected or conflicting entries
    // removes the formerly accepted location instead of retaining a false pin.
    await refresh([{ ...local, streamUrl: cnn.streamUrl }, sharedGb, sharedUs]);
    const corrected = radioLayer.getAcceptedCatalogSnapshot();
    assert.equal(corrected.generation, generation);
    assert.deepEqual(corrected.stationIds, []);
    assert.equal(radioLayer.getUIState().stationCount, 0);
    assert.equal(radioLayer.getUIState().selected, null);
    assert.equal(radioLayer.getUIState().error, null);
    assert.equal(radioLayer.getUIState().stale, false);
  } finally {
    radioLayer.destroy();
    globalThis.fetch = originalFetch;
  }
});

test('radio country requests reject contradictory origins and honor the verified stream identity', () => {
  const rows = [
    { id: 'contradictory', tags: [], countryCode: 'GB', country: 'The United States Of America' },
    { id: 'local', tags: [], countryCode: 'GB', country: 'United Kingdom' },
    { id: 'cnn', tags: [], streamUrl: 'https://tunein.cdnstream1.com/2868_96.mp3', countryCode: 'GB', country: 'United Kingdom' },
    { id: 'unconfirmed', tags: [], countryCode: '', country: '', countryStatus: 'conflicting' },
  ];
  assert.deepEqual(rankRadioStationsForRequest(rows, { country: 'UK' }).map((station) => station.id), ['local']);
  assert.deepEqual(rankRadioStationsForRequest(rows, { country: 'US' }).map((station) => station.id), ['cnn']);
});

test('radio source confines directory and click requests to their existing routes', async () => {
  const calls = [];
  const body = { stations: [], stale: false };
  const source = createRadioSource({
    fetchImpl: async (path, options) => {
      calls.push({ path, options });
      return new Response(JSON.stringify(body));
    },
  });
  const controller = new AbortController();
  assert.deepEqual(
    await source.getDirectory({ signal: controller.signal }),
    body,
  );
  await source.recordClick(id, { signal: controller.signal });
  assert.deepEqual(
    calls.map((call) => call.path),
    ['/api/radio/stations', `/api/radio/click/${id}`],
  );
  assert.equal(calls[1].options.method, 'POST');
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
  assert.ok(calls.every((call) => !call.options.signal.aborted));
  for (const invalid of [
    '../stations',
    'https://example.com',
    '',
    null,
    `${id}?x=1`,
  ])
    await assert.rejects(
      source.recordClick(invalid),
      /Invalid radio station id/,
    );
  assert.equal(calls.length, 2);
});

test('radio source propagates denial and cancels completed body parsing', async () => {
  const denied = createRadioSource({
    fetchImpl: async () => new Response('', { status: 403 }),
  });
  await assert.rejects(denied.getDirectory(), /403/);
  await assert.rejects(denied.recordClick(id), /403/);
  const controller = new AbortController();
  const source = createRadioSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return { stations: [] };
      },
    }),
  });
  await assert.rejects(source.getDirectory({ signal: controller.signal }), {
    name: 'AbortError',
  });
  let called = false;
  const idle = createRadioSource({
    fetchImpl: async () => {
      called = true;
    },
  });
  await assert.rejects(idle.recordClick(id, { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(called, false);
});

test('radio factories keep settings and subscriptions independent without fetching or audio startup', () => {
  let requested = false;
  const source = {
    getDirectory() {
      requested = true;
    },
    recordClick() {
      requested = true;
    },
  };
  const services = {
    ground: {},
    picking: { unregisterPickOwner() {} },
    globe: {},
    render: { governorRequestRender() {} },
    overlays: {
      clearOverlaySource() {},
      setOverlaySourceVisible() {},
      setOverlayEntries() {},
    },
  };
  const first = createRadioLayer({ source, services });
  const second = createRadioLayer({ source, services });
  let changes = 0;
  const off = second.subscribeToRadio(() => changes++);
  const initialChanges = changes;
  first.setRadioParams({ volume: 0.3 });
  assert.equal(first.getRadioParams().volume, 0.3);
  assert.equal(second.getRadioParams().volume, 0.8);
  assert.equal(changes, initialChanges);
  assert.equal(requested, false);
  off();
  first.destroy();
  assert.equal(second.getRadioParams().volume, 0.8);
  second.destroy();
});

test('radio directory and click requests have finite deadlines and preserve caller cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = createRadioSource({
    fetchImpl: (_path, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const directory = source.getDirectory();
  const directoryRejected = assert.rejects(directory, { name: 'TimeoutError' });
  t.mock.timers.tick(60_000);
  await directoryRejected;
  const click = source.recordClick(id);
  const clickRejected = assert.rejects(click, { name: 'TimeoutError' });
  t.mock.timers.tick(10_000);
  await clickRejected;
  const controller = new AbortController();
  const cancelled = assert.rejects(
    source.getDirectory({ signal: controller.signal }),
    { name: 'AbortError' },
  );
  controller.abort();
  await cancelled;
});
