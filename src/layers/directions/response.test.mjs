import test from 'node:test';
import assert from 'node:assert/strict';
import { readDirectionsResponse } from './index.js';

test('platform HTML and empty HTTP failures retain an actionable service status', async () => {
  for (const status of [401, 403, 404, 500, 502, 503, 504]) {
    for (const body of ['', '<html>Gateway error</html>']) {
      await assert.rejects(
        readDirectionsResponse(new Response(body, { status })),
        new RegExp(`Routing service unavailable \\(HTTP ${status}\\)`),
      );
    }
  }
});

test('a rate limit does not become a JSON parser error if a proxy returns text', async () => {
  for (const body of [
    'Too many requests',
    JSON.stringify({ error: 'quota' }),
  ]) {
    await assert.rejects(
      readDirectionsResponse(new Response(body, { status: 429 })),
      /Routing is rate limited/,
    );
  }
});

test('route-shaped payload cannot override an unsuccessful HTTP status', async () => {
  await assert.rejects(
    readDirectionsResponse(
      Response.json(
        {
          distanceM: 1,
          geometry: [
            [0, 0],
            [1, 1],
          ],
        },
        { status: 503 },
      ),
    ),
    /HTTP 503/,
  );
});

test('successful non-JSON and malformed top-level replies are invalid, not no-route evidence', async () => {
  for (const body of ['<!DOCTYPE html>', 'null', '[]', '42', '"route"']) {
    await assert.rejects(
      readDirectionsResponse(new Response(body)),
      /invalid response/,
    );
  }
  const route = {
    geometry: [
      [0, 0],
      [1, 1],
    ],
    distanceM: 2,
    durationS: 3,
  };
  assert.deepEqual(await readDirectionsResponse(Response.json(route)), route);
  assert.deepEqual(
    await readDirectionsResponse(Response.json({ error: 'no route found' })),
    { error: 'no route found' },
  );
});
