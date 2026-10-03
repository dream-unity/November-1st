import test from 'node:test';
import assert from 'node:assert/strict';
import { createRedisLedger } from './ledger.mjs';

test('Redis calls use authenticated server POST bodies and one atomic admission script', async () => {
  const seen = [];
  const ledger = createRedisLedger({
    url: 'https://redis.test.invalid',
    token: 'test-server-redis',
    fetchImpl: async (url, options) => {
      seen.push({ url, options, command: JSON.parse(options.body) });
      const command = seen.at(-1).command;
      if (command[0] === 'EVAL' && command[1].includes('ZREMRANGEBYSCORE'))
        return Response.json({ result: ['admitted', command.at(-1)] });
      return Response.json({ result: null });
    },
  });
  const result = await ledger.admitVoice({
    inviteId: 'owner',
    attemptId: 'attempt',
    bodyHash: 'body-hash',
    sessionId: 'session',
    nowMs: 1000000,
    limits: {
      voiceConcurrentGlobal: 2,
      voiceConcurrentPerInvite: 1,
      voiceStartsPerInviteHour: 6,
      voiceStartsGlobalDay: 20,
    },
  });
  assert.equal(result.status, 'admitted');
  assert.equal(result.record.sessionId, 'session');
  assert.equal(seen.length, 1);
  const request = seen[0];
  assert.equal(request.url, 'https://redis.test.invalid');
  assert.equal(request.options.method, 'POST');
  assert.equal(
    request.options.headers.Authorization,
    'Bearer test-server-redis',
  );
  assert.equal(request.command[0], 'EVAL');
  assert.equal(request.command[2], 5);
  assert.match(request.command[1], /bodyHash.*conflict/s);
  assert.match(request.command[1], /ZCARD/);
  assert.match(request.command[1], /INCR/);
  assert.match(request.command[1], /EXPIRE/);
  assert.doesNotMatch(request.url, /test-server-redis|pipeline/);
});

test('failed Redis admission cannot degrade to local unlimited behavior', async () => {
  const ledger = createRedisLedger({
    url: 'https://redis.test.invalid',
    token: 'test',
    fetchImpl: async () =>
      Response.json(
        { error: 'provider error containing secret' },
        { status: 500 },
      ),
  });
  await assert.rejects(ledger.get('anything'), {
    code: 'SERVICE_NOT_READY',
    status: 503,
  });
  await assert.rejects(
    ledger.rateLimit({ key: 'owner', limit: 6, windowSeconds: 60 }),
    { code: 'SERVICE_NOT_READY' },
  );
});

test('continuation compare-and-swap executes a version check and update in one command', async () => {
  let command;
  const ledger = createRedisLedger({
    url: 'https://redis.test.invalid',
    token: 'test',
    fetchImpl: async (url, options) => {
      command = JSON.parse(options.body);
      return Response.json({ result: 0 });
    },
  });
  assert.equal(
    await ledger.compareAndSwap('turn:owner:id', 7, {
      version: 8,
      status: 'running',
    }),
    false,
  );
  assert.equal(command[0], 'EVAL');
  assert.equal(command[2], 1);
  assert.equal(command[3], 'du:unity:turn:owner:id');
  assert.match(command[1], /obj.version/);
  assert.equal(command[4], '7');
  assert.equal(JSON.parse(command[5]).version, 8);
});
