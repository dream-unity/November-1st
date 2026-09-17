import { createCctvVideoPlayback } from '../sources/cctvVideoPlayback.js';
import {
  isVideoFeedType,
  cameraMediaKind,
  cameraMediaLabel,
  hasCctvVideoFrame,
} from '../sources/cctvTypes.js';

/** Keep the panel's video playable without depending on a 3D monitor plane. */
export function _syncCctvVideo(activeCamera, enabled) {
  if (!enabled || !activeCamera || !isVideoFeedType(activeCamera.feedType)) {
    this._clearCctvVideo();
    return false;
  }
  const panelVisible = () =>
    !this._cctvPanel?.hidden &&
    !this._cctvPanel?.classList?.contains('collapsed');
  if (this._cctvVideoCameraId === activeCamera.id) {
    this._cctvPlayback?.setActive(panelVisible());
    return true;
  }
  this._clearCctvFrame();
  this._clearCctvVideo();
  const video = document.createElement('video');
  video.className = 'cctv-video';
  video.controls = true;
  video.muted = true;
  video.loop = false;
  video.preload = 'auto';
  video.playsInline = true;
  video.setAttribute(
    'aria-label',
    `${activeCamera.name || 'CCTV'} camera video`,
  );
  this._cctvVideoCameraId = activeCamera.id;
  this._cctvVideo = video;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Play / retry camera video';
  retry.hidden = true;
  retry.onclick = () => this._cctvPlayback?.play();
  this._cctvVideoRetry = retry;
  this._cctvFrameWrap?.appendChild(video);
  this._cctvFrameWrap?.appendChild(retry);
  this._cctvPlayback = createCctvVideoPlayback({
    visibilityTarget: document,
    initiallyActive: panelVisible(),
    video,
    url: activeCamera.mediaUrl,
    feedType: activeCamera.feedType,
    autoPlay: cameraMediaKind(activeCamera) === 'live',
    onStatus: (status) => {
      if (this.destroyed || this._cctvVideo !== video) return;
      this._cctvVideoStatus = status;
      retry.hidden = ![
        'blocked',
        'unavailable',
        'unsupported',
        'ended',
      ].includes(status.status);
      this._cctvFrameWrap?.classList.toggle(
        'loading',
        status.status === 'loading',
      );
      this._cctvFrameWrap?.classList.toggle(
        'has-frame',
        hasCctvVideoFrame(status.status),
      );
      this._syncCctvSourceBadge(activeCamera, true);
    },
  });
  if (this._cctvPanel && typeof MutationObserver !== 'undefined') {
    this._cctvVideoObserver = new MutationObserver(() => {
      if (!this.destroyed && this._cctvVideo === video)
        this._cctvPlayback?.setActive(panelVisible());
    });
    this._cctvVideoObserver.observe(this._cctvPanel, {
      attributes: true,
      attributeFilter: ['class', 'hidden'],
    });
  }
  return true;
}

export function _clearCctvVideo() {
  this._cctvVideoObserver?.disconnect();
  this._cctvVideoObserver = null;
  this._cctvPlayback?.destroy();
  this._cctvPlayback = null;
  this._cctvVideoRetry?.remove();
  this._cctvVideoRetry = null;
  this._cctvVideo?.remove();
  this._cctvVideo = null;
  this._cctvVideoCameraId = null;
  this._cctvVideoStatus = null;
}

export function _clearCctvFrame() {
  clearTimeout(this._cctvFrameTimeout);
  this._cctvFrameTimeout = null;
  this._cctvFrameRequestToken += 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
    this._cctvFramePreloader.removeAttribute?.('src');
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
    this._cctvFramePreloader.removeAttribute?.('src');
  }
  clearTimeout(this._cctvFrameTimeout);
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  this._cctvFrameTimeout = setTimeout(() => {
    this._settleCctvFrame(token, src, false);
    preloader.removeAttribute?.('src');
  }, 20_000);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  this._cctvFrameRequestToken += 1;
  clearTimeout(this._cctvFrameTimeout);
  this._cctvFrameTimeout = null;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  if (this._cctvVideoStatus) {
    const { status, message } = this._cctvVideoStatus;
    this._cctvSourceBadge.textContent =
      status === 'playing'
        ? `${cameraMediaLabel(activeCamera).toUpperCase()} · PLAYING`
        : status === 'ready'
          ? `${cameraMediaLabel(activeCamera).toUpperCase()} · READY — USE PLAY CONTROLS`
          : message || 'CAMERA VIDEO · UNAVAILABLE';
    this._cctvSourceBadge.dataset.frameState = hasCctvVideoFrame(status)
      ? 'ready'
      : status === 'loading'
        ? 'loading'
        : 'error';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  if (this._cctvFrame?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · LOADING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (this._cctvFrame?.dataset.error === 'true') {
    this._cctvSourceBadge.textContent = hasDisplayedFrame
      ? 'SNAPSHOT · REFRESH FAILED — PREVIOUS FRAME'
      : 'FRAME · UNAVAILABLE — TRY ANOTHER CAMERA';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  if (hasDisplayedFrame) {
    this._cctvSourceBadge.textContent =
      this._cctvFrame?.dataset.loading === 'true'
        ? 'CAMERA SNAPSHOT · REFRESHING'
        : 'CAMERA SNAPSHOT · RECEIVED';
    this._cctvSourceBadge.dataset.frameState = 'ready';
    return;
  }
  const kind = String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
