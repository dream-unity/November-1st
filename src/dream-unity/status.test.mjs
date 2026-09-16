import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deploymentStatusFailureCopy,
  providerStatusDetails,
  providerStatusLabel,
  readDeploymentStatus,
  startupFailureCopy,
} from './status.js';

const health = { service: 'dream-unity-gods-eye', status: 'ok' };
const voice = {
  id: 'voice',
  label: 'AI voice and HUD',
  status: 'not-configured',
  available: false,
  message: 'AI voice has not been enabled on this deployment.',
  detail: 'The site owner must configure the provider.',
};

test('configuration checks preserve unavailable provider reasons and never imply live data', async () => {
  const calls = [];
  const result = await readDeploymentStatus({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json(
        url === '/api/health' ? health : { providers: [voice] },
      );
    },
  });
  assert.deepEqual(result.providers, [voice]);
  assert.deepEqual(providerStatusDetails(result.providers[0]), [
    voice.message,
    voice.detail,
  ]);
  assert.equal(providerStatusLabel('configured'), 'Configured');
  assert.equal(providerStatusLabel('__proto__'), 'Status unknown');
  assert.equal(providerStatusLabel('toString'), 'Status unknown');
  assert.ok(
    calls.every(
      ({ options }) =>
        options.cache === 'no-store' && options.credentials === 'same-origin',
    ),
  );
});

test('a healthy server cannot turn malformed capability data into a connected empty list', async () => {
  for (const providers of [
    [],
    null,
    [null],
    [{ id: 'voice', label: 'Voice' }],
    [{ id: '', label: 'Voice', status: 'configured' }],
  ]) {
    await assert.rejects(
      readDeploymentStatus({
        fetchImpl: async (url) =>
          Response.json(url === '/api/health' ? health : { providers }),
      }),
      { code: 'INVALID_STATUS' },
    );
  }
});

test('authorization and malformed JSON produce their actual recovery guidance', async () => {
  let denied;
  try {
    await readDeploymentStatus({
      fetchImpl: async () => new Response(null, { status: 403 }),
    });
  } catch (error) {
    denied = error;
  }
  assert.equal(denied.status, 403);
  assert.match(deploymentStatusFailureCopy(denied), /requires access/);
  assert.doesNotMatch(
    deploymentStatusFailureCopy(denied),
    /connection|microphone/,
  );
  await assert.rejects(
    readDeploymentStatus({
      fetchImpl: async () => new Response('<!doctype html>'),
    }),
    { code: 'INVALID_STATUS' },
  );
  assert.match(
    deploymentStatusFailureCopy({ name: 'TimeoutError' }),
    /timed out/,
  );
});

test('status checks pass disposal through to both requests', async () => {
  const controller = new AbortController();
  const signals = [];
  const pending = readDeploymentStatus({
    signal: controller.signal,
    fetchImpl: (_url, { signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
});

test('startup diagnostics retain nested graphics failures without blaming unrelated failures on connectivity', () => {
  const graphics = startupFailureCopy(
    new AggregateError(
      [new Error('WebGL context creation failed')],
      'Startup failed',
    ),
  );
  assert.match(graphics.title, /3D globe/);
  assert.match(graphics.detail, /WebGL context creation failed/);
  assert.doesNotMatch(
    startupFailureCopy(new Error('Invalid catalog')).guidance,
    /connection/,
  );
});
