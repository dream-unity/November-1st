import schema from './contracts/earth-bridge.schema.json' with { type: 'json' };

export const CHANNEL = 'dream-unity:earth';
export const UUID_V4 =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const PARENT_KINDS = new Set([
  'INIT',
  'START',
  'COMMAND',
  'CANCEL',
  'SUSPEND',
  'RESUME',
  'SNAPSHOT_REQUEST',
  'MEDIA_FOCUS_GRANTED',
  'QUIET_REQUEST',
  'ACK',
]);
export const CHILD_KINDS = new Set([
  'HELLO',
  'READY',
  'FAILED',
  'RESULT',
  'ACK',
  'REQUEST_HOME',
  'SNAPSHOT',
  'MEDIA_FOCUS_REQUEST',
  'QUIET_ACK',
  'STATUS',
]);

const plain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Strict validator for the finite JSON Schema vocabulary in the pinned contract. */
export function matchesSchema(value, rule) {
  if (
    rule.oneOf &&
    rule.oneOf.filter((candidate) => matchesSchema(value, candidate)).length !==
      1
  )
    return false;
  if (
    rule.anyOf &&
    !rule.anyOf.some((candidate) => matchesSchema(value, candidate))
  )
    return false;
  if (Object.hasOwn(rule, 'const') && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  if (rule.type === 'null' && value !== null) return false;
  if (rule.type === 'boolean' && typeof value !== 'boolean') return false;
  if (rule.type === 'string') {
    if (typeof value !== 'string') return false;
    const length = [...value].length;
    if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity))
      return false;
    if (rule.format === 'uuid' && !UUID_V4.test(value)) return false;
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) return false;
  }
  if (rule.type === 'number' || rule.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (rule.type === 'integer' && !Number.isSafeInteger(value))
    )
      return false;
    if (
      value < (rule.minimum ?? -Infinity) ||
      value > (rule.maximum ?? Infinity)
    )
      return false;
  }
  if (rule.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < (rule.minItems ?? 0) ||
      value.length > (rule.maxItems ?? Infinity)
    )
      return false;
    if (
      rule.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    )
      return false;
    if (rule.items && !value.every((item) => matchesSchema(item, rule.items)))
      return false;
  }
  if (rule.type === 'object') {
    if (!plain(value)) return false;
    if ((rule.required ?? []).some((key) => !Object.hasOwn(value, key)))
      return false;
    const properties = rule.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(properties, key)) {
        if (rule.additionalProperties === false) return false;
      } else if (!matchesSchema(item, properties[key])) return false;
    }
  }
  return true;
}

export function validateMessage(value, direction = 'parent') {
  const kinds = direction === 'parent' ? PARENT_KINDS : CHILD_KINDS;
  if (!plain(value) || !kinds.has(value.kind)) return false;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768)
      return false;
    return matchesSchema(value, schema);
  } catch {
    return false;
  }
}

export function createRateGate(limit = 30, now = () => performance.now()) {
  let windowStart = now(),
    count = 0;
  return () => {
    const time = now();
    if (time - windowStart >= 1000) {
      windowStart = time;
      count = 0;
    }
    return ++count <= limit;
  };
}
