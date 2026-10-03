import {
  randomBytes,
  createHmac,
  timingSafeEqual,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import { serviceError } from './config.mjs';

const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function signCapability(payload, key) {
  const encoded = encode(payload);
  return `${encoded}.${createHmac('sha256', key).update(encoded).digest('base64url')}`;
}
export function verifyCapability(
  token,
  key,
  { kind, origin, now = Date.now() } = {},
) {
  try {
    if (typeof token !== 'string' || token.length > 4096) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error();
    const expected = createHmac('sha256', key).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual))
      throw new Error();
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (
      payload.kind !== kind ||
      payload.iss !== 'dream-unity' ||
      payload.aud !== 'unity-preview' ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= now ||
      (origin !== undefined && payload.origin !== origin)
    )
      throw new Error();
    return payload;
  } catch {
    throw serviceError('ACCESS_DENIED', 401);
  }
}
export function encryptContext(value, key, binding) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(binding));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    data: encrypted.toString('base64url'),
  };
}
export function decryptContext(value, key, binding) {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(key, 'hex'),
      Buffer.from(value.iv, 'base64url'),
    );
    decipher.setAAD(Buffer.from(binding));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64url'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(value.data, 'base64url')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw serviceError('CONTEXT_UNAVAILABLE', 409);
  }
}
