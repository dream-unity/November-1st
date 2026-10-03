import test from 'node:test';
import assert from 'node:assert/strict';
import { createHudSummaryPolicy } from './hudSummaryPolicy.js';
import { capabilityReport, readHostConfig } from '../../host/config.mjs';

const capabilities = (env = {}, authorized = false) =>
  capabilityReport(readHostConfig(env, 'serverless'), env, { authorized });
const configured = {
  OPENAI_API_KEY: 'test-openai-key',
  GOOGLE_MAPS_SERVER_API_KEY: 'test-google-key',
};
function connectedVoice() {
  return {
    startEpoch: 1,
    session: { state: 'listening', disposed: false, isActive: () => true },
    pc: { connectionState: 'connected' },
    dc: { readyState: 'open' },
    isSessionEnding: () => false,
  };
}

test('HUD configuration probing requires an explicitly connected live voice owner', async () => {
  for (const modify of [
    () => null,
    (voice) => ({
      ...voice,
      session: { ...voice.session, state: 'connecting' },
    }),
    (voice) => ({ ...voice, pc: { connectionState: 'disconnected' } }),
    (voice) => ({ ...voice, dc: { readyState: 'connecting' } }),
    (voice) => ({ ...voice, isSessionEnding: () => true }),
    (voice) => ({ ...voice, lifetimeSignal: AbortSignal.abort() }),
  ]) {
    const voice = modify(connectedVoice());
    let requests = 0;
    const policy = createHudSummaryPolicy({
      getVoice: () => voice,
      fetchImpl: async () => {
        requests++;
        return Response.json(capabilities(configured, true));
      },
    });
    assert.equal(await policy.authorize(), null);
    assert.equal(requests, 0);
  }
});

test('HUD requires actual OpenAI availability/access while Google is independently optional', async () => {
  for (const [env, authorized, allowed, cachedOnly] of [
    [{}, true, false],
    [configured, false, false],
    [{ OPENAI_API_KEY: 'test-openai-key' }, true, true, true],
    [configured, true, true, false],
    [{ ...configured, GEV_ALLOW_PAID_PUBLIC: '1' }, false, true, false],
  ]) {
    const voice = connectedVoice();
    const seen = [];
    const policy = createHudSummaryPolicy({
      getVoice: () => voice,
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return Response.json(capabilities(env, authorized));
      },
    });
    const grant = await policy.authorize();
    assert.equal(Boolean(grant), allowed);
    if (allowed) {
      assert.equal(grant.isCurrent(), true);
      assert.equal(grant.contextOptions.cachedOnly, cachedOnly);
    }
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/api/capabilities');
    assert.equal(seen[0].init.credentials, 'same-origin');
    assert.equal(seen[0].init.cache, 'no-store');
  }
});

test('unknown, conflicting and unavailable provider metadata never grants HUD enrichment', async () => {
  const good = {
    id: 'voice',
    status: 'configured',
    configured: true,
    available: true,
  };
  for (const providers of [
    [],
    [{ ...good, available: false }],
    [{ ...good, configured: false }],
    [{ ...good, status: 'protected' }],
    [{ id: 'voice', status: 'configured' }],
    [good, good],
  ]) {
    const voice = connectedVoice();
    const policy = createHudSummaryPolicy({
      getVoice: () => voice,
      fetchImpl: async () => Response.json({ providers }),
    });
    assert.equal(await policy.authorize(), null);
  }
  for (const google of [
    { id: 'google', status: 'protected' },
    { id: 'google', status: 'unknown' },
    { id: 'google', status: 'not-configured' },
  ]) {
    const voice = connectedVoice();
    const policy = createHudSummaryPolicy({
      getVoice: () => voice,
      fetchImpl: async () => Response.json({ providers: [good, google] }),
    });
    assert.equal((await policy.authorize()).contextOptions.cachedOnly, true);
  }
});

test('delayed capability reads and existing grants cannot migrate to another voice lifetime', async () => {
  for (const change of [
    (voice) => {
      voice.session.state = 'idle';
    },
    (voice) => {
      voice.pc.connectionState = 'disconnected';
    },
    (voice) => {
      voice.dc.readyState = 'closed';
    },
    (voice) => {
      voice.startEpoch++;
    },
    (voice) => {
      voice.pc = { connectionState: 'connected' };
    },
    (voice) => {
      voice.session = { ...voice.session };
    },
    (voice) => {
      voice.isSessionEnding = () => true;
    },
  ]) {
    const voice = connectedVoice();
    let finish;
    const policy = createHudSummaryPolicy({
      getVoice: () => voice,
      fetchImpl: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = policy.authorize();
    change(voice);
    finish(Response.json(capabilities(configured, true)));
    assert.equal(await pending, null);
    const live = connectedVoice();
    const livePolicy = createHudSummaryPolicy({
      getVoice: () => live,
      fetchImpl: async () => Response.json(capabilities(configured, true)),
    });
    const grant = await livePolicy.authorize();
    change(live);
    assert.equal(grant.isCurrent(), false);
  }
});

test('unavailable status and hidden/aborted owners fail closed without provider requests', async () => {
  const voice = connectedVoice();
  let requests = 0;
  for (const options of [
    { isVisible: () => false },
    { signal: AbortSignal.abort() },
  ]) {
    const policy = createHudSummaryPolicy({
      getVoice: () => voice,
      ...options,
      fetchImpl: async () => {
        requests++;
        return Response.json(capabilities(configured, true));
      },
    });
    assert.equal(await policy.authorize(), null);
  }
  assert.equal(requests, 0);
  for (const fetchImpl of [
    async () => new Response('unavailable', { status: 503 }),
    async () => {
      throw new TypeError('offline');
    },
    async () => Response.json({ providers: null }),
  ]) {
    assert.equal(
      await createHudSummaryPolicy({
        getVoice: () => voice,
        fetchImpl,
      }).authorize(),
      null,
    );
  }
});
