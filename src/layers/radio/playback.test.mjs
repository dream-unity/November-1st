import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback, createRadioStreamPlayer } from './playback.js';
import { RADIO_STREAM_TIMEOUT_MS } from './policy.js';

function harness(
  t,
  { play = () => Promise.resolve(), hlsOptions, nativeHls = false } = {},
) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const media = [];
  const reports = [];
  class FakeAudio {
    constructor() {
      this.listeners = new Map();
      this.src = '';
      this.volume = 0.8;
      this.ended = false;
      media.push(this);
    }
    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }
    emit(type) {
      this.listeners.get(type)?.();
    }
    pause() {
      this.emit('pause');
    }
    play() {
      this.emit('play');
      return play(this);
    }
    canPlayType() {
      return nativeHls ? 'probably' : '';
    }
    removeAttribute(key) {
      if (key === 'src') this.src = '';
    }
    load() {}
  }
  const player = createRadioStreamPlayer({
    audioFactory: () => new FakeAudio(),
    onState: (state) => reports.push(state),
    hlsOptions,
  });
  t.after(() => player.destroy());
  const station = {
    id: 'station-a',
    name: 'Station A',
    streamUrl: 'https://radio.example.com/live.mp3',
  };
  player.setStation(station);
  return { player, media, reports, station };
}

test('direct play calls media synchronously and a stalled stream has a finite error', async (t) => {
  let called = false;
  const { player, media } = harness(t, {
    play: () => {
      called = true;
      return new Promise(() => {});
    },
  });
  const pending = player.play();
  assert.equal(called, true, 'preserves click activation');
  assert.equal(player.getState().audioState, 'loading');
  t.mock.timers.tick(RADIO_STREAM_TIMEOUT_MS - 1);
  media[0].emit('waiting');
  t.mock.timers.tick(1);
  assert.equal(await pending, false);
  assert.equal(player.getState().audioState, 'error');
  assert.match(player.getState().audioError, /did not deliver audio/);
  assert.equal(media[0].src, '', 'releases a stalled network stream');
  media[0].emit('pause');
  media[0].emit('playing');
  assert.equal(player.getState().audioState, 'error');
});

const hlsStation = {
  id: 'curated-au-live',
  name: 'Australian broadcaster',
  streamUrl: 'https://radio.example.com/live.m3u8',
  streamFormat: 'hls',
  liveOnly: true,
  playbackKind: 'live',
  sourceKind: 'curated-australia',
};

function fakeHls() {
  const instances = [];
  class FakeHls {
    static Events = {
      LEVEL_LOADED: 'level',
      AUDIO_TRACK_LOADED: 'audio-track',
      ERROR: 'error',
    };
    static isSupported = () => true;
    constructor() {
      this.listeners = new Map();
      instances.push(this);
    }
    on(event, handler) {
      this.listeners.set(event, handler);
    }
    emit(event, data) {
      this.listeners.get(event)?.(event, data);
    }
    attachMedia(audio) {
      this.audio = audio;
      audio.src = 'blob:media-source';
    }
    loadSource(url) {
      this.url = url;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { HlsClass: FakeHls, instances };
}

test('curated HLS preserves the tap, waits for live proof, and releases all resources on pause/resume', async (t) => {
  const hls = fakeHls();
  let calls = 0;
  const { player, media } = harness(t, {
    hlsOptions: hls,
    play: () => {
      calls++;
      return Promise.resolve();
    },
  });
  player.setStation(hlsStation);
  const pending = player.play();
  assert.equal(
    calls,
    1,
    'HLS play is synchronous, without awaiting a module import',
  );
  assert.equal(media[0].muted, true);
  media[0].emit('playing');
  assert.equal(
    player.getState().audioState,
    'loading',
    'no live label before playlist proof',
  );
  hls.instances[0].emit('level', { details: { live: true } });
  assert.equal(await pending, true);
  assert.equal(media[0].muted, false);
  assert.equal(player.getState().audioState, 'playing');
  player.pause();
  assert.equal(hls.instances[0].destroyed, true);
  assert.equal(media[0].src, '');
  assert.equal(player.getState().audioState, 'paused');
  const resumed = player.play();
  hls.instances[0].emit('level', { details: { live: false } });
  hls.instances[1].emit('level', { details: { live: true } });
  assert.equal(await resumed, true);
  player.destroy();
  assert.equal(hls.instances[1].destroyed, true);
});

test('recorded HLS and a live station becoming finite are terminal, never snapshot or recording fallbacks', async (t) => {
  const hls = fakeHls();
  const { player, media } = harness(t, { hlsOptions: hls });
  player.setStation(hlsStation);
  const recorded = player.play();
  hls.instances[0].emit('level', { details: { live: false } });
  assert.equal(await recorded, false);
  assert.match(player.getState().audioError, /recording or ended/);
  assert.equal(media[0].muted, true);
  assert.equal(media[0].src, '');
  assert.equal(hls.instances[0].destroyed, true);
  const live = player.play();
  hls.instances[1].emit('level', { details: { live: true } });
  assert.equal(await live, true);
  hls.instances[1].emit('audio-track', {
    details: { live: false, type: 'VOD' },
  });
  assert.equal(player.getState().audioState, 'error');
  assert.equal(hls.instances[1].destroyed, true);
});

test('HLS network errors clean up, and station switching cancels pending HLS without stale events', async (t) => {
  const hls = fakeHls();
  const { player, media, station } = harness(t, { hlsOptions: hls });
  player.setStation(hlsStation);
  const failed = player.play();
  hls.instances[0].emit('error', { fatal: true });
  assert.equal(await failed, false);
  assert.match(player.getState().audioError, /blocked/);
  const pending = player.play();
  player.setStation(station);
  assert.equal(await pending, false);
  assert.equal(hls.instances[1].destroyed, true);
  hls.instances[1].emit('level', { details: { live: true } });
  media[1].emit('playing');
  assert.equal(player.getState().audioState, 'stopped');
  assert.equal(await player.play(), true);
});

test('community HLS is rejected without invoking media or the HLS library', async (t) => {
  const hls = fakeHls();
  let plays = 0;
  const { player } = harness(t, {
    hlsOptions: hls,
    play: () => {
      plays++;
    },
  });
  player.setStation({ ...hlsStation, sourceKind: 'community' });
  assert.equal(await player.play(), false);
  assert.match(player.getState().audioError, /not been verified/);
  assert.equal(plays, 0);
  assert.equal(hls.instances.length, 0);
});

test('unsupported HLS has a clear retryable error without trying progressive playback', async (t) => {
  const { player, media } = harness(t, {
    hlsOptions: { HlsClass: { isSupported: () => false } },
  });
  player.setStation(hlsStation);
  assert.equal(await player.play(), false);
  assert.match(
    player.getState().audioError,
    /cannot play this live radio format/,
  );
  assert.equal(media[0].src, '');
});

test('native HLS follows published master references and stays muted until a live media manifest is checked', async (t) => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return new Response(
      requests.length === 1
        ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\naudio/live.m3u8\n'
        : '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:123\n#EXTINF:6,\nsegment123.aac\n',
    );
  };
  const { player, media } = harness(t, {
    nativeHls: true,
    hlsOptions: { fetchImpl },
  });
  player.setStation(hlsStation);
  const pending = player.play();
  assert.equal(media[0].src, hlsStation.streamUrl);
  assert.equal(media[0].muted, true);
  assert.equal(await pending, true);
  assert.equal(media[0].muted, false);
  assert.equal(requests[1].url, 'https://radio.example.com/audio/live.m3u8');
  assert.equal(requests[0].options.credentials, 'omit');
  player.pause();
  assert.equal(requests[0].options.signal.aborted, true);
  t.mock.timers.tick(60_000);
  assert.equal(requests.length, 2);
});

test('native HLS refuses ENDLIST, VOD, unavailable manifests and unsafe variant URLs', async (t) => {
  let manifest = '#EXTM3U\n#EXTINF:6,\nsegment.aac\n#EXT-X-ENDLIST\n';
  const { player, media } = harness(t, {
    nativeHls: true,
    hlsOptions: { fetchImpl: async () => new Response(manifest) },
  });
  player.setStation(hlsStation);
  for (const text of [
    manifest,
    '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\na.aac',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000\nhttps://127.0.0.1/live.m3u8\n',
    '<html>Access denied</html>',
  ]) {
    manifest = text;
    assert.equal(await player.play(), false);
    assert.equal(player.getState().audioState, 'error');
    assert.equal(media.at(-1).muted, true);
    assert.equal(media.at(-1).src, '');
  }
});

test('native HLS cancellation aborts a pending manifest and never unmutes retired audio', async (t) => {
  let resolve;
  let signal;
  const { player, media } = harness(t, {
    nativeHls: true,
    hlsOptions: {
      fetchImpl: (_url, options) => {
        signal = options.signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    },
  });
  player.setStation(hlsStation);
  const pending = player.play();
  player.stop();
  assert.equal(await pending, false);
  assert.equal(signal.aborted, true);
  resolve(new Response('#EXTM3U\n#EXTINF:6,\na.aac'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(player.getState().audioState, 'stopped');
  assert.equal(media[0].muted, true);
});

test('playing clears startup timeout, buffering times out, and Retry creates new media', async (t) => {
  const { player, media } = harness(t);
  assert.equal(await player.play(), true);
  t.mock.timers.tick(RADIO_STREAM_TIMEOUT_MS);
  assert.equal(player.getState().audioState, 'playing');
  media[0].emit('waiting');
  t.mock.timers.tick(RADIO_STREAM_TIMEOUT_MS / 2);
  media[0].emit('waiting');
  t.mock.timers.tick(RADIO_STREAM_TIMEOUT_MS / 2);
  assert.equal(player.getState().audioState, 'error');
  assert.equal(await player.play(), true);
  assert.equal(media.length, 2);
  media[0].emit('error');
  assert.equal(player.getState().audioState, 'playing');
});

test('pause and station replacement settle pending attempts and ignore obsolete events', async (t) => {
  const { player, media } = harness(t, { play: () => new Promise(() => {}) });
  const first = player.play();
  player.pause();
  assert.equal(await first, false);
  t.mock.timers.tick(RADIO_STREAM_TIMEOUT_MS);
  assert.equal(player.getState().audioState, 'paused');
  const second = player.play();
  player.setStation({ id: 'b', streamUrl: 'https://radio.example.com/b.aac' });
  assert.equal(await second, false);
  media[1].emit('playing');
  assert.equal(player.getState().audioState, 'stopped');
  assert.equal(player.getState().station.id, 'b');
});

test('media ending and decode errors become actionable failures that cleanup cannot hide', async (t) => {
  const { player, media } = harness(t);
  await player.play();
  media[0].ended = true;
  media[0].emit('pause');
  media[0].emit('ended');
  assert.equal(player.getState().audioState, 'error');
  assert.match(player.getState().audioError, /ended this stream/);
  await player.play();
  media[1].error = { code: 4 };
  media[1].emit('error');
  assert.match(player.getState().audioError, /cannot be decoded/);
});

test('native resume events arm buffering timeout and successful recovery clears it', async (t) => {
  const { player, media } = harness(t);
  await player.play();
  media[0].emit('pause');
  assert.equal(player.getState().audioState, 'paused');
  media[0].emit('play');
  assert.equal(player.getState().audioState, 'loading');
  media[0].emit('playing');
  t.mock.timers.tick(RADIO_STREAM_TIMEOUT_MS);
  assert.equal(player.getState().audioState, 'playing');
});

test('gesture rejection keeps the selected station instead of consuming a fallback', async (t) => {
  const previousAudio = globalThis.Audio;
  t.after(() => {
    if (previousAudio === undefined) delete globalThis.Audio;
    else globalThis.Audio = previousAudio;
  });
  globalThis.Audio = class {
    addEventListener() {}
    pause() {}
    removeAttribute() {}
    load() {}
    play() {
      return Promise.reject(new DOMException('gesture', 'NotAllowedError'));
    }
  };
  const station = { id: 'a', streamUrl: 'https://radio.example.com/a.mp3' };
  const state = {
    _selectedId: 'a',
    _userVolume: 0.8,
    _playGeneration: 0,
    _playAttemptSequence: 0,
    _stationById: new Map([['b', { id: 'b' }]]),
    _playFallbackId: 'b',
  };
  let selectedFallback = false;
  const player = createPlayback({
    state,
    source: { recordClick() {} },
    parts: {
      queries: { selectedStation: () => station },
      interaction: { radioPresentationAllowed: () => true },
      selection: {
        selectRadioStation() {
          selectedFallback = true;
        },
      },
      tuning: { endRadioTuning() {} },
      presentation: { emitState() {}, emitPlaybackControl() {} },
    },
  });
  assert.equal(await player.playSelectedRadio(), false);
  assert.equal(selectedFallback, false);
  assert.equal(state._selectedId, 'a');
  assert.match(state._audioError, /Tap Play/);
});

test('standalone transport refuses unsafe streams and cannot restart after destruction', async (t) => {
  const { player, media } = harness(t);
  assert.equal(
    player.setStation({ id: 'private', streamUrl: 'https://127.0.0.1/x' }),
    false,
  );
  assert.equal(
    player.setStation({ id: 'http', streamUrl: 'http://radio.example.com/x' }),
    false,
  );
  player.setVolume(0.3);
  await player.play();
  assert.equal(media[0].volume, 0.3);
  player.destroy();
  assert.equal(await player.play(), false);
  assert.equal(media[0].src, '');
});
