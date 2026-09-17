/** Own a camera video's finite loading, playback and teardown lifecycle. */
export function createCctvVideoPlayback({
  video,
  url,
  feedType,
  onStatus = () => {},
  timeoutMs = 20_000,
  autoPlay = true,
  loadHls = () => import('hls.js').then((module) => module.default),
}) {
  let active = true;
  let destroyed = false;
  let state = 'loading';
  let timer;
  let playTimer;
  let pendingPlay = null;
  let generation = 0;
  let hlsPlayer = null;
  let sourceAttached = false;
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
    clearTimeout(playTimer);
    playTimer = null;
    pendingPlay = null;
    generation++;
    publish(status, message);
    // Bound a hung connection and keep a failed video out of Cesium's texture
    // path. The operator can retry by selecting this camera again.
    unload();
  }
  function armTimer() {
    if (timer || !active || destroyed) return;
    timer = setTimeout(() => {
      timer = null;
      fail(
        'unavailable',
        hls ? hlsHelp : 'Camera video timed out — select again to retry',
      );
    }, timeoutMs);
  }
  function resume() {
    if (
      destroyed ||
      !active ||
      pendingPlay ||
      state !== 'ready' ||
      !video.paused
    )
      return;
    const attempt = generation;
    playTimer = setTimeout(() => {
      if (destroyed || !active || attempt !== generation) return;
      fail(
        'unavailable',
        'Camera playback did not start — select again to retry',
      );
    }, timeoutMs);
    const pending = Promise.resolve()
      .then(() => {
        if (destroyed || !active || attempt !== generation) return;
        return video.play();
      })
      .catch((error) => {
        if (destroyed || !active || attempt !== generation) return;
        fail(
          error?.name === 'NotAllowedError' ? 'blocked' : 'unavailable',
          error?.name === 'NotAllowedError'
            ? 'Browser blocked playback — select the camera again'
            : hls
              ? hlsHelp
              : 'Camera video could not play — select again to retry',
        );
      })
      .finally(() => {
        if (pendingPlay === pending) {
          clearTimeout(playTimer);
          playTimer = null;
          pendingPlay = null;
        }
        if (destroyed || !active) video.pause();
      });
    pendingPlay = pending;
  }
  function ready() {
    if (destroyed || !sourceAttached) return;
    clearTimer();
    publish('ready', '');
    if (!active) video.pause();
    if (autoPlay) resume();
  }
  function waiting() {
    if (destroyed || !active || !sourceAttached) return;
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
          : 'Camera video connection failed — select again to retry',
    );
  }
  const listeners = {
    // Native controls may intentionally preload only metadata until a user
    // presses Play. That pause is not a stalled camera connection.
    loadedmetadata: () => {
      if (!autoPlay) ready();
    },
    canplay: ready,
    playing: ready,
    waiting,
    stalled: waiting,
    error: failed,
  };
  for (const [event, listener] of Object.entries(listeners))
    video.addEventListener(event, listener);

  async function load() {
    const attempt = ++generation;
    pendingPlay = null;
    clearTimeout(playTimer);
    playTimer = null;
    publish('loading', 'Loading camera video');
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
  load();
  return {
    resume,
    retry() {
      if (
        destroyed ||
        !active ||
        !['unavailable', 'blocked', 'unsupported'].includes(state)
      )
        return false;
      load();
      return true;
    },
    setActive(next) {
      if (destroyed || Boolean(next) === active) return;
      active = Boolean(next);
      if (!active) {
        generation++;
        clearTimer();
        clearTimeout(playTimer);
        playTimer = null;
        pendingPlay = null;
        hlsPlayer?.stopLoad?.();
        video.pause();
      } else if (
        state === 'unavailable' ||
        state === 'blocked' ||
        (!sourceAttached && state === 'loading')
      ) {
        load();
      } else {
        hlsPlayer?.startLoad?.(-1);
        if (state === 'loading') armTimer();
        if (autoPlay) resume();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      clearTimer();
      clearTimeout(playTimer);
      playTimer = null;
      pendingPlay = null;
      for (const [event, listener] of Object.entries(listeners))
        video.removeEventListener(event, listener);
      unload();
    },
  };
}
