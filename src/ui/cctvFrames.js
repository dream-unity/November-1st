import { createCctvVideoPlayback } from '../sources/cctvVideoPlayback.js';
import { createCctvEmbedPlayback } from '../sources/cctvEmbedPlayback.js';
import {
  isVideoFeedType,
  cameraMediaKind,
  cameraMediaLabel,
  hasCctvVideoFrame,
} from '../sources/cctvTypes.js';

/** Keep the panel's video playable without depending on a 3D monitor plane. */
export function _syncCctvVideo(activeCamera, enabled) {
  const embedded = activeCamera?.feedType === 'embed';
  if (
    !enabled ||
    !activeCamera ||
    (!embedded && !isVideoFeedType(activeCamera.feedType))
  ) {
    this._clearCctvVideo();
    return false;
  }
  const panelVisible = () =>
    !this._cctvPanel?.hidden &&
    !this._cctvPanel?.classList?.contains('collapsed');
  if (
    this._cctvVideoCameraId === activeCamera.id &&
    this._cctvVideoFeedType === activeCamera.feedType &&
    (!embedded || this._cctvVideoEmbedUrl === activeCamera.embedUrl)
  ) {
    this._cctvPlayback?.setActive(panelVisible());
    return true;
  }
  this._clearCctvFrame();
  this._clearCctvVideo();
  const video = document.createElement(embedded ? 'div' : 'video');
  video.className = embedded ? 'cctv-embed' : 'cctv-video';
  if (!embedded) {
    video.controls = true;
    video.muted = true;
    video.loop = false;
    video.preload = 'auto';
    video.playsInline = true;
  }
  video.setAttribute(
    'aria-label',
    `${activeCamera.name || 'CCTV'} camera video`,
  );
  this._cctvVideoCameraId = activeCamera.id;
  this._cctvVideoFeedType = activeCamera.feedType;
  this._cctvVideoEmbedUrl = activeCamera.embedUrl;
  this._cctvVideo = video;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Play / retry camera video';
  retry.hidden = true;
  retry.onclick = () => this._cctvPlayback?.play();
  this._cctvVideoRetry = retry;
  this._cctvFrameWrap?.appendChild(video);
  this._cctvFrameWrap?.appendChild(retry);
  if (embedded) {
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.textContent = 'Pause camera video';
    pause.hidden = true;
    pause.onclick = () => this._cctvPlayback?.pause();
    this._cctvVideoPause = pause;
    this._cctvFrameWrap?.appendChild(pause);
    const note = document.createElement('p');
    note.className = 'cctv-embed-note';
    note.textContent =
      'Watch with the camera publisher’s video controls. This video is not projected onto the globe.';
    this._cctvVideoNote = note;
    this._cctvFrameWrap?.appendChild(note);
    try {
      const sourcePage = new URL(activeCamera.sourcePage);
      if (
        sourcePage.protocol === 'https:' &&
        !sourcePage.username &&
        !sourcePage.password
      ) {
        const link = document.createElement('a');
        link.href = sourcePage.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Open camera source';
        link.className = 'cctv-embed-source';
        this._cctvVideoSource = link;
        this._cctvFrameWrap?.appendChild(link);
      }
    } catch {
      /* A missing source page never prevents the approved player. */
    }
  }
  const playbackOptions = {
    playbackKind: activeCamera.playbackKind,
    visibilityTarget: document,
    initiallyActive: panelVisible(),
    video,
    url: activeCamera.mediaUrl,
    feedType: activeCamera.feedType,
    autoPlay: cameraMediaKind(activeCamera) === 'live',
    onStatus: (status) => {
      if (this.destroyed || this._cctvVideo !== video) return;
      this._cctvVideoStatus = status;
      retry.hidden = embedded
        ? ['playing', 'loading', 'suspended'].includes(status.status)
        : !['blocked', 'unavailable', 'unsupported', 'ended'].includes(
            status.status,
          );
      if (embedded) {
        retry.textContent = ['unavailable', 'ended'].includes(status.status)
          ? 'Retry camera video'
          : 'Play camera video';
        this._cctvVideoPause.hidden = !['playing', 'loading'].includes(
          status.status,
        );
      }
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
  };
  this._cctvPlayback = embedded
    ? createCctvEmbedPlayback({
        ...playbackOptions,
        container: video,
        embedUrl: activeCamera.embedUrl,
        statusUrl: `/api/cctv/embed-status/${encodeURIComponent(activeCamera.id)}`,
        title: `${activeCamera.name || 'CCTV'} live camera`,
      })
    : createCctvVideoPlayback(playbackOptions);
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
  this._cctvVideoPause?.remove();
  this._cctvVideoPause = null;
  this._cctvVideoNote?.remove();
  this._cctvVideoNote = null;
  this._cctvVideoSource?.remove();
  this._cctvVideoSource = null;
  this._cctvVideo?.remove();
  this._cctvVideo = null;
  this._cctvVideoCameraId = null;
  this._cctvVideoFeedType = null;
  this._cctvVideoEmbedUrl = null;
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
    const { status, message, liveStatus } = this._cctvVideoStatus;
    const mediaLabel =
      activeCamera.feedType === 'embed' && liveStatus !== 'live'
        ? 'VIDEO PLAYER'
        : cameraMediaLabel(activeCamera).toUpperCase();
    this._cctvSourceBadge.textContent =
      status === 'playing'
        ? activeCamera.feedType === 'embed' && liveStatus !== 'live'
          ? message || 'STREAM PLAYING · LIVE STATUS UNCONFIRMED'
          : `${mediaLabel} · PLAYING`
        : status === 'ready'
          ? `${mediaLabel} · READY — USE PLAY CONTROLS`
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
