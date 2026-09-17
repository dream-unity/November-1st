import { publicRadioHttpsUrl, RADIO_UUID_RE } from '../sources/radioBrowser.js';
import {
  normalizeFeedType,
  cameraMediaKind,
  normalizeCctvEmbedUrl,
} from '../sources/cctvTypes.js';
import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from '../sources/httpBody.js';

const MAX_DIRECTORY_BYTES = 8 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
// These countries have complete, location-optional catalogues on the server.
export const RADIO_COUNTRY_DIRECTORIES = Object.freeze({
  AU: 'Australia',
  UA: 'Ukraine',
});
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

/** Country comes from source metadata, never a coordinate guess. */
export function cameraCountry(item) {
  const suppliedCode = text(item?.countryCode || item?.country, 80);
  const code = /^[a-z]{2}$/i.test(suppliedCode)
    ? suppliedCode.toUpperCase()
    : '';
  const suppliedName = text(item?.countryName, 80);
  const name = suppliedName || (!code ? text(item?.country, 80) : '') || code;
  return {
    code,
    name: name || 'Unknown country',
    value: code || (name ? `name:${name}` : '__unknown__'),
  };
}

export function cameraCountryOptions(items) {
  const countries = new Map();
  for (const item of items) {
    const country = cameraCountry(item);
    let entry = countries.get(country.value);
    if (!entry) {
      entry = { ...country, total: 0, live: 0 };
      countries.set(country.value, entry);
    }
    entry.total++;
    if (cameraMediaKind(item) === 'live') entry.live++;
  }
  return [...countries.values()].sort((a, b) =>
    a.value === '__unknown__'
      ? 1
      : b.value === '__unknown__'
        ? -1
        : a.name.localeCompare(b.name),
  );
}

/** Give each represented country a first-page place without reordering its cameras. */
export function interleaveCameraCountries(items) {
  const countries = new Map();
  for (const item of items) {
    const key = cameraCountry(item).value;
    if (!countries.has(key)) countries.set(key, { items: [], index: 0 });
    countries.get(key).items.push(item);
  }
  const queue = [...countries.values()];
  const result = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const country = queue[cursor];
    result.push(country.items[country.index++]);
    if (country.index < country.items.length) queue.push(country);
  }
  return result;
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
    if (!raw || typeof raw !== 'object') continue;
    if (kind === 'cctv' && !feedCoordinates(raw)) continue;
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
        lat: feedCoordinates(raw) ? raw.lat : null,
        lon: feedCoordinates(raw) ? raw.lon : null,
        streamUrl,
        streamFormat: raw.streamFormat === 'hls' ? 'hls' : 'progressive',
        liveOnly: raw.liveOnly === true,
        playbackKind: raw.playbackKind === 'live' ? 'live' : 'unknown',
        homepage: publicRadioHttpsUrl(raw.homepage),
        sourcePage: publicRadioHttpsUrl(raw.sourcePage),
        sourceKind: text(raw.sourceKind, 80),
        locationPrecision: feedCoordinates(raw)
          ? text(raw.locationPrecision, 40) || 'directory'
          : 'unknown',
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
      if (!['image', 'mjpeg', 'mp4', 'webm', 'hls', 'embed'].includes(feedType))
        continue;
      const embedUrl =
        feedType === 'embed' ? normalizeCctvEmbedUrl(raw.embedUrl) : null;
      if (feedType === 'embed' && !embedUrl) continue;
      const country = cameraCountry(raw);
      items.push({
        ...raw,
        id,
        name,
        feedType,
        embedUrl,
        liveOnly: raw.liveOnly === true,
        playbackKind: cameraMediaKind({ ...raw, feedType }),
        country: country.code,
        countryCode: country.code,
        countryName: country.value === '__unknown__' ? '' : country.name,
        city: text(raw.city, 100),
        state: text(raw.state, 80),
        provider: text(raw.provider, 100),
        license: text(raw.license, 500),
        credit: text(raw.credit, 500),
        sourceKind: text(raw.sourceKind, 100),
        sourcePage: publicRadioHttpsUrl(raw.sourcePage),
      });
    }
    seen.add(id);
  }
  if (input.length && !items.length)
    throw new Error('The directory contained no usable entries.');
  return {
    items,
    publisherSources:
      kind === 'cctv'
        ? normalizePublisherCameras(payload?.publisherSources)
        : [],
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

/** Links remain separate from playable sources and their live camera counts. */
export function normalizePublisherCameras(records) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  return records.slice(0, 100).flatMap((row) => {
    const sourcePage = publicRadioHttpsUrl(row?.sourcePage);
    if (
      !row ||
      row.access !== 'publisher-only' ||
      !sourcePage ||
      seen.has(sourcePage) ||
      !text(row.id) ||
      !text(row.name) ||
      !text(row.city) ||
      !/^[A-Z]{2}$/.test(row.country) ||
      !Number.isFinite(Date.parse(row.verifiedAt))
    )
      return [];
    seen.add(sourcePage);
    return [
      {
        id: text(row.id),
        name: text(row.name),
        city: text(row.city),
        state: text(row.state, 80),
        country: row.country,
        countryName: text(row.countryName, 80),
        sourcePage,
        verifiedAt: new Date(row.verifiedAt).toISOString(),
        feedType: 'publisher',
        access: 'publisher-only',
      },
    ];
  });
}

export function filterFeedDirectory(
  items,
  query = '',
  region = '',
  mediaKind = 'all',
  country = '',
) {
  // Ukrainian names can contain decomposed letters and several apostrophe
  // forms. Match equivalent text without removing meaningful Cyrillic letters.
  const searchable = (value) =>
    value
      .normalize('NFKC')
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .toLocaleLowerCase();
  const words = searchable(query).trim().split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const kind = cameraMediaKind(item);
    if (
      mediaKind !== 'all' &&
      (mediaKind === 'video'
        ? !['video', 'clip'].includes(kind)
        : kind !== mediaKind)
    )
      return false;
    const itemRegion = item.feedType ? item.city : item.country;
    if (region && (itemRegion || '') !== region) return false;
    if (country && cameraCountry(item).value !== country) return false;
    const haystack = searchable(
      [
        item.name,
        item.country,
        item.countryCode,
        item.countryName,
        item.state,
        item.city,
        item.provider,
        ...(item.tags || []),
        ...(item.languages || []),
        item.countryCode?.toUpperCase() === 'UA' || item.country === 'UA'
          ? 'Україна Українська Українське Ukraine Ukrainian'
          : '',
      ].join(' '),
    );
    return words.every((word) => haystack.includes(word));
  });
}

export async function readFeedDirectory(
  kind,
  { signal, country = '', fetchImpl = globalThis.fetch } = {},
) {
  if (!['radio', 'cctv'].includes(kind)) throw new Error('Unknown directory.');
  if (
    country &&
    (kind !== 'radio' || !Object.hasOwn(RADIO_COUNTRY_DIRECTORIES, country))
  )
    throw new Error('Unsupported country directory.');
  const requestSignal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(35_000),
  ]);
  const response = await fetchImpl(
    `/api/${kind}/${kind === 'radio' ? 'stations' : 'sources'}${country ? `?country=${country}` : ''}`,
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
