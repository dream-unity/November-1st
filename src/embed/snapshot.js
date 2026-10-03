export const SHARE_KEYS = new Set([
  'v',
  'lat',
  'lon',
  'alt',
  'heading',
  'pitch',
  'roll',
  'style',
  'bloom',
  'sharpen',
  'bi',
  'bv',
  'si',
  'hud',
  'hv',
  'dm',
  'dd',
  'da',
  'kf',
  'ko',
  'cr',
  'sc',
  'scf',
  'sce',
  'map',
  'l',
  'lo',
  'ui',
  'sp',
  'at',
]);
const NUMBER_KEYS = new Set([
  'lat',
  'lon',
  'alt',
  'heading',
  'pitch',
  'roll',
  'bi',
  'bv',
  'si',
  'dd',
  'kf',
  'ko',
  'scf',
  'sce',
  'at',
]);

/** A share is data for the child parser, never a URL or destination. */
export function validateSnapshot(snapshot) {
  if (snapshot === null) return true;
  if (
    !snapshot ||
    snapshot.format !== 'gev-share-v2' ||
    typeof snapshot.hashParams !== 'string' ||
    snapshot.hashParams.length > 8192 ||
    typeof snapshot.hasUnsavedState !== 'boolean' ||
    ![null, 'radio', 'cctv', 'traffic'].includes(snapshot.feed)
  )
    return false;
  const params = new URLSearchParams(snapshot.hashParams);
  if (params.get('v') !== '2') return false;
  const seen = new Set();
  for (const [key, value] of params) {
    if (!SHARE_KEYS.has(key) || seen.has(key)) return false;
    seen.add(key);
    if (
      NUMBER_KEYS.has(key) &&
      (!value.trim() || !Number.isFinite(Number(value)))
    )
      return false;
  }
  if (!seen.has('lat') || !seen.has('lon')) return false;
  return (
    Math.abs(Number(params.get('lat'))) <= 90 &&
    Math.abs(Number(params.get('lon'))) <= 180
  );
}
