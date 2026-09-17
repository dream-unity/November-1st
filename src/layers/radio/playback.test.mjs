import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayback, createRadioStreamPlayer } from './playback.js';
import { RADIO_STREAM_TIMEOUT_MS } from './policy.js';

function harness(t, { play = () => Promise.resolve() } = {}) {
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
    removeAttribute(key) {
      if (key === 'src') this.src = '';
    }
    load() {}
  }
  const player = createRadioStreamPlayer({
    audioFactory: () => new FakeAudio(),
    onState: (state) => reports.push(state),
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
