import { createHash } from 'node:crypto';
import { configuredCredential } from '../providers/openai/status.js';

export const CONTRACT_VERSION = 'du-prototype/1.0';
export const DEFAULT_LIMITS = Object.freeze({
  voiceStartsPerInviteHour: 6,
  voiceStartsGlobalDay: 20,
  voiceConcurrentPerInvite: 1,
  voiceConcurrentGlobal: 2,
  textTurnsPerInviteHour: 20,
  textTurnsGlobalDay: 100,
  textProviderRoundsMax: 3,
  textOutputTokensMax: 1200,
  voiceClientDurationSeconds: 720,
  voiceClientIdleSeconds: 90,
  accessTokenSeconds: 900,
  closeTokenSeconds: 5400,
  transientContextSeconds: 900,
});

export const hash = (value) =>
  createHash('sha256').update(String(value)).digest('hex');
export function serviceError(code, status = 400, retryable = false) {
  return Object.assign(new Error(code), { code, status, retryable });
}

export function readUnityConfig(env = process.env) {
  const positive = (name, fallback, maximum) => {
    if (!env[name]) return fallback;
    const value = Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw serviceError('SERVICE_NOT_READY', 503);
    return value;
  };
  let invites = [];
  try {
    invites = JSON.parse(env.UNITY_INVITE_HASHES_JSON || '[]');
    if (!Array.isArray(invites) || invites.length > 64) throw new Error();
    invites = invites.map((item) => {
      if (
        !item ||
        typeof item.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ||
        !/^[a-f0-9]{64}$/.test(item.hash) ||
        Object.keys(item).some((key) => !['id', 'hash'].includes(key))
      )
        throw new Error();
      return { id: item.id, hash: item.hash };
    });
    if (
      new Set(invites.map((item) => item.id)).size !== invites.length ||
      new Set(invites.map((item) => item.hash)).size !== invites.length
    )
      throw new Error();
  } catch {
    throw serviceError('SERVICE_NOT_READY', 503);
  }
  const key = String(env.UNITY_OPENAI_API_KEY || '').trim();
  const signingKey = String(env.UNITY_SIGNING_KEY || '');
  const encryptionKey = String(env.UNITY_CONTEXT_ENCRYPTION_KEY || '');
  const redisUrl = String(env.UNITY_REDIS_REST_URL || '');
  const redisToken = String(env.UNITY_REDIS_REST_TOKEN || '');
  let validRedis = false;
  try {
    const url = new URL(redisUrl);
    validRedis =
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/';
  } catch {
    /* Missing configuration is represented by readiness. */
  }
  const enabled = env.UNITY_AI_ENABLED === '1';
  const providerConfigured = configuredCredential(key);
  const signingConfigured =
    signingKey.length >= 32 && configuredCredential(signingKey);
  const contextConfigured = /^[a-fA-F0-9]{64}$/.test(encryptionKey);
  const admissionConfigured = validRedis && configuredCredential(redisToken);
  const cleanupReady =
    providerConfigured && signingConfigured && admissionConfigured;
  const ready =
    enabled && cleanupReady && contextConfigured && invites.length > 0;
  // Safe configuration diagnostics only. Never publish values, invite IDs or
  // claims that an upstream account or Redis connection has been verified.
  const reasonCodes = [
    ...(!enabled ? ['AI_DISABLED'] : []),
    ...(!providerConfigured ? ['PROVIDER_NOT_CONFIGURED'] : []),
    ...(!signingConfigured ? ['SIGNING_NOT_CONFIGURED'] : []),
    ...(!contextConfigured ? ['CONTEXT_ENCRYPTION_NOT_CONFIGURED'] : []),
    ...(!admissionConfigured ? ['ADMISSION_NOT_CONFIGURED'] : []),
    ...(!invites.length ? ['INVITES_NOT_CONFIGURED'] : []),
  ];
  return {
    enabled,
    ready,
    cleanupReady,
    providerConfigured,
    reasonCodes,
    key,
    signingKey,
    encryptionKey,
    redisUrl,
    redisToken,
    invites,
    limits: {
      ...DEFAULT_LIMITS,
      voiceStartsPerInviteHour: positive(
        'UNITY_VOICE_STARTS_PER_INVITE_HOUR',
        6,
        100,
      ),
      voiceStartsGlobalDay: positive('UNITY_VOICE_STARTS_GLOBAL_DAY', 20, 1000),
      voiceConcurrentGlobal: positive('UNITY_VOICE_CONCURRENT_GLOBAL', 2, 20),
      textTurnsPerInviteHour: positive(
        'UNITY_TEXT_TURNS_PER_INVITE_HOUR',
        20,
        1000,
      ),
      textTurnsGlobalDay: positive('UNITY_TEXT_TURNS_GLOBAL_DAY', 100, 10000),
    },
  };
}
