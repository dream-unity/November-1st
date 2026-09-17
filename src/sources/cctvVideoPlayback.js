/** Own a camera video's loading, actual playback and teardown lifecycle. */
export function createCctvVideoPlayback({
  video,
  url,
  feedType,
  playbackKind = 'video',
  onStatus = () => {},
  timeoutMs = 20_000,
  autoPlay = true,
  initiallyActive = true,
  visibilityTarget,
  loadHls = () => import('hls.js').then((module) => module.default),
}) {
  let requestedActive = Boolean(initiallyActive);
  let active = requestedActive && !visibilityTarget?.hidden;
  let destroyed = false;
  let state = 'loading';
  let timer;
  let playTimer;
  let pendingPlay = null;
  let generation = 0;
  let hlsPlayer = null;
  let hlsLoadingStopped = false;
  let sourceAttached = false;
  let wantsPlayback = autoPlay;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let stableSince = null;
  let stableMediaTime = null;
  const recoverLive = playbackKind === 'live';
  const MAX_RECONNECTS = 3;
  const hls = feedType === 'hls';
  const nativeSupported =
    !hls ||
    Boolean(
      video.canPlayType?.('application/vnd.apple.mpegurl') ||
      video.canPlayType?.('application/x-mpegURL'),
    );
  const hlsHelp =
    'Camera stream could not load — retry or choose another camera';

  function clearTimer() {
    clearTimeout(timer);
    timer = null;
  }
  function clearPlayTimer() {
    clearTimeout(playTimer);
    playTimer = null;
  }
  function clearReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function resetStability() {
    stableSince = null;
    stableMediaTime = null;
  }
  function publish(status, message, reason) {
    if (destroyed) return;
    state = status;
    onStatus({ status, message, ...(reason ? { reason } : {}) });
  }
  function stopHlsLoading() {
    if (!hlsPlayer || hlsLoadingStopped) return;
    hlsLoadingStopped = true;
    hlsPlayer.stopLoad?.();
  }
  function startHlsLoading() {
    if (!hlsPlayer || !hlsLoadingStopped) return;
    hlsLoadingStopped = false;
    hlsPlayer.startLoad?.(-1);
  }
  function unload() {
    sourceAttached = false;
    const player = hlsPlayer;
    hlsPlayer = null;
    hlsLoadingStopped = false;
    player?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function fail(status, message, reason, transient = false) {
    clearTimer();
    clearPlayTimer();
    clearReconnect();
    resetStability();
    pendingPlay = null;
    generation++;
    unload();
    if (
      transient &&
      recoverLive &&
      active &&
      wantsPlayback &&
      reconnectAttempts < MAX_RECONNECTS
    ) {
      reconnectAttempts++;
      const attempt = generation;
      publish(
        'reconnecting',
        `Reconnecting live camera (${reconnectAttempts}/${MAX_RECONNECTS}). ${message}`,
        reason,
      );
      reconnectTimer = setTimeout(
        () => {
          reconnectTimer = null;
          if (!destroyed && active && wantsPlayback && attempt === generation)
            load();
        },
        1000 * 2 ** (reconnectAttempts - 1),
      );
      return;
    }
    publish(
      status,
      `${message}${transient && recoverLive && reconnectAttempts >= MAX_RECONNECTS ? ' Automatic reconnect limit reached. Press Retry video to try again.' : ''}`,
      reason,
    );
  }
  function armTimer() {
    if (timer || !active || destroyed) return;
    timer = setTimeout(() => {
      timer = null;
      fail(
        'unavailable',
        'Camera video timed out while loading or buffering — retry or choose another camera',
        'buffer-timeout',
        true,
      );
    }, timeoutMs);
  }
  function armPlayTimer(attempt) {
    if (playTimer) return;
    playTimer = setTimeout(() => {
      playTimer = null;
      if (destroyed || !active || attempt !== generation) return;
      fail(
        'unavailable',
        'Camera playback did not start — retry or choose another camera',
        'play-start-timeout',
        true,
      );
    }, timeoutMs);
  }
  function resume() {
    // Animation loops may call resume repeatedly. Never override a user's pause,
    // autoplay refusal, ended clip or an outstanding start request.
    if (
      destroyed ||
      !active ||
      pendingPlay ||
      playTimer ||
      state !== 'ready' ||
      !video.paused
    )
      return;
    wantsPlayback = true;
    const attempt = generation;
    startHlsLoading();
    armPlayTimer(attempt);
    let result;
    try {
      result = video.play();
    } catch (error) {
      result = Promise.reject(error);
    }
    const pending = Promise.resolve(result)
      .catch((error) => {
        if (destroyed || !active || attempt !== generation) return;
        if (error?.name === 'NotAllowedError') {
          clearTimer();
          clearPlayTimer();
          wantsPlayback = false;
          publish(
            'blocked',
            'Browser blocked automatic playback. Press Play video to start.',
            'autoplay-blocked',
          );
        } else {
          fail(
            'unavailable',
            hls
              ? hlsHelp
              : 'Camera video could not play — retry or choose another camera',
            error?.name === 'NotSupportedError'
              ? 'unsupported-format'
              : 'play-rejected',
          );
        }
      })
      .finally(() => {
        if (pendingPlay === pending) pendingPlay = null;
        if (destroyed || !active || (attempt !== generation && !wantsPlayback))
          video.pause();
      });
    pendingPlay = pending;
  }
  function ready() {
    if (destroyed || !sourceAttached) return;
    clearTimer();
    if (!['playing', 'paused', 'ended', 'blocked'].includes(state))
      publish('ready', 'Video is ready. Press Play video to watch.');
    if (!active) video.pause();
    else if (wantsPlayback) resume();
  }
  function playing() {
    if (destroyed || !sourceAttached) return;
    if (!active || !wantsPlayback) {
      video.pause();
      return;
    }
    clearTimer();
    clearPlayTimer();
    wantsPlayback = true;
    if (stableSince === null) {
      stableSince = Date.now();
      stableMediaTime = video.currentTime;
    }
    publish('playing', 'Camera video is playing.');
  }
  function paused() {
    if (destroyed || !active || !sourceAttached || !video.paused) return;
    wantsPlayback = false;
    clearReconnect();
    resetStability();
    stopHlsLoading();
    generation++;
    pendingPlay = null;
    clearTimer();
    clearPlayTimer();
    publish('paused', 'Camera video is paused.');
  }
  function waiting() {
    if (
      destroyed ||
      !active ||
      !sourceAttached ||
      (video.paused && !wantsPlayback)
    )
      return;
    resetStability();
    publish('loading', 'Camera video is buffering');
    armTimer();
  }
  function failed() {
    if (destroyed || !sourceAttached) return;
    const code = video.error?.code;
    fail(
      'unavailable',
      code === 3 || code === 4
        ? `Camera video cannot be decoded or supported by this browser (media error ${code}).`
        : `Camera video connection failed (media error ${code || 'unknown'}) — retry or choose another camera`,
      code === 2
        ? 'media-network-error'
        : code === 3
          ? 'media-decode-error'
          : code === 4
            ? 'media-unsupported'
            : 'media-error',
      code === 2,
    );
  }
  const listeners = {
    loadedmetadata: () => {
      if (!wantsPlayback) ready();
    },
    canplay: ready,
    play: () => {
      if (destroyed || !sourceAttached || !active) return;
      wantsPlayback = true;
      startHlsLoading();
      armPlayTimer(generation);
    },
    playing,
    timeupdate: () => {
      if (
        state !== 'playing' ||
        stableSince === null ||
        !active ||
        !wantsPlayback
      )
        return;
      // A seek or metadata event does not establish stability. Require both a
      // minute of uninterrupted playback and at least 30 seconds of media progress.
      if (
        Date.now() - stableSince >= 60_000 &&
        Number.isFinite(video.currentTime) &&
        Number.isFinite(stableMediaTime) &&
        video.currentTime - stableMediaTime >= 30
      )
        reconnectAttempts = 0;
    },
    pause: paused,
    ended: () => {
      if (destroyed || !sourceAttached) return;
      wantsPlayback = false;
      clearReconnect();
      resetStability();
      clearTimer();
      clearPlayTimer();
      publish(
        'ended',
        'Camera video ended. Press Play video to reconnect or replay.',
      );
    },
    waiting,
    stalled: waiting,
    error: failed,
  };
  for (const [event, listener] of Object.entries(listeners))
    video.addEventListener(event, listener);

  async function load() {
    const attempt = ++generation;
    pendingPlay = null;
    clearPlayTimer();
    publish(
      'loading',
      active
        ? 'Connecting to camera video'
        : 'Camera video paused while this tab is hidden',
    );
    if (!active) return;
    armTimer();
    const attachNative = () => {
      sourceAttached = true;
      video.src = url;
      video.load();
    };
    if (!hls) {
      attachNative();
      return;
    }
    try {
      const Hls = await loadHls();
      if (destroyed || !active || attempt !== generation) return;
      if (!Hls?.isSupported?.()) {
        if (nativeSupported) attachNative();
        else
          fail(
            'unsupported',
            'This browser cannot play HLS camera video',
            'hls-unsupported',
          );
        return;
      }
      hlsPlayer = new Hls({
        maxBufferLength: 20,
        backBufferLength: 10,
        // Public traffic playlists may contain only three short-lived segments.
        // Start close to the live edge instead of requesting already expired media.
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 3,
        maxLiveSyncPlaybackRate: 1.1,
        manifestLoadingTimeOut: timeoutMs,
        manifestLoadingMaxRetry: 1,
        levelLoadingTimeOut: timeoutMs,
        levelLoadingMaxRetry: 1,
        fragLoadingTimeOut: timeoutMs,
        fragLoadingMaxRetry: 1,
      });
      const player = hlsPlayer;
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (destroyed || player !== hlsPlayer) return;
        const code = Number(data?.response?.code);
        if (code === 410) {
          // Live-only admission rejects an ended archive with HTTP 410. Stop
          // before even hls.js's nonfatal retry can reopen the ended stream.
          wantsPlayback = false;
          fail(
            'ended',
            'This camera broadcast has ended. Archived playback is unavailable; retry later to check whether the live broadcast has resumed.',
            'broadcast-ended',
          );
          return;
        }
        if (!data?.fatal) return;
        const network = data.type === 'networkError';
        const transient =
          network &&
          [
            'fragLoadError',
            'fragLoadTimeOut',
            'levelLoadError',
            'levelLoadTimeOut',
            'manifestLoadError',
            'manifestLoadTimeOut',
            'keyLoadError',
            'keyLoadTimeOut',
            'audioTrackLoadError',
            'audioTrackLoadTimeOut',
          ].includes(data.details);
        const invalidManifest = [
          'manifestParsingError',
          'manifestIncompatibleCodecsError',
        ].includes(data.details);
        const request =
          {
            fragLoadError: 'fragment request',
            fragLoadTimeOut: 'fragment timeout',
            levelLoadError: 'playlist request',
            levelLoadTimeOut: 'playlist timeout',
            manifestLoadError: 'manifest request',
            manifestLoadTimeOut: 'manifest timeout',
          }[data.details] || 'stream request';
        const http =
          Number.isInteger(code) && code >= 100 && code <= 599
            ? `, HTTP ${code}`
            : '';
        fail(
          'unavailable',
          invalidManifest
            ? 'Camera playlist format or codecs are not supported.'
            : network
              ? `Camera ${request} failed${http}.`
              : 'Camera stream could not be decoded.',
          invalidManifest
            ? 'hls-format-error'
            : network
              ? 'hls-network-error'
              : 'hls-media-error',
          transient,
        );
      });
      sourceAttached = true;
      player.loadSource(url);
      player.attachMedia(video);
    } catch {
      if (destroyed || attempt !== generation) return;
      // A throwing attach/load operation may already own MediaSource listeners.
      // Release that partial session before native fallback attaches the same video.
      unload();
      if (nativeSupported) attachNative();
      else fail('unavailable', hlsHelp, 'hls-adapter-error');
    }
  }
  function updateActive() {
    const next = requestedActive && !visibilityTarget?.hidden;
    if (destroyed || next === active) return;
    active = next;
    if (!active) {
      const resumePending =
        sourceAttached || Boolean(reconnectTimer) || state === 'loading';
      generation++;
      clearTimer();
      clearPlayTimer();
      clearReconnect();
      resetStability();
      pendingPlay = null;
      stopHlsLoading();
      video.pause();
      if (wantsPlayback && resumePending)
        publish('suspended', 'Camera video paused while hidden or inactive.');
    } else if (!sourceAttached) {
      if (state === 'loading' || (state === 'suspended' && wantsPlayback))
        load();
    } else {
      if (wantsPlayback) {
        publish('ready', 'Resuming camera video');
        resume();
      } else if (state === 'loading') armTimer();
    }
  }
  const visibilityChange = () => updateActive();
  visibilityTarget?.addEventListener?.('visibilitychange', visibilityChange);
  load();
  return {
    resume,
    play() {
      if (destroyed || !active) return false;
      clearReconnect();
      reconnectAttempts = 0;
      wantsPlayback = true;
      if (
        ['unavailable', 'unsupported'].includes(state) ||
        !sourceAttached ||
        (state === 'ended' && hls)
      ) {
        unload();
        load();
      } else {
        if (state === 'ended' && !hls) video.currentTime = 0;
        publish('ready', 'Starting camera video');
        resume();
      }
      return true;
    },
    pause() {
      wantsPlayback = false;
      clearTimer();
      clearPlayTimer();
      pendingPlay = null;
      clearReconnect();
      resetStability();
      generation++;
      video.pause();
      paused();
      if (!sourceAttached) publish('paused', 'Camera video is paused.');
    },
    retry() {
      if (
        destroyed ||
        !active ||
        !['unavailable', 'blocked', 'unsupported', 'ended'].includes(state)
      )
        return false;
      clearReconnect();
      reconnectAttempts = 0;
      wantsPlayback = true;
      unload();
      load();
      return true;
    },
    setActive(next) {
      requestedActive = Boolean(next);
      updateActive();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      clearTimer();
      clearPlayTimer();
      clearReconnect();
      resetStability();
      pendingPlay = null;
      visibilityTarget?.removeEventListener?.(
        'visibilitychange',
        visibilityChange,
      );
      for (const [event, listener] of Object.entries(listeners))
        video.removeEventListener(event, listener);
      unload();
    },
  };
}
