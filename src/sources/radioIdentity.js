import { normalizeRadioCountryInput } from '../data/radioCountry.js';

// Match the programme's complete stream URL, not its brand, CDN, language or
// claimed directory location. CNN International and local CNN affiliates have
// different streams and must retain their own identities.
const VERIFIED_STREAMS = new Map([
  [
    'https://tunein.cdnstream1.com/2868_96.mp3',
    {
      name: 'CNN (US)',
      country: 'United States',
      countryCode: 'US',
      homepage: 'https://www.cnn.com/audio',
      countryStatus: 'verified',
      identitySource: 'https://tunein.com/cnn/',
      identityCheckedAt: '2026-09-23',
    },
  ],
]);

function streamKey(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.hash = '';
    // Query strings can select different programmes; do not discard them.
    return url.href;
  } catch {
    return '';
  }
}

function clearLocation(station) {
  return {
    ...station,
    state: '',
    city: '',
    region: '',
    locality: '',
    metroArea: '',
    metroMatch: '',
    geographicScope: '',
    geographySourcePage: null,
    lat: null,
    lon: null,
    locationPrecision: 'unknown',
  };
}

function conflictingIdentity(station) {
  return {
    ...clearLocation(station),
    country: '',
    countryCode: '',
    countryStatus: 'conflicting',
  };
}

/** Resolve broadcaster identity without inferring nationality from its audio. */
export function applyRadioIdentity(station) {
  if (!station || typeof station !== 'object') return station;
  const key = streamKey(station.streamUrl);
  const verified = VERIFIED_STREAMS.get(key);
  // Provenance is assigned here, never accepted from arbitrary directory data.
  const record = { ...station, streamUrl: key || station.streamUrl };
  delete record.identitySource;
  delete record.identityCheckedAt;
  if (verified) return { ...clearLocation(record), ...verified };
  if (record.countryStatus === 'conflicting')
    return conflictingIdentity(record);

  const rawCode =
    typeof record.countryCode === 'string' ? record.countryCode.trim() : '';
  // A malformed value such as USA must not be truncated into the valid US code.
  const code = normalizeRadioCountryInput(
    /^[a-z]{2}$/i.test(rawCode) ? rawCode : '',
  );
  const name = normalizeRadioCountryInput(record.country);
  const hasCode = code.valid && !code.empty;
  const hasName = name.valid && !name.empty;
  if (hasCode && hasName && code.code !== name.code)
    return conflictingIdentity(record);
  const country = hasCode ? code : hasName ? name : null;
  return {
    ...record,
    country: country?.name || '',
    countryCode: country?.code || '',
    countryStatus: country ? 'community' : 'unknown',
  };
}

/**
 * One playable stream has one directory identity. Contradictory country claims
 * remain listenable, but cannot acquire a country filter or an invented map pin.
 * Call before limiting or country filtering so a later duplicate is considered.
 */
export function reconcileRadioIdentities(stations) {
  const groups = new Map();
  for (const station of stations) {
    if (!station) continue;
    const resolved = applyRadioIdentity(station);
    const key = streamKey(resolved.streamUrl) || `id:${resolved.id}`;
    const group = groups.get(key);
    if (group) group.push(resolved);
    else groups.set(key, [resolved]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0].sourceKind?.startsWith('curated-')
      ? group[0]
      : group.find(
          (station) =>
            Number.isFinite(station.lat) && Number.isFinite(station.lon),
        ) || group[0];
    const verified = group.find(
      (station) => station.countryStatus === 'verified',
    );
    const combined = {
      ...(verified || first),
      tags: [
        ...new Set(
          group.flatMap((station) =>
            Array.isArray(station.tags) ? station.tags : [],
          ),
        ),
      ].slice(0, 24),
      languages: [
        ...new Set(
          group.flatMap((station) =>
            Array.isArray(station.languages) ? station.languages : [],
          ),
        ),
      ].slice(0, 8),
    };
    if (verified) return combined;
    const countries = new Set(
      group.map((station) => station.countryCode).filter(Boolean),
    );
    return countries.size > 1 ||
      group.some((station) => station.countryStatus === 'conflicting')
      ? conflictingIdentity(combined)
      : combined;
  });
}
