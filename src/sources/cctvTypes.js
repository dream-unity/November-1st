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

/** Containers alone do not prove a source is live; only declared live sources do. */
export function cameraMediaKind(camera) {
  if (!isVideoFeedType(normalizeFeedType(camera?.feedType))) return 'snapshot';
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
