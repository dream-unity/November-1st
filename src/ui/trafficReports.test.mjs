import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchTrafficReports } from './trafficReports.js';

const snapshot = {
  region: { id: 'austin' },
  reports: [],
  fetchedAt: '2026-09-17T02:00:00Z',
  sourceUpdatedAt: '2026-09-17T01:59:00Z',
  stale: false,
  partial: false,
};
test('traffic panel requests its selected official region and retains source freshness metadata', async () => {
  const result = await fetchTrafficReports('austin', {
    fetchImpl: async (url) => {
      assert.equal(url, '/api/traffic/reports?region=austin');
      return Response.json(snapshot);
    },
  });
  assert.equal(result.sourceUpdatedAt, snapshot.sourceUpdatedAt);
  assert.equal(result.stale, false);
});
test('region mismatch and successful malformed bodies cannot populate the report panel', async () => {
  for (const body of [
    {},
    { ...snapshot, region: { id: 'finland' } },
    { ...snapshot, reports: [{ title: 'Missing ID/date' }] },
    { ...snapshot, sourceUpdatedAt: null },
  ])
    await assert.rejects(
      fetchTrafficReports('austin', {
        fetchImpl: async () => Response.json(body),
      }),
      /invalid report snapshot/,
    );
});
test('aborted requests reject even when transport ignores AbortSignal', async () => {
  const controller = new AbortController();
  await assert.rejects(
    fetchTrafficReports('austin', {
      signal: controller.signal,
      fetchImpl: async () => {
        controller.abort();
        return Response.json(snapshot);
      },
    }),
    { name: 'AbortError' },
  );
});
test('failed HTTP status gives actionable feed error rather than simulated data', async () => {
  await assert.rejects(
    fetchTrafficReports('austin', {
      fetchImpl: async () =>
        Response.json({ error: 'upstream' }, { status: 503 }),
    }),
    /official traffic feed could not be loaded/,
  );
  await assert.rejects(
    fetchTrafficReports('anywhere'),
    /Unsupported traffic region/,
  );
});
