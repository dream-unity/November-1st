import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, readUnityConfig } from './config.mjs';

const BASE = Object.freeze({
  UNITY_AI_ENABLED: '1',
  UNITY_OPENAI_API_KEY: 'fixture-provider-not-live',
  UNITY_SIGNING_KEY: 'fixture-signing-not-live-at-least32chars',
  UNITY_CONTEXT_ENCRYPTION_KEY: 'ab'.repeat(32),
  UNITY_INVITE_HASHES_JSON: JSON.stringify([
    { id: 'owner', hash: hash('fixture-invitation-not-live') },
  ]),
});
const SOURCES = [
  ['UNITY_REDIS_REST_URL', 'UNITY_REDIS_REST_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
];
const pair = (index) => ({
  [SOURCES[index][0]]: `https://redis-${index}.test.invalid`,
  [SOURCES[index][1]]: `fixture-redis-${index}-not-live`,
});

for (const [index, names] of SOURCES.entries()) {
  test(`${names[0]} and its matching token configure shared admission`, () => {
    const env = { ...BASE, ...pair(index) };
    const before = { ...env };
    const config = readUnityConfig(env);
    assert.equal(config.ready, true);
    assert.equal(config.cleanupReady, true);
    assert.deepEqual(config.reasonCodes, []);
    assert.equal(config.redisUrl, env[names[0]]);
    assert.equal(config.redisToken, env[names[1]]);
    assert.deepEqual(env, before);
  });

  test(`${names[0]} keeps URL and token validation`, () => {
    for (const url of [
      'http://redis.test.invalid',
      'https://user:password@redis.test.invalid',
      'https://redis.test.invalid/path',
      'https://redis.test.invalid/?token=fixture',
      'https://redis.test.invalid/#fragment',
      'not-a-url',
    ]) {
      const config = readUnityConfig({
        ...BASE,
        ...pair(index),
        [names[0]]: url,
      });
      assert.equal(config.ready, false);
      assert.equal(config.cleanupReady, false);
      assert.deepEqual(config.reasonCodes, ['ADMISSION_NOT_CONFIGURED']);
    }
    for (const token of ['', ' ', 'fixture token', 'your_token']) {
      const config = readUnityConfig({
        ...BASE,
        ...pair(index),
        [names[1]]: token,
      });
      assert.equal(config.ready, false);
      assert.equal(config.cleanupReady, false);
      assert.deepEqual(config.reasonCodes, ['ADMISSION_NOT_CONFIGURED']);
    }
  });
}

test('explicit Unity credentials take precedence over both managed aliases', () => {
  const env = { ...BASE, ...pair(0), ...pair(1), ...pair(2) };
  const config = readUnityConfig(env);
  assert.equal(config.redisUrl, env.UNITY_REDIS_REST_URL);
  assert.equal(config.redisToken, env.UNITY_REDIS_REST_TOKEN);
});

test('standard Upstash credentials take precedence over the Vercel KV pair', () => {
  const env = { ...BASE, ...pair(1), ...pair(2) };
  const config = readUnityConfig(env);
  assert.equal(config.redisUrl, env.UPSTASH_REDIS_REST_URL);
  assert.equal(config.redisToken, env.UPSTASH_REDIS_REST_TOKEN);
});

test('an incomplete selected pair never borrows from or falls through to another source', () => {
  for (const [index, names] of SOURCES.entries()) {
    const lowerSources = Object.assign(
      {},
      ...SOURCES.slice(index + 1).map((_, offset) => pair(index + offset + 1)),
    );
    for (const presentName of names) {
      const env = {
        ...BASE,
        ...lowerSources,
        [presentName]: pair(index)[presentName],
      };
      const config = readUnityConfig(env);
      assert.equal(config.ready, false);
      assert.equal(config.cleanupReady, false);
      assert.deepEqual(config.reasonCodes, ['ADMISSION_NOT_CONFIGURED']);
      assert.equal(config.redisUrl, env[names[0]] || '');
      assert.equal(config.redisToken, env[names[1]] || '');
    }
  }
});

test('a blank or invalid higher-priority pair fails closed despite valid aliases', () => {
  for (const index of [0, 1]) {
    const [urlName, tokenName] = SOURCES[index];
    const lowerSources = Object.assign(
      {},
      ...SOURCES.slice(index + 1).map((_, offset) => pair(index + offset + 1)),
    );
    for (const selected of [
      { [urlName]: '' },
      { [tokenName]: '' },
      { [urlName]: '', [tokenName]: '' },
      { ...pair(index), [urlName]: 'http://redis.test.invalid' },
      { ...pair(index), [tokenName]: 'replace_token' },
    ]) {
      const config = readUnityConfig({ ...BASE, ...lowerSources, ...selected });
      assert.equal(config.ready, false);
      assert.equal(config.cleanupReady, false);
      assert.deepEqual(config.reasonCodes, ['ADMISSION_NOT_CONFIGURED']);
    }
  }
});

test('missing, read-only, and arbitrary-prefix credentials do not configure admission', () => {
  for (const extras of [
    {},
    {
      KV_REST_API_URL: 'https://redis.test.invalid',
      KV_REST_API_READ_ONLY_TOKEN: 'fixture-readonly',
    },
    {
      CUSTOM_REST_API_URL: 'https://redis.test.invalid',
      CUSTOM_REST_API_TOKEN: 'fixture-custom',
    },
  ]) {
    const config = readUnityConfig({ ...BASE, ...extras });
    assert.equal(config.ready, false);
    assert.equal(config.cleanupReady, false);
    assert.deepEqual(config.reasonCodes, ['ADMISSION_NOT_CONFIGURED']);
  }
});

test('managed Redis credentials do not bypass provider, signing, encryption, invitation, or enablement gates', () => {
  for (const [name, value, reason] of [
    ['UNITY_OPENAI_API_KEY', '', 'PROVIDER_NOT_CONFIGURED'],
    ['UNITY_SIGNING_KEY', '', 'SIGNING_NOT_CONFIGURED'],
    ['UNITY_CONTEXT_ENCRYPTION_KEY', '', 'CONTEXT_ENCRYPTION_NOT_CONFIGURED'],
    ['UNITY_INVITE_HASHES_JSON', '[]', 'INVITES_NOT_CONFIGURED'],
    ['UNITY_AI_ENABLED', '0', 'AI_DISABLED'],
  ]) {
    const config = readUnityConfig({ ...BASE, ...pair(2), [name]: value });
    assert.equal(config.ready, false);
    assert.deepEqual(config.reasonCodes, [reason]);
  }
});
