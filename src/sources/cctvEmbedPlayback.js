import { normalizeCctvEmbedUrl, cctvEmbedProvider } from './cctvTypes.js';
import { readResponseJsonCapped } from './httpBody.js';

const apiLoads = new WeakMap();
let nextPlayerId = 0;

/** Load the official API once per ownerDocument; a failed request can be retried. */
export function loadCctvYouTubeApi(
  ownerDocument,
  ownerWindow,
  timeoutMs = 20_000,
) {
  if (typeof ownerWindow?.YT?.Player === 'function')
    return Promise.resolve(ownerWindow.YT);
  const pending = apiLoads.get(ownerDocument);
  if (pending) return pending;

  const request = new Promise((resolve, reject) => {
    const script = ownerDocument.createElement('script');
    const previousReady = ownerWindow.onYouTubeIframeAPIReady;
    let timer;
    let settled = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.onerror = null;
      if (ownerWindow.onYouTubeIframeAPIReady === ready)
        ownerWindow.onYouTubeIframeAPIReady = previousReady;
      if (error) {
        script.remove();
        reject(error);
      } else resolve(ownerWindow.YT);
    }
    function ready() {
      try {
        if (typeof previousReady === 'function')
          previousReady.call(ownerWindow);
      } catch {
        // An unrelated subscriber must not break this camera's API lifecycle.
      }
      finish(
        typeof ownerWindow.YT?.Player === 'function'
          ? null
          : new Error('The official video player API is unavailable.'),
      );
    }
    ownerWindow.onYouTubeIframeAPIReady = ready;
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.onerror = () =>
      finish(new Error('The official video player could not load.'));
    timer = setTimeout(
      () => finish(new Error('The official video player timed out.')),
      timeoutMs,
    );
    try {
      (ownerDocument.head || ownerDocument.body).appendChild(script);
    } catch (error) {
      finish(error);
    }
  });
  apiLoads.set(ownerDocument, request);
  void request.catch(() => {
    if (apiLoads.get(ownerDocument) === request) apiLoads.delete(ownerDocument);
  });
  return request;
}

function playerUrl(embedUrl, origin, autoPlay = false) {
  const normalized = normalizeCctvEmbedUrl(embedUrl);
  if (!normalized)
    throw new Error('This camera does not have an approved video embed URL.');
  const url = new URL(normalized);
  const page = new URL(origin);
  if (!['https:', 'http:'].includes(page.protocol) || page.origin !== origin)
    throw new Error('The video player requires an HTTP or HTTPS page origin.');
  if (cctvEmbedProvider(normalized) === 'ipcamlive') {
    // Owner player remains responsible for media delivery and permission.
    // Never expose its optional recording/time-lapse views in live-only mode.
    for (const key of [
      'mute',
      'disabletimelapseplayer',
      'disablestorageplayer',
      'disableframecapture',
      'disabledownloadbutton',
      'disableautofullscreen',
      'disableuserpause',
      'disablezoombutton',
    ])
      url.searchParams.set(key, '1');
    url.searchParams.set('autoplay', autoPlay ? '1' : '0');
    return url.href;
  }
  url.search = new URLSearchParams({
    enablejsapi: '1',
    origin,
    playsinline: '1',
    controls: '1',
    autoplay: '0',
    loop: '0',
  }).toString();
  return url.href;
}

function errorMessage(code) {
  switch (code) {
    case 2:
      return 'The camera publisher supplied an invalid video identifier.';
    case 5:
      return 'This camera video cannot be played by this browser.';
    case 100:
      return 'This camera broadcast was removed or made private by its publisher.';
    case 101:
    case 150:
      return 'The camera publisher does not allow embedded playback. Open the source page to watch.';
    case 153:
      return 'The video provider could not identify this site. A browser privacy setting may be blocking the required referrer. Open the source page to watch.';
    default:
      return 'The camera broadcast could not play. Retry or open the source page.';
  }
}

/** Official embeds retain the publisher's controls; only API events prove playback. */
export function createCctvEmbedPlayback({
  container,
  embedUrl,
  title = 'Public camera video',
  playbackKind = 'video',
  visibilityTarget = container?.ownerDocument,
  initiallyActive = true,
  autoPlay = true,
  onStatus = () => {},
  timeoutMs = 20_000,
  statusUrl,
  requireLiveStatus = false,
  fetchImpl = globalThis.fetch,
  statusTimeoutMs = 8_000,
  statusRecheckMs = 60_000,
  loadApi,
}) {
  const ownerDocument = container?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  const provider = cctvEmbedProvider(embedUrl);
  const strictLive = requireLiveStatus || provider === 'ipcamlive';
  let requestedActive = Boolean(initiallyActive);
  let active = requestedActive && !visibilityTarget?.hidden;
  let destroyed = false;
  let wantsPlayback = Boolean(autoPlay);
  let player = null;
  let iframe = null;
  let playerReady = false;
  let generation = 0;
  let timer = null;
  let statusTimer = null;
  let state = 'loading';
  let liveStatus = 'unknown';
  let statusController = null;
  let observedEnded = false;
  let lastStatusCheckedAt = null;
  let endedStatusCheckedAt = null;

  function publish(status, message, reason) {
    if (destroyed) return;
    state = status;
    onStatus({ status, message, liveStatus, ...(reason ? { reason } : {}) });
  }
  function clearTimer() {
    clearTimeout(timer);
    timer = null;
  }
  function unload() {
    generation++;
    clearTimer();
    clearTimeout(statusTimer);
    statusTimer = null;
    statusController?.abort();
    statusController = null;
    const oldPlayer = player;
    const oldIframe = iframe;
    player = null;
    iframe = null;
    playerReady = false;
    try {
      oldPlayer?.destroy();
    } catch {
      // Removing the owned iframe still terminates its media session.
    }
    oldIframe?.remove();
  }
  function fail(message, reason) {
    unload();
    wantsPlayback = false;
    publish('unavailable', message, reason);
  }
  function armTimer(attempt, reason = 'video-timeout') {
    if (timer || destroyed || !active) return;
    timer = setTimeout(() => {
      timer = null;
      if (destroyed || !active || generation !== attempt) return;
      fail(
        'The camera video timed out. Retry or open the source page to check this broadcast.',
        reason,
      );
    }, timeoutMs);
  }
  function current(attempt) {
    return !destroyed && active && generation === attempt;
  }
  async function checkLiveStatus() {
    const unknown = {
      status: 'unknown',
      message: 'The publisher’s current live status could not be confirmed.',
    };
    let url;
    try {
      url = new URL(statusUrl, ownerWindow.location.origin);
      if (
        url.origin !== ownerWindow.location.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/api\/cctv\/embed-status\/[^/]+$/.test(url.pathname)
      )
        return unknown;
    } catch {
      return unknown;
    }
    const controller = new AbortController();
    statusController = controller;
    let deadline;
    const timeout = new Promise((resolve) => {
      deadline = setTimeout(() => {
        controller.abort();
        resolve(unknown);
      }, statusTimeoutMs);
    });
    const cancelled = new Promise((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(unknown), {
        once: true,
      });
    });
    const request = (async () => {
      try {
        const response = await fetchImpl(url.href, {
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
          headers: { accept: 'application/json' },
        });
        if (!response.ok || controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return unknown;
        }
        const value = await readResponseJsonCapped(
          response,
          8192,
          controller.signal,
        );
        if (
          !['live', 'ended', 'unavailable', 'unknown'].includes(value?.status)
        )
          return unknown;
        return {
          status: value.status,
          checkedAt:
            typeof value.checkedAt === 'string'
              ? Date.parse(value.checkedAt)
              : NaN,
          message:
            typeof value.message === 'string'
              ? value.message.slice(0, 500)
              : unknown.message,
        };
      } catch {
        return unknown;
      }
    })();
    try {
      return await Promise.race([request, timeout, cancelled]);
    } finally {
      clearTimeout(deadline);
      if (statusController === controller) statusController = null;
    }
  }
  function schedulePublicRecheck(attempt) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(
      async () => {
        statusTimer = null;
        if (!current(attempt)) return;
        const checked = await checkLiveStatus();
        if (!current(attempt)) return;
        liveStatus = checked.status;
        if (!(
          checked.status === 'live' && Number.isFinite(checked.checkedAt)
        )) {
          fail(
            checked.message ||
              'The publisher’s current live status could not be confirmed. Retry later.',
            'live-status-unconfirmed',
          );
          return;
        }
        lastStatusCheckedAt = checked.checkedAt;
        schedulePublicRecheck(attempt);
      },
      Math.max(1_000, statusRecheckMs),
    );
  }
  function requestPlay() {
    if (!playerReady || !player || !active || destroyed) return;
    armTimer(generation, 'play-start-timeout');
    try {
      player.playVideo();
    } catch {
      fail(
        'The camera video could not start. Retry or open the source page.',
        'play-rejected',
      );
    }
  }
  function load() {
    if (destroyed || !active) return false;
    unload();
    liveStatus = 'unknown';
    const attempt = generation;
    let url;
    try {
      if (!container || !ownerDocument || !ownerWindow)
        throw new Error('The camera video requires a browser.');
      url = playerUrl(embedUrl, ownerWindow.location.origin, wantsPlayback);
    } catch (error) {
      fail(error.message, 'invalid-embed');
      return false;
    }
    publish('loading', 'Connecting to the camera publisher’s video player.');
    armTimer(attempt, 'player-load-timeout');
    Promise.resolve()
      .then(async () => {
        if (!current(attempt)) return null;
        if (statusUrl) {
          publish(
            'loading',
            'Checking whether the publisher’s broadcast is live.',
          );
          const checked = await checkLiveStatus();
          if (!current(attempt)) return null;
          liveStatus = checked.status;
          if (
            observedEnded &&
            !(
              checked.status === 'live' &&
              Number.isFinite(checked.checkedAt) &&
              endedStatusCheckedAt !== null &&
              checked.checkedAt > endedStatusCheckedAt
            )
          ) {
            // Use server proof times so an inaccurate device clock cannot
            // permanently prevent recovery. Missing initial timestamps need a
            // baseline followed by a strictly newer proof before reopening.
            if (
              endedStatusCheckedAt === null &&
              Number.isFinite(checked.checkedAt)
            )
              endedStatusCheckedAt = checked.checkedAt;
            unload();
            wantsPlayback = false;
            liveStatus = 'ended';
            publish(
              'ended',
              'This broadcast ended. Try again later or open the source page; a fresh live-status check is required before replay.',
              'broadcast-ended-awaiting-fresh-status',
            );
            return null;
          }
          if (
            strictLive &&
            !['ended', 'unavailable'].includes(checked.status) &&
            !(checked.status === 'live' && Number.isFinite(checked.checkedAt))
          ) {
            liveStatus = 'unknown';
            fail(
              'Live-only camera playback is paused because the publisher’s current live status could not be confirmed. Retry later or open the source page.',
              'live-status-unconfirmed',
            );
            return null;
          }
          if (Number.isFinite(checked.checkedAt))
            lastStatusCheckedAt = checked.checkedAt;
          if (observedEnded) {
            observedEnded = false;
            endedStatusCheckedAt = null;
          }
          if (['ended', 'unavailable'].includes(checked.status)) {
            unload();
            wantsPlayback = false;
            publish(checked.status, checked.message, 'broadcast-not-live');
            return null;
          }
          publish(
            'loading',
            liveStatus === 'live'
              ? 'Connecting to the live camera’s official player.'
              : 'Live status is unconfirmed. Connecting to the publisher’s video player.',
          );
          clearTimer();
          armTimer(attempt, 'player-load-timeout');
        } else if (observedEnded) {
          unload();
          wantsPlayback = false;
          liveStatus = 'ended';
          publish(
            'ended',
            'This broadcast ended. Open the source page to check the publisher’s current broadcast.',
            'broadcast-ended-awaiting-fresh-status',
          );
          return null;
        } else if (strictLive) {
          fail(
            'Live-only camera playback requires a current live-status check. This camera has no available verification endpoint.',
            'live-status-unconfirmed',
          );
          return null;
        }
        if (provider === 'ipcamlive') return { publicPlayer: true };
        return loadApi
          ? loadApi()
          : loadCctvYouTubeApi(ownerDocument, ownerWindow, timeoutMs);
      })
      .then((YT) => {
        if (!current(attempt)) return;
        iframe = ownerDocument.createElement('iframe');
        iframe.id = `cctv-official-video-${++nextPlayerId}`;
        iframe.title = title;
        iframe.src = url;
        iframe.width = '100%';
        iframe.height = '100%';
        iframe.allow =
          'autoplay; encrypted-media; picture-in-picture; fullscreen';
        iframe.allowFullscreen = true;
        // YouTube error 153 requires a real referrer/client identity.
        iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.setAttribute('frameborder', '0');
        if (provider === 'ipcamlive') {
          iframe.addEventListener('load', () => {
            if (!current(attempt)) return;
            clearTimer();
            // A cross-origin frame's load event does not prove decoded video.
            // This provider has no public playback-event API; keep that limit
            // explicit instead of inventing a playing event.
            publish(
              'ready',
              'The publisher reports this camera live. Its official player is open; use the video controls to watch. Playback status is shown inside that player.',
              'provider-controls',
            );
            schedulePublicRecheck(attempt);
          });
          iframe.addEventListener('error', () => {
            if (current(attempt))
              fail(
                'The official camera player could not load. Retry or open the source page.',
                'player-load-error',
              );
          });
          container.appendChild(iframe);
          return;
        }
        container.appendChild(iframe);
        player = new YT.Player(iframe, {
          events: {
            onReady(event) {
              if (!current(attempt)) return;
              player = event.target;
              playerReady = true;
              clearTimer();
              // Muted start works on mobile; the publisher's controls enable sound.
              player.mute();
              publish(
                'ready',
                'Video player is ready. Press Play video to watch.',
              );
              if (wantsPlayback) requestPlay();
            },
            onStateChange(event) {
              if (!current(attempt)) return;
              if (event.data === 1) {
                clearTimer();
                wantsPlayback = true;
                publish(
                  'playing',
                  playbackKind === 'live' && liveStatus !== 'live'
                    ? 'Stream playing · live status unconfirmed.'
                    : 'Camera video is playing.',
                );
              } else if (event.data === 2) {
                clearTimer();
                wantsPlayback = false;
                publish('paused', 'Camera video is paused.');
              } else if (event.data === 0) {
                // An ended live player can otherwise expose native Replay and
                // replay an archive without another current-status check.
                unload();
                wantsPlayback = false;
                liveStatus = 'ended';
                if (playbackKind === 'live') {
                  observedEnded = true;
                  endedStatusCheckedAt = lastStatusCheckedAt;
                }
                publish(
                  'ended',
                  playbackKind === 'live'
                    ? 'This broadcast has ended. Retry to check whether the publisher has resumed it.'
                    : 'The camera video has ended.',
                );
              } else if (event.data === 3) {
                publish('loading', 'Camera video is buffering.');
                armTimer(attempt, 'buffer-timeout');
              } else if (event.data === 5 && !wantsPlayback) {
                clearTimer();
                publish(
                  'ready',
                  'Video player is ready. Press Play video to watch.',
                );
              }
            },
            onAutoplayBlocked() {
              if (!current(attempt)) return;
              clearTimer();
              wantsPlayback = false;
              publish(
                'blocked',
                'Browser blocked automatic playback. Press Play video or use the player’s Play button.',
                'autoplay-blocked',
              );
            },
            onError(event) {
              if (!current(attempt)) return;
              fail(errorMessage(event.data), `youtube-${event.data}`);
            },
          },
        });
      })
      .catch((error) => {
        if (!current(attempt)) return;
        fail(
          `${error?.message || 'The official video player could not load.'} Retry or open the source page.`,
          'player-load-error',
        );
      });
    return true;
  }
  function play() {
    if (destroyed || !active) return false;
    wantsPlayback = true;
    if (!player || state === 'ended') return load();
    if (playerReady) requestPlay();
    return true;
  }
  function pause() {
    if (destroyed) return false;
    wantsPlayback = false;
    // Removing the iframe guarantees a paused camera cannot keep downloading.
    unload();
    publish('paused', 'Camera video is paused.');
    return true;
  }
  function syncActive() {
    const next = requestedActive && !visibilityTarget?.hidden;
    if (destroyed || next === active) return;
    active = next;
    if (!active) {
      unload();
      publish(
        'suspended',
        'Camera video is stopped while this view is hidden.',
      );
    } else if (wantsPlayback) load();
    else
      publish('paused', 'Camera video is paused. Press Play video to watch.');
  }
  visibilityTarget?.addEventListener?.('visibilitychange', syncActive);
  if (active) load();
  else
    publish('suspended', 'Camera video is stopped while this view is hidden.');

  return {
    play,
    pause,
    retry() {
      if (destroyed || !active) return false;
      wantsPlayback = true;
      return load();
    },
    setActive(value) {
      requestedActive = Boolean(value);
      syncActive();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      wantsPlayback = false;
      visibilityTarget?.removeEventListener?.('visibilitychange', syncActive);
      unload();
    },
    get state() {
      return state;
    },
  };
}
