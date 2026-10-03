import { hash, serviceError } from './config.mjs';

const RATE_SCRIPT = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; if n>tonumber(ARGV[2]) then return 0 end; return 1`;
const CAS_SCRIPT = `local old=redis.call('GET',KEYS[1]); if not old then return 0 end; local obj=cjson.decode(old); if tostring(obj.version)~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',ARGV[3]); return 1`;
const ADMIT_VOICE = `
local old=redis.call('GET',KEYS[1]); if old then local o=cjson.decode(old); if o.bodyHash~=ARGV[1] then return {'conflict'} end; return {'duplicate',old} end
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',ARGV[2]); redis.call('ZREMRANGEBYSCORE',KEYS[3],'-inf',ARGV[2]);
if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[3]) or redis.call('ZCARD',KEYS[3])>=tonumber(ARGV[4]) or tonumber(redis.call('GET',KEYS[4]) or '0')>=tonumber(ARGV[5]) or tonumber(redis.call('GET',KEYS[5]) or '0')>=tonumber(ARGV[6]) then return {'limited'} end
redis.call('INCR',KEYS[4]); redis.call('EXPIRE',KEYS[4],7200); redis.call('INCR',KEYS[5]); redis.call('EXPIRE',KEYS[5],172800);
redis.call('ZADD',KEYS[2],ARGV[7],ARGV[8]); redis.call('ZADD',KEYS[3],ARGV[7],ARGV[8]); redis.call('EXPIRE',KEYS[2],5400); redis.call('EXPIRE',KEYS[3],5400);
redis.call('SET',KEYS[1],ARGV[9],'EX',5400); return {'admitted',ARGV[9]}`;
const ADMIT_TEXT = `
local old=redis.call('GET',KEYS[1]); if old then local o=cjson.decode(old); if o.bodyHash~=ARGV[1] then return {'conflict'} end; return {'duplicate',old} end
if tonumber(redis.call('GET',KEYS[2]) or '0')>=tonumber(ARGV[2]) or tonumber(redis.call('GET',KEYS[3]) or '0')>=tonumber(ARGV[3]) then return {'limited'} end
redis.call('INCR',KEYS[2]); redis.call('EXPIRE',KEYS[2],7200); redis.call('INCR',KEYS[3]); redis.call('EXPIRE',KEYS[3],172800);
redis.call('SET',KEYS[1],ARGV[4],'EX',900); return {'admitted',ARGV[4]}`;

/** Only this adapter can admit hosted provider work. No process-local fallback. */
export function createRedisLedger({
  url,
  token,
  fetchImpl = fetch,
  namespace = 'du:unity',
}) {
  const key = (name) => `${namespace}:${name}`;
  async function command(parts) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(parts),
        signal: AbortSignal.timeout(5000),
      });
      if ([401, 403].includes(response.status))
        throw serviceError('ADMISSION_CONFIGURATION_ERROR', 503);
      if (!response.ok) throw new Error();
      const reader = response.body.getReader();
      const responseParts = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error();
          responseParts.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = JSON.parse(Buffer.concat(responseParts).toString('utf8'));
      if (body.error || !Object.hasOwn(body, 'result')) throw new Error();
      return body.result;
    } catch (failure) {
      if (failure?.code === 'ADMISSION_CONFIGURATION_ERROR') throw failure;
      throw serviceError('ADMISSION_UNAVAILABLE', 503, true);
    }
  }
  const evalScript = (script, keys, args) =>
    command([
      'EVAL',
      script,
      keys.length,
      ...keys.map(key),
      ...args.map(String),
    ]);
  return {
    async get(name) {
      const value = await command(['GET', key(name)]);
      return value === null ? null : JSON.parse(value);
    },
    async put(name, value, ttl = 900) {
      await command(['SET', key(name), JSON.stringify(value), 'EX', ttl]);
    },
    async putIfAbsent(name, value, ttl = 900) {
      return (
        (await command([
          'SET',
          key(name),
          JSON.stringify(value),
          'EX',
          ttl,
          'NX',
        ])) === 'OK'
      );
    },
    async compareAndSwap(name, version, value, ttl = 900) {
      return (
        (await evalScript(
          CAS_SCRIPT,
          [name],
          [version, JSON.stringify(value), ttl],
        )) === 1
      );
    },
    async remove(name) {
      await command(['DEL', key(name)]);
    },
    async rateLimit({ key: name, limit, windowSeconds }) {
      return (
        (await evalScript(
          RATE_SCRIPT,
          [`rate:${name}:${Math.floor(Date.now() / (windowSeconds * 1000))}`],
          [windowSeconds * 2, limit],
        )) === 1
      );
    },
    async admitVoice({
      inviteId,
      attemptId,
      bodyHash,
      sessionId,
      nowMs,
      limits,
    }) {
      const record = {
        version: 1,
        status: 'starting',
        inviteId,
        attemptId,
        bodyHash,
        sessionId,
        createdAtMs: nowMs,
      };
      const result = await evalScript(
        ADMIT_VOICE,
        [
          `attempt:${inviteId}:${attemptId}`,
          'active:global',
          `active:${inviteId}`,
          `voice:hour:${inviteId}:${Math.floor(nowMs / 3600000)}`,
          `voice:day:${Math.floor(nowMs / 86400000)}`,
        ],
        [
          bodyHash,
          nowMs,
          limits.voiceConcurrentGlobal,
          limits.voiceConcurrentPerInvite,
          limits.voiceStartsPerInviteHour,
          limits.voiceStartsGlobalDay,
          nowMs + 65 * 60000,
          sessionId,
          JSON.stringify(record),
        ],
      );
      return {
        status: result[0],
        record: result[1] ? JSON.parse(result[1]) : undefined,
      };
    },
    async commitVoice({ inviteId, attemptId, sessionId, record }) {
      // Ownership records are written atomically together; active slots were reserved earlier.
      const committed = await command([
        'EVAL',
        `redis.call('SET',KEYS[1],ARGV[1],'EX',5400); redis.call('SET',KEYS[2],ARGV[1],'EX',5400); return 1`,
        2,
        key(`attempt:${inviteId}:${attemptId}`),
        key(`session:${sessionId}`),
        JSON.stringify(record),
      ]);
      if (committed !== 1) throw serviceError('SERVICE_NOT_READY', 503);
    },
    async releaseVoice({ inviteId, sessionId }) {
      await evalScript(
        `redis.call('ZREM',KEYS[1],ARGV[1]); redis.call('ZREM',KEYS[2],ARGV[1]); return 1`,
        ['active:global', `active:${inviteId}`],
        [sessionId],
      );
    },
    async reserveTextTurn({ inviteId, turnId, bodyHash, nowMs, limits }) {
      const record = {
        version: 1,
        inviteId,
        turnId,
        bodyHash,
        createdAtMs: nowMs,
      };
      const result = await evalScript(
        ADMIT_TEXT,
        [
          `text-admission:${inviteId}:${turnId}`,
          `text:hour:${inviteId}:${Math.floor(nowMs / 3600000)}`,
          `text:day:${Math.floor(nowMs / 86400000)}`,
        ],
        [
          bodyHash,
          limits.textTurnsPerInviteHour,
          limits.textTurnsGlobalDay,
          JSON.stringify(record),
        ],
      );
      return {
        status: result[0],
        record: result[1] ? JSON.parse(result[1]) : undefined,
      };
    },
    // Exported for focused tests; these strings contain no service credentials.
    scripts: { RATE_SCRIPT, CAS_SCRIPT, ADMIT_VOICE, ADMIT_TEXT },
  };
}
