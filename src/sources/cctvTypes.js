/**
 * Canonicalize a CCTV feed type string to one of:
 * 'image', 'mjpeg', 'mp4', 'webm', 'hls', or pass-through.
 *
 * @param {string} value - Raw feed type (e.g. 'jpeg', 'mjpg', 'video', 'stream').
 * @returns {string} Normalized feed type.
 */
export function normalizeFeedType(value) {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'image';
  if (raw === 'jpeg' || raw === 'jpg' || raw === 'png') return 'image';
  if (raw === 'mjpg') return 'mjpeg';
  if (raw === 'video') return 'mp4';
  if (raw === 'stream') return 'hls';
  return raw;
}

/**
 * Check whether a normalized feed type represents streaming video.
 *
 * @param {string} feedType
 * @returns {boolean}
 */
export function isVideoFeedType(feedType) {
  return feedType === 'mp4' || feedType === 'webm' || feedType === 'hls';
}

/** Only owner-enabled official players; never accept arbitrary iframe HTML. */
export function normalizeCctvEmbedUrl(value) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/.test(value))
    return '';
  try {
    const url = new URL(value);
    // These aliases are published by the named camera owners. This is not an
    // allowlist for arbitrary surveillance players or arbitrary subdomains.
    const publicAliases = {
      'g3.ipcamlive.com': ['69421e5731fe2', '69421e4b4c166', '694222843b74d'],
      'g1.ipcamlive.com': ['boatramp'],
    };
    if (Object.hasOwn(publicAliases, url.hostname)) {
      const alias = url.searchParams.get('alias');
      const options = new Set([
        'autoplay',
        'mute',
        'disableautofullscreen',
        'disabledownloadbutton',
        'disableframecapture',
        'disablefullscreen',
        'disableuserpause',
        'disablezoombutton',
        'disabletimelapseplayer',
        'disablestorageplayer',
      ]);
      const seen = new Set();
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.hash ||
        url.pathname !== '/player/player.php' ||
        !publicAliases[url.hostname].includes(alias)
      )
        return '';
      for (const [key, option] of url.searchParams) {
        if (
          seen.has(key) ||
          (key !== 'alias' &&
            (!options.has(key) || !['0', '1'].includes(option)))
        )
          return '';
        seen.add(key);
      }
      // Canonical identity excludes optional player controls, so duplicates
      // cannot appear merely because one source requests autoplay or mute.
      return `${url.origin}/player/player.php?alias=${alias}`;
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      !['www.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname) ||
      !/^\/embed\/[A-Za-z0-9_-]{11}$/.test(url.pathname)
    )
      return '';
    return `https://www.youtube-nocookie.com${url.pathname}`;
  } catch {
    return '';
  }
}

export function cctvEmbedProvider(value) {
  const normalized = normalizeCctvEmbedUrl(value);
  if (!normalized) return '';
  return new URL(normalized).hostname === 'www.youtube-nocookie.com'
    ? 'youtube'
    : 'ipcamlive';
}

/** Containers alone do not prove a source is live; only declared live sources do. */
export function cameraMediaKind(camera) {
  const type = normalizeFeedType(camera?.feedType);
  if (!isVideoFeedType(type) && type !== 'embed') return 'snapshot';
  return ['live', 'clip'].includes(camera?.playbackKind)
    ? camera.playbackKind
    : 'video';
}

export function cameraMediaLabel(camera) {
  return {
    live: 'Live video',
    clip: 'Video clip',
    video: 'Video (live status unknown)',
    snapshot: 'Snapshot',
  }[cameraMediaKind(camera)];
}

export function hasCctvVideoFrame(status) {
  return ['ready', 'playing', 'paused', 'ended', 'suspended'].includes(status);
}
