import { applyRadioIdentity } from './radioIdentity.js';

export const RADIO_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cleanRadioText(value, maxLength) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
}

export function isNonGlobalIpv4(hostname) {
  const pieces = hostname.split('.');
  if (pieces.length !== 4 || pieces.some((piece) => !/^\d{1,3}$/.test(piece)))
    return false;
  const values = pieces.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Return a normalized public HTTPS URL, or null for local/private targets. */
export function publicRadioHttpsUrl(value) {
  try {
    const url = new URL(String(value ?? ''));
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.username || url.password || !hostname)
      return null;
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      isNonGlobalIpv4(hostname) ||
      hostname.includes(':')
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Normalize one Radio Browser station and omit favicons and unsafe streams.
 * @param {object} raw Directory record.
 * @param {object} [options]
 * @param {(value: unknown) => string|null} [options.normalizeUrl] URL admission
 *   policy, applied to both stream and homepage; returns a safe URL or null.
 * @param {boolean} [options.requireGeo=true] Globe records require coordinates;
 *   a country audio directory can retain unlocated stations without inventing a pin.
 */
export function normalizeRadioBrowserStation(
  raw,
  {
    normalizeUrl = publicRadioHttpsUrl,
    requireGeo = true,
    allowHls = false,
  } = {},
) {
  const id = cleanRadioText(raw?.stationuuid, 40).toLowerCase();
  const coordinate = (value) =>
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim())
      ? null
      : typeof value === 'number' || typeof value === 'string'
        ? Number(value)
        : NaN;
  const rawLat = coordinate(raw?.geo_lat);
  const rawLon = coordinate(raw?.geo_long);
  const hasGeo = rawLat !== null && rawLon !== null;
  const lat = hasGeo ? rawLat : null;
  const lon = hasGeo ? rawLon : null;
  const codec = cleanRadioText(raw?.codec, 16).toUpperCase();
  const streamUrl = normalizeUrl(raw?.url_resolved || raw?.url);
  const streamPath = streamUrl ? new URL(streamUrl).pathname : '';
  const isHls = Number(raw?.hls) === 1 || /\.m3u8?$/i.test(streamPath);
  if (
    !RADIO_UUID_RE.test(id) ||
    Number(raw?.lastcheckok) !== 1 ||
    (isHls && !allowHls) ||
    /\.pls$/i.test(streamPath) ||
    (requireGeo && !hasGeo) ||
    (rawLat !== null && (!Number.isFinite(rawLat) || Math.abs(rawLat) > 90)) ||
    (rawLon !== null && (!Number.isFinite(rawLon) || Math.abs(rawLon) > 180)) ||
    !/^(?:MP3|AAC(?:\+|-LC|-HE)?|HE-AAC)$/i.test(codec) ||
    !streamUrl
  )
    return null;

  const name = cleanRadioText(raw?.name, 140);
  if (!name) return null;
  const tags = String(raw?.tags ?? '')
    .split(',')
    .map((tag) =>
      cleanRadioText(tag, 80)
        .toLocaleLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 24);
  const languages = String(raw?.language ?? '')
    .split(',')
    .map((language) => cleanRadioText(language, 40))
    .filter(Boolean)
    .slice(0, 8);
  const bitrate = Number(raw?.bitrate);
  return applyRadioIdentity({
    id,
    name,
    lat,
    lon,
    streamUrl,
    homepage: normalizeUrl(raw?.homepage),
    tags,
    languages,
    state: cleanRadioText(raw?.state, 80),
    country: cleanRadioText(raw?.country, 80),
    countryCode: cleanRadioText(raw?.countrycode, 80),
    metadataTrust: 'untrusted-community',
    codec,
    bitrate:
      Number.isInteger(bitrate) && bitrate >= 8 && bitrate <= 1024
        ? bitrate
        : null,
    clickCount: Math.max(0, Math.min(10_000_000, Number(raw?.clickcount) || 0)),
  });
}

export function publicRadioStation(station) {
  return {
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    streamUrl: station.streamUrl,
    homepage: station.homepage,
    tags: station.tags,
    languages: station.languages,
    state: station.state,
    country: station.country,
    countryCode: station.countryCode,
    metadataTrust: station.metadataTrust,
    codec: station.codec,
    bitrate: station.bitrate,
    ...Object.fromEntries(
      ['countryStatus', 'identitySource', 'identityCheckedAt']
        .filter((key) => station[key] !== undefined)
        .map((key) => [key, station[key]]),
    ),
  };
}
