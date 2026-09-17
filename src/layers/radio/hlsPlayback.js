import Hls from 'hls.js';
import { publicRadioHttpsUrl } from '../../sources/radioBrowser.js';
import { readResponseTextCapped } from '../../sources/httpBody.js';

export function isCuratedLiveRadioHls(station) {
  return (
    station?.streamFormat === 'hls' &&
    station.liveOnly === true &&
    station.playbackKind === 'live' &&
    station.sourceKind === 'curated-australia'
  );
}

const ENDED =
  'This broadcaster is serving a recording or ended broadcast. Only live radio is available here.';
const UNAVAILABLE =
  'Live radio is unavailable or blocked by the broadcaster or browser. Retry Play or choose another station.';

/** Synchronous attachment preserves the click that immediately calls audio.play(). */
export function createLiveRadioHls({
  audio,
  streamUrl,
  onLive,
  onError,
  HlsClass = Hls,
  fetchImpl = globalThis.fetch,
}) {
  let disposed = false;
  let player = null;
  let timer = null;
  const controller = new AbortController();
  const native = Boolean(
    audio.canPlayType?.('application/vnd.apple.mpegurl') ||
    audio.canPlayType?.('application/x-mpegURL'),
  );
  const fail = (message) => {
    if (!disposed) onError(message);
  };
  const live = () => {
    if (!disposed) onLive();
  };

  async function inspectNative(url, depth = 0) {
    if (depth > 3) throw new Error(UNAVAILABLE);
    const safeUrl = publicRadioHttpsUrl(url);
    if (!safeUrl) throw new Error(UNAVAILABLE);
    const response = await fetchImpl(safeUrl, {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(UNAVAILABLE);
    const text = await readResponseTextCapped(
      response,
      256 * 1024,
      controller.signal,
    );
    if (!/^\s*#EXTM3U(?:\s|$)/.test(text)) throw new Error(UNAVAILABLE);
    if (/#EXT-X-ENDLIST(?:\s|$)|#EXT-X-PLAYLIST-TYPE:\s*VOD/i.test(text))
      throw new Error(ENDED);
    // Resolve only references published by this manifest, never inferred URLs.
    const variant = text.match(
      /#EXT-X-STREAM-INF:[^\r\n]*\r?\n([^#\r\n][^\r\n]*)/,
    );
    if (variant)
      return inspectNative(
        new URL(variant[1].trim(), response.url || safeUrl).href,
        depth + 1,
      );
    if (!/#EXTINF:\s*\d/.test(text)) throw new Error(UNAVAILABLE);
    return safeUrl;
  }

  async function checkNative(url) {
    try {
      const mediaUrl = await inspectNative(url);
      if (disposed) return;
      live();
      // Native playback does not expose playlist events. Recheck so a publisher
      // ending the broadcast cannot leave a finite playlist labelled live.
      timer = setTimeout(() => void checkNative(mediaUrl), 15_000);
      timer?.unref?.();
    } catch (error) {
      if (!disposed) fail(error?.message === ENDED ? ENDED : UNAVAILABLE);
    }
  }

  const destroy = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    controller.abort();
    player?.destroy();
    player = null;
  };

  try {
    if (native) {
      if (typeof fetchImpl !== 'function') throw new Error(UNAVAILABLE);
      audio.src = streamUrl;
      void checkNative(streamUrl);
    } else {
      if (!HlsClass.isSupported())
        throw new Error(
          'This browser cannot play this live radio format. Choose another station or use a browser with HLS support.',
        );
      player = new HlsClass({
        backBufferLength: 0,
        maxBufferLength: 20,
        maxMaxBufferLength: 40,
      });
      const inspect = (_event, data) => {
        if (disposed) return;
        if (data?.details?.live !== true || data.details.type === 'VOD') {
          audio.muted = true;
          fail(ENDED);
        } else live();
      };
      player.on(HlsClass.Events.LEVEL_LOADED, inspect);
      if (HlsClass.Events.AUDIO_TRACK_LOADED)
        player.on(HlsClass.Events.AUDIO_TRACK_LOADED, inspect);
      player.on(HlsClass.Events.ERROR, (_event, data) => {
        if (data?.fatal) fail(UNAVAILABLE);
      });
      player.attachMedia(audio);
      player.loadSource(streamUrl);
    }
  } catch (error) {
    destroy();
    throw error;
  }
  return { destroy };
}
