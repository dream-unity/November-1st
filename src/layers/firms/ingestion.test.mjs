import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngestion } from './ingestion.js';
import { createQueries } from './queries.js';

function fixture() {
  let payload = { fires: [] };
  const state = {
    _dataSource: {},
    _enabled: true,
    _fires: [],
    _firesByFrp: [],
    _lastUpdate: null,
    _stale: false,
    _keyRequired: false,
    _count: 0,
    _cellCacheByGrid: new Map(),
  };
  const context = {
    layerState: state,
    config: { id: 'fires' },
    services: { context: { clearSelectedEntityContextForLayer() {} } },
    components: {
      rendering: { renderCurrentLod() {} },
      selection: { selectFire() {} },
      model: { formatAge: () => '1h', formatAgoMinutes: () => '1 min' },
    },
    feed: {
      async getSnapshot() {
        if (payload instanceof Error) throw payload;
        return payload;
      },
    },
  };
  return {
    state,
    load: createIngestion(context).loadHeatmap,
    stats: createQueries(context).methods.getStats,
    setPayload(next) {
      payload = next;
    },
  };
}

const observed = {
  fetchedAt: 1_785_000_000_000,
  fires: [
    { lat: 30, lon: -97, frp: 10, acqDate: '2026-07-16', acqTime: '1006' },
  ],
};

test('a lost FIRMS key preserves observations and their timestamp as explicitly stale', async () => {
  const f = fixture();
  f.setPayload(observed);
  await f.load();
  const records = f.state._fires;
  f.setPayload({ keyRequired: true });
  await f.load();
  assert.equal(f.state._fires, records);
  assert.equal(f.stats().lastUpdate, observed.fetchedAt);
  assert.equal(f.stats().stale, true);
  assert.equal(f.stats().keyRequired, true);
  assert.match(f.stats().loadingLabel, /KEY REQUIRED.*STALE/);
  assert.equal(f.stats().loading, false);
});

test('transport failure marks cache stale, clears obsolete key guidance, and a fresh snapshot recovers', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture();
  f.setPayload(observed);
  await f.load();
  f.setPayload({ keyRequired: true });
  await f.load();
  f.setPayload(new Error('HTTP 502'));
  await f.load();
  assert.equal(f.stats().keyRequired, false);
  assert.equal(f.stats().stale, true);
  assert.match(f.stats().loadingLabel, /STALE/);
  assert.equal(f.stats().count, 1);
  f.setPayload({
    fires: [],
    fetchedAt: observed.fetchedAt + 60_000,
    stale: false,
  });
  await f.load();
  assert.equal(f.stats().stale, false);
  assert.equal(f.stats().error, null);
  assert.equal(f.stats().count, 0);
  assert.match(f.stats().loadingLabel, /^LIVE/);
});

test('a missing key before any observation does not invent a cached snapshot', async () => {
  const f = fixture();
  f.setPayload({ keyRequired: true });
  await f.load();
  assert.equal(f.stats().stale, false);
  assert.equal(f.stats().lastUpdate, null);
  assert.equal(f.stats().loadingLabel, 'KEY REQUIRED');
});

test('a serverless response limit remains actionable while cached observations are retained', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const f = fixture();
  f.setPayload(observed);
  await f.load();
  f.setPayload(
    Object.assign(new Error('Too large'), {
      code: 'FIRMS_PERSISTENT_HOST_REQUIRED',
    }),
  );
  await f.load();
  assert.match(f.stats().loadingLabel, /persistent Node service.*STALE/);
  assert.match(f.stats().error, /persistent Node service/);
  assert.equal(f.stats().count, 1);
});
