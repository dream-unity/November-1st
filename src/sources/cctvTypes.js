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
