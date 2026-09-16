/** Own a camera video's finite loading, playback and teardown lifecycle. */
export function createCctvVideoPlayback({
  video,
  url,
  feedType,
  onStatus = () => {},
  timeoutMs = 20_000,
}) {
  let active = true;
  let destroyed = false;
  let state = 'loading';
  let timer;
  let pendingPlay = null;
  let generation = 0;
  const hls = feedType === 'hls';
  const supported =
    !hls ||
    Boolean(
      video.canPlayType?.('application/vnd.apple.mpegurl') ||
      video.canPlayType?.('application/x-mpegURL'),
    );
  const hlsHelp = 'HLS failed — check the feed and playlist segment relay';

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
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  function fail(status, message) {
    clearTimer();
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
        if (pendingPlay === pending) pendingPlay = null;
        if (destroyed || !active) video.pause();
      });
    pendingPlay = pending;
  }
  function ready() {
    if (destroyed || !video.getAttribute('src')) return;
    clearTimer();
    publish('ready', '');
    if (!active) video.pause();
    resume();
  }
  function waiting() {
    if (destroyed || !active || !video.getAttribute('src')) return;
    publish('loading', 'Camera video is buffering');
    armTimer();
  }
  function failed() {
    if (destroyed || !video.getAttribute('src')) return;
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
    canplay: ready,
    playing: ready,
    waiting,
    stalled: waiting,
    error: failed,
  };
  for (const [event, listener] of Object.entries(listeners))
    video.addEventListener(event, listener);

  function load() {
    if (!supported) {
      publish('unsupported', 'This browser cannot play HLS camera video');
      return;
    }
    generation++;
    publish('loading', 'Loading camera video');
    armTimer();
    video.src = url;
    video.load();
  }
  load();
  return {
    resume,
    retry() {
      if (destroyed || !active || !['unavailable', 'blocked'].includes(state))
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
        video.pause();
      } else if (state === 'unavailable' || state === 'blocked') {
        load();
      } else {
        if (state === 'loading') armTimer();
        resume();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      clearTimer();
      for (const [event, listener] of Object.entries(listeners))
        video.removeEventListener(event, listener);
      unload();
    },
  };
}
