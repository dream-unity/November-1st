import {
  normalizeCctvEmbedUrl,
  cctvEmbedProvider,
} from '../../../src/sources/cctvTypes.js';
import {
  readResponseTextCapped,
  readResponseJsonCapped,
} from '../../../src/sources/httpBody.js';

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

/** Read only public player status scalars; never read tokens or media addresses. */
export function classifyIpcamLivePlayer(html, expectedAlias) {
  const unknown = {
    status: 'unknown',
    message: 'The publisher’s live camera status could not be confirmed.',
  };
  if (typeof html !== 'string') return unknown;
  const scalar = (expression) => {
    const matches = [...html.matchAll(expression)];
    return matches.length === 1 ? matches[0][1] : null;
  };
  const alias = scalar(/\bvar\s+alias\s*=\s*['"]([a-z0-9]+)['"]\s*;/g);
  const available = scalar(/\bvar\s+available\s*=\s*([01])\s*;/g);
  const domainLock = scalar(/\bvar\s+domainlockenabled\s*=\s*([01])\s*;/g);
  const serviceType = scalar(/\bvar\s+servicetype\s*=\s*['"]([BSPU])['"]\s*;/g);
  if (
    alias !== expectedAlias ||
    available === null ||
    domainLock === null ||
    serviceType === null
  )
    return unknown;
  if (serviceType === 'B')
    return {
      status: 'unavailable',
      message:
        'The publisher has not enabled external embedded playback for this camera. Open its source page.',
    };
  if (domainLock === '1')
    return {
      status: 'unavailable',
      message:
        'This camera restricts embedding to its publisher’s website. Open the source page to watch.',
    };
  if (available === '0')
    return {
      status: 'unavailable',
      message: 'The publisher currently reports this camera offline.',
    };
  const archiveFields = [
    'timelapseenabledoncamera',
    'timeshiftenabled',
    'storageenabledoncamera',
  ];
  for (const field of archiveFields) {
    const value = scalar(
      new RegExp(`params\\["${field}"\\]\\s*=\\s*([01])\\s*;`, 'g'),
    );
    if (value !== '0')
      return {
        status: 'unknown',
        message:
          'Live-only playback could not be confirmed without recorded or time-lapse views. Open the source page.',
      };
  }
  return {
    status: 'live',
    message:
      'The publisher currently reports this camera connected, with recorded and time-lapse views disabled.',
  };
}

/** Official videos.list metadata must establish an active public, embeddable broadcast. */
function classifyYouTubeDataApi(payload, expectedId, now) {
  const unknown = {
    status: 'unknown',
    message:
      'The official video API could not confirm this camera’s current live status.',
  };
  if (
    payload?.error ||
    !Array.isArray(payload?.items) ||
    payload.items.length !== 1
  )
    return unknown;
  const item = payload.items[0];
  if (item?.id !== expectedId) return unknown;
  const permissions = item.status;
  if (
    permissions?.embeddable === false ||
    ['private', 'unlisted'].includes(permissions?.privacyStatus)
  )
    return {
      status: 'unavailable',
      message:
        'The publisher does not currently allow this camera as a public embedded broadcast. Open the source page.',
    };
  if (
    permissions?.embeddable !== true ||
    permissions?.privacyStatus !== 'public'
  )
    return unknown;
  const details = item.liveStreamingDetails;
  const isoTime = (value) =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    Number.isFinite(Date.parse(value));
  if (
    item.snippet?.liveBroadcastContent === 'none' ||
    isoTime(details?.actualEndTime)
  )
    return {
      status: 'ended',
      message:
        'The official video API reports this broadcast is not live now. Archived playback is unavailable in live-only mode.',
    };
  if (item.snippet?.liveBroadcastContent === 'upcoming')
    return {
      status: 'unavailable',
      message:
        'The publisher has scheduled this broadcast, but it has not started yet.',
    };
  if (
    item.snippet?.liveBroadcastContent !== 'live' ||
    !details ||
    !isoTime(details.actualStartTime) ||
    Date.parse(details.actualStartTime) > now ||
    Object.hasOwn(details, 'actualEndTime')
  )
    return unknown;
  return {
    status: 'live',
    message:
      'The official video API currently identifies this public, embeddable camera broadcast as live.',
  };
}

/** Registered public players, with an optional official API fallback within one deadline. */
export function createCctvEmbedStatus({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 8_000,
  maxBytes = 2 * 1024 * 1024,
  ttlMs = 60_000,
  maxEntries = 512,
  youtubeApiKey = process.env.YOUTUBE_API_KEY,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  const limit = Math.max(1, Math.min(512, Math.floor(maxEntries) || 512));
  const apiKey = typeof youtubeApiKey === 'string' ? youtubeApiKey.trim() : '';
  const canUseDataApi =
    apiKey.length > 0 &&
    apiKey.length <= 512 &&
    !/[\s\u0000-\u001f\u007f]/.test(apiKey);
  function result(status, message) {
    return { status, checkedAt: new Date(now()).toISOString(), message };
  }
  async function check(identity, provider) {
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
    const publicRequest = (async () => {
      try {
        const response = await fetchImpl(
          provider === 'ipcamlive'
            ? identity
            : `https://www.youtube.com/watch?v=${identity}`,
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
        const { status, message } =
          provider === 'ipcamlive'
            ? classifyIpcamLivePlayer(
                html,
                new URL(identity).searchParams.get('alias'),
              )
            : classify(parseCctvPlayerResponse(html), identity);
        return result(status, message);
      } catch {
        return result(
          'unknown',
          'The publisher’s current live status could not be checked.',
        );
      }
    })();
    const request = publicRequest.then(async (value) => {
      // Never override explicit offline/ended/embedding-denied evidence. No
      // other provider credential is reused, and keyless behavior is unchanged.
      if (
        provider !== 'youtube' ||
        value.status !== 'unknown' ||
        !canUseDataApi ||
        controller.signal.aborted
      )
        return value;
      try {
        const url = new URL('https://www.googleapis.com/youtube/v3/videos');
        url.searchParams.set('id', identity);
        url.searchParams.set('part', 'snippet,liveStreamingDetails,status');
        url.searchParams.set(
          'fields',
          'items(id,snippet/liveBroadcastContent,liveStreamingDetails(actualStartTime,actualEndTime),status(privacyStatus,embeddable))',
        );
        const response = await fetchImpl(url.href, {
          method: 'GET',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          // Keep the server key out of URLs, returned data, and error messages.
          headers: { accept: 'application/json', 'x-goog-api-key': apiKey },
        });
        if (!response.ok || controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return result(
            'unknown',
            'The official video API is temporarily unavailable. Live status remains unconfirmed.',
          );
        }
        const payload = await readResponseJsonCapped(
          response,
          Math.min(maxBytes, 64 * 1024),
          controller.signal,
        );
        const classified = classifyYouTubeDataApi(payload, identity, now());
        return result(classified.status, classified.message);
      } catch {
        // Provider errors can contain request details. Never forward or log them.
        return result(
          'unknown',
          'The official video API could not confirm this camera’s live status.',
        );
      }
    });
    try {
      return await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  return async function getEmbedStatus(source) {
    const normalized = normalizeCctvEmbedUrl(source?.embedUrl);
    if (!normalized)
      return result(
        'unavailable',
        'This camera does not have an approved official video embed.',
      );
    const provider = cctvEmbedProvider(normalized);
    const videoId =
      provider === 'ipcamlive'
        ? normalized
        : normalized.slice(normalized.lastIndexOf('/') + 1);
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
    const promise = check(videoId, provider)
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
