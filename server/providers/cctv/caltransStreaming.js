import { createHash } from 'node:crypto';

/**
 * Caltrans publishes these HLS URLs in imageData.streamingVideoURL. Never
 * construct a stream from a still-image URL: many cameras only offer images.
 * The exact official media origin and district/stream path are pinned so a
 * catalogue edit cannot turn the media relay into an arbitrary URL proxy.
 */
export function normalizeCaltransStreamUrl(value, district) {
  if (typeof value !== 'string' || !value.trim()) return '';
  if (/[\\\u0000-\u0020]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://wzmedia.dot.ca.gov' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !Number.isInteger(district) ||
      district < 1 ||
      district > 12 ||
      !new RegExp(
        `^/D${district}/[A-Za-z0-9_.-]+\\.stream/playlist\\.m3u8$`,
      ).test(url.pathname)
    )
      return '';
    return url.toString();
  } catch {
    return '';
  }
}

/** A still remains available as an explicitly labelled preview of a stream. */
export function normalizeCaltransSnapshotUrl(value, district) {
  if (typeof value !== 'string' || /[\\\u0000-\u0020]/.test(value)) return '';
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://cwwp2.dot.ca.gov' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith(`/data/d${district}/cctv/image/`) ||
      /%(?:2f|5c|2e|25)/i.test(url.pathname) ||
      !/\.jpe?g$/i.test(url.pathname)
    )
      return '';
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * The catalogue's numeric index and array position are not camera identities.
 * Anchor fallback IDs to the canonical official media URL so a district outage
 * or a row reorder cannot silently hand an existing selection to another camera.
 */
export function caltransSourceId(district, officialUrl, uniqueCode = '') {
  if (uniqueCode) return `ca-d${district}-${uniqueCode.toLowerCase()}`;
  const digest = createHash('sha256')
    .update(officialUrl)
    .digest('hex')
    .slice(0, 20);
  return `ca-d${district}-source-${digest}`;
}
