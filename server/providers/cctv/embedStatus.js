import { normalizeCctvEmbedUrl } from '../../../src/sources/cctvTypes.js';
import { readResponseTextCapped } from '../../../src/sources/httpBody.js';

/** Parse a public page's JSON object without executing its script or accepting HTML. */
export function parseCctvPlayerResponse(html) {
  if (typeof html !== 'string') return null;
  const match =
    /(?:\bytInitialPlayerResponse\s*=|window\["ytInitialPlayerResponse"\]\s*=)\s*\{/.exec(
      html,
    );
  if (!match) return null;
  const start = match.index + match[0].lastIndexOf('{');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index++) {
    const char = html[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, index + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function classify(payload, expectedId) {
  if (!payload || typeof payload !== 'object')
    return {
      status: 'unknown',
      message: 'The publisher’s current live status could not be read.',
    };
  const playability = payload.playabilityStatus;
  if (playability?.playableInEmbed === false)
    return {
      status: 'unavailable',
      message:
        'The publisher does not allow this broadcast to play inside other sites. Open the source page to watch.',
    };
  if (
    ['ERROR', 'LIVE_STREAM_OFFLINE', 'UNPLAYABLE'].includes(playability?.status)
  )
    return {
      status: 'unavailable',
      message:
        'The publisher is not currently making this broadcast available.',
    };
  // Public metadata requests may encounter bot/login checks even when a normal
  // browser can play the embedded broadcast. That is not camera-offline evidence.
  if (playability?.status !== 'OK')
    return {
      status: 'unknown',
      message:
        'The publisher’s live-status page could not confirm this broadcast.',
    };
  if (payload.videoDetails?.videoId !== expectedId)
    return {
      status: 'unknown',
      message: 'The publisher’s response could not be matched to this camera.',
    };
  const live =
    payload.microformat?.playerMicroformatRenderer?.liveBroadcastDetails
      ?.isLiveNow;
  if (
    live === false ||
    (live !== true && payload.videoDetails?.isLiveContent === false)
  )
    return {
      status: 'ended',
      message:
        'This broadcast is not live right now. Open the source page to check the publisher’s current broadcast.',
    };
  if (
    live === true &&
    playability?.status === 'OK' &&
    playability.playableInEmbed === true
  )
    return {
      status: 'live',
      message: 'The publisher currently identifies this broadcast as live.',
    };
  return {
    status: 'unknown',
    message: 'The publisher’s current live status could not be confirmed.',
  };
}

/** Check only the registered camera's canonical public watch page, with bounded work. */
export function createCctvEmbedStatus({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 8_000,
  maxBytes = 2 * 1024 * 1024,
  ttlMs = 60_000,
  maxEntries = 512,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const limit = Math.max(1, Math.min(512, Math.floor(maxEntries) || 512));
  function result(status, message) {
    return { status, checkedAt: new Date(now()).toISOString(), message };
  }
  async function check(videoId) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(
          result(
            'unknown',
            'The live-status check timed out. Playback may still be available.',
          ),
        );
      }, timeoutMs);
    });
    const request = (async () => {
      try {
        const response = await fetchImpl(
          `https://www.youtube.com/watch?v=${videoId}`,
          {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: { accept: 'text/html', 'accept-language': 'en' },
          },
        );
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return result('unknown', 'The live-status check timed out.');
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          return result(
            'unknown',
            'The publisher’s live-status page is temporarily unavailable.',
          );
        }
        const html = await readResponseTextCapped(
          response,
          maxBytes,
          controller.signal,
        );
        const { status, message } = classify(
          parseCctvPlayerResponse(html),
          videoId,
        );
        return result(status, message);
      } catch {
        return result(
          'unknown',
          'The publisher’s current live status could not be checked.',
        );
      }
    })();
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  return async function getEmbedStatus(source) {
    const normalized = normalizeCctvEmbedUrl(source?.embedUrl);
    if (!normalized)
      return result(
        'unavailable',
        'This camera does not have an approved official video embed.',
      );
    const videoId = normalized.slice(normalized.lastIndexOf('/') + 1);
    const cached = cache.get(videoId);
    if (cached && cached.expiresAt > now()) return { ...cached.value };
    if (cached) cache.delete(videoId);
    const pending = inFlight.get(videoId);
    if (pending) return { ...(await pending) };
    // Bound concurrent distinct IDs as well as settled cache entries.
    if (inFlight.size >= limit)
      return result(
        'unknown',
        'Live-status checks are busy. Playback may still be available.',
      );
    const promise = check(videoId)
      .then((value) => {
        if (!cache.has(videoId) && cache.size >= limit)
          cache.delete(cache.keys().next().value);
        cache.set(videoId, { value, expiresAt: now() + ttlMs });
        return value;
      })
      .finally(() => {
        if (inFlight.get(videoId) === promise) inFlight.delete(videoId);
      });
    inFlight.set(videoId, promise);
    return { ...(await promise) };
  };
}
