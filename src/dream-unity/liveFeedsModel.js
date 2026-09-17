import { publicRadioHttpsUrl, RADIO_UUID_RE } from '../sources/radioBrowser.js';
import { normalizeFeedType } from '../sources/cctvTypes.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../sources/httpBody.js';

const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const text = (value, max = 200) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const coordinate = (value, limit) =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  Math.abs(value) <= limit;

export function feedCoordinates(item) {
  return coordinate(item?.lat, 90) && coordinate(item?.lon, 180);
}

/** Admit only stream URLs usable on this HTTPS site; directory text stays text. */
export function normalizeFeedDirectory(kind, payload) {
  const input = kind === 'radio' ? payload?.stations : payload?.sources;
  if (
    !['radio', 'cctv'].includes(kind) ||
    !Array.isArray(input) ||
    input.length > 20_000
  )
    throw new Error('The directory returned an invalid response.');
  const seen = new Set();
  const items = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || !feedCoordinates(raw)) continue;
    const id = text(raw.id, 200);
    const name = text(raw.name);
    if (!id || !name || seen.has(id)) continue;
    if (kind === 'radio') {
      const streamUrl = publicRadioHttpsUrl(raw.streamUrl);
      if (!RADIO_UUID_RE.test(id) || !streamUrl) continue;
      items.push({
        ...raw,
        id,
        name,
        streamUrl,
        homepage: publicRadioHttpsUrl(raw.homepage),
        country: text(raw.country, 80),
        countryCode: text(raw.countryCode, 2),
        state: text(raw.state, 80),
        tags: Array.isArray(raw.tags)
          ? raw.tags
              .map((value) => text(value, 80))
              .filter(Boolean)
              .slice(0, 24)
          : [],
        languages: Array.isArray(raw.languages)
          ? raw.languages
              .map((value) => text(value, 40))
              .filter(Boolean)
              .slice(0, 8)
          : [],
        codec: text(raw.codec, 16),
      });
    } else {
      const feedType = normalizeFeedType(raw.feedType);
      if (!['image', 'mjpeg', 'mp4', 'webm', 'hls'].includes(feedType))
        continue;
      items.push({
        ...raw,
        id,
        name,
        feedType,
        city: text(raw.city, 100),
        provider: text(raw.provider, 100),
        license: text(raw.license, 500),
        credit: text(raw.credit, 500),
        sourceKind: text(raw.sourceKind, 100),
      });
    }
    seen.add(id);
  }
  if (input.length && !items.length)
    throw new Error('The directory contained no usable entries.');
  return {
    items,
    rejected: input.length - items.length,
    stale: payload?.stale === true,
    degraded: payload?.degraded === true,
    updatedAt:
      typeof payload?.updatedAt === 'string' &&
      Number.isFinite(Date.parse(payload.updatedAt))
        ? payload.updatedAt
        : null,
  };
}

export function filterFeedDirectory(items, query = '', region = '') {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    if (region && (item.country || item.city || '') !== region) return false;
    const haystack = [
      item.name,
      item.country,
      item.countryCode,
      item.state,
      item.city,
      item.provider,
      ...(item.tags || []),
      ...(item.languages || []),
    ]
      .join(' ')
      .toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export async function readFeedDirectory(
  kind,
  { signal, fetchImpl = globalThis.fetch } = {},
) {
  if (!['radio', 'cctv'].includes(kind)) throw new Error('Unknown directory.');
  const requestSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(35_000),
  ]);
  const response = await fetchImpl(
    `/api/${kind}/${kind === 'radio' ? 'stations' : 'sources'}`,
    { signal: requestSignal, cache: 'no-store', credentials: 'same-origin' },
  );
  if (!response.ok)
    throw new Error(
      `The ${kind === 'radio' ? 'radio' : 'camera'} directory is unavailable (HTTP ${response.status}). Try again.`,
    );
  return normalizeFeedDirectory(
    kind,
    await readResponseJsonCapped(response, MAX_DIRECTORY_BYTES, requestSignal),
  );
}

/** Read real camera bytes only. The strict endpoint never substitutes scenery. */
export async function readCctvSnapshot(
  camera,
  { signal, fetchImpl = globalThis.fetch } = {},
) {
  const requestSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(20_000),
  ]);
  const path = `/api/cctv/frame/${encodeURIComponent(camera.id)}?strict=1&ts=${Date.now()}`;
  const response = await fetchImpl(path, {
    signal: requestSignal,
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!response.ok) {
    let message;
    try {
      const body = JSON.parse(
        await readResponseTextCapped(response, 16_384, requestSignal),
      );
      message = typeof body.message === 'string' ? body.message : body.error;
    } catch {
      /* HTTP status remains useful. */
    }
    throw new Error(
      text(message, 300) ||
        `Camera snapshot unavailable (HTTP ${response.status}). Try another camera or retry.`,
    );
  }
  const type = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (response.headers.get('x-cctv-source') !== 'upstream-image') {
    void response.body?.cancel().catch(() => {});
    throw new Error(
      'The camera source did not confirm a real snapshot. Try another camera or retry.',
    );
  }
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) {
    void response.body?.cancel().catch(() => {});
    throw new Error(
      'This camera did not return a real image. Try another camera or retry.',
    );
  }
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_FRAME_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('The camera image exceeds the supported size.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Camera image could not be read.');
  const chunks = [];
  let size = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  requestSignal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      requestSignal.throwIfAborted();
      const { done, value } = await reader.read();
      requestSignal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FRAME_BYTES)
        throw new Error('The camera image exceeds the supported size.');
      chunks.push(value);
    }
    if (!size) throw new Error('The camera returned an empty image.');
    return new Blob(chunks, { type });
  } catch (error) {
    abort();
    throw error;
  } finally {
    requestSignal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
