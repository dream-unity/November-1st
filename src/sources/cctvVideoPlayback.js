/** Own a camera video's loading, actual playback and teardown lifecycle. */
export function createCctvVideoPlayback({
  video,
  url,
  feedType,
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
  let sourceAttached = false;
  let wantsPlayback = autoPlay;
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
  function publish(status, message) {
    if (destroyed) return;
    state = status;
    onStatus({ status, message });
  }
  function unload() {
    sourceAttached = false;
    const player = hlsPlayer;
    hlsPlayer = null;
    player?.destroy();
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function fail(status, message) {
    clearTimer();
    clearPlayTimer();
    pendingPlay = null;
    generation++;
    unload();
    publish(status, message);
  }
  function armTimer() {
    if (timer || !active || destroyed) return;
    timer = setTimeout(() => {
      timer = null;
      fail(
        'unavailable',
        hls
          ? hlsHelp
          : 'Camera video timed out — retry or choose another camera',
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
    hlsPlayer?.startLoad?.(-1);
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
          );
        } else {
          fail(
            'unavailable',
            hls
              ? hlsHelp
              : 'Camera video could not play — retry or choose another camera',
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
    publish('playing', 'Camera video is playing.');
  }
  function paused() {
    if (destroyed || !active || !sourceAttached || !video.paused) return;
    wantsPlayback = false;
    hlsPlayer?.stopLoad?.();
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
    publish('loading', 'Camera video is buffering');
    armTimer();
  }
  function failed() {
    if (destroyed || !sourceAttached) return;
    const code = video.error?.code;
    fail(
      'unavailable',
      hls
        ? hlsHelp
        : code === 3 || code === 4
          ? 'Camera video format cannot be decoded by this browser'
          : 'Camera video connection failed — retry or choose another camera',
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
      hlsPlayer?.startLoad?.(-1);
      armPlayTimer(generation);
    },
    playing,
    pause: paused,
    ended: () => {
      if (destroyed || !sourceAttached) return;
      wantsPlayback = false;
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
    if (nativeSupported) {
      sourceAttached = true;
      video.src = url;
      video.load();
      return;
    }
    try {
      const Hls = await loadHls();
      if (destroyed || !active || attempt !== generation) return;
      if (!Hls?.isSupported?.()) {
        fail('unsupported', 'This browser cannot play HLS camera video');
        return;
      }
      hlsPlayer = new Hls({
        maxBufferLength: 20,
        backBufferLength: 10,
        manifestLoadingTimeOut: timeoutMs,
        manifestLoadingMaxRetry: 1,
        levelLoadingTimeOut: timeoutMs,
        levelLoadingMaxRetry: 1,
        fragLoadingTimeOut: timeoutMs,
        fragLoadingMaxRetry: 1,
      });
      const player = hlsPlayer;
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (destroyed || player !== hlsPlayer || !data?.fatal) return;
        fail('unavailable', hlsHelp);
      });
      sourceAttached = true;
      player.loadSource(url);
      player.attachMedia(video);
    } catch {
      if (destroyed || attempt !== generation) return;
      fail('unavailable', hlsHelp);
    }
  }
  function updateActive() {
    const next = requestedActive && !visibilityTarget?.hidden;
    if (destroyed || next === active) return;
    active = next;
    if (!active) {
      generation++;
      clearTimer();
      clearPlayTimer();
      pendingPlay = null;
      hlsPlayer?.stopLoad?.();
      video.pause();
      if (sourceAttached && wantsPlayback)
        publish('suspended', 'Camera video paused while hidden or inactive.');
    } else if (
      ['unavailable', 'unsupported'].includes(state) ||
      !sourceAttached
    ) {
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
      video.pause();
      paused();
    },
    retry() {
      if (
        destroyed ||
        !active ||
        !['unavailable', 'blocked', 'unsupported', 'ended'].includes(state)
      )
        return false;
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
