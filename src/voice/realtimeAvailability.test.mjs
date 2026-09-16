import assert from 'node:assert/strict';
import test from 'node:test';
import { createRealtimeBackend } from './realtimeBackend.js';
import { GevRealtimeController } from './realtimeController.js';
import { describeVoiceError, realtimeError } from './realtimeErrors.js';
import { resolveVoiceModel } from './voiceCost.js';
import { createVoiceSession } from './session.js';

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
    t.after(() =>
      old
        ? Object.defineProperty(globalThis, key, old)
        : delete globalThis[key],
    );
  }
}

function fixture(
  t,
  {
    availability = { available: true },
    tokenFailure = null,
    channelOpen = true,
  } = {},
) {
  const calls = [];
  const track = {
    enabled: false,
    stopped: 0,
    stop() {
      this.stopped++;
    },
  };
  class Peer {
    constructor() {
      this.connectionState = 'connected';
    }
    addTrack() {}
    createDataChannel() {
      this.channel = {
        readyState: channelOpen ? 'open' : 'connecting',
        handlers: new Map(),
        addEventListener(type, handler) {
          this.handlers.set(type, handler);
        },
        close() {
          this.readyState = 'closed';
        },
        send() {
          calls.push('send');
        },
      };
      return this.channel;
    }
    async createOffer() {
      return { sdp: 'offer' };
    }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() {
      this.connectionState = 'closed';
    }
  }
  globals(t, {
    window: { RTCPeerConnection: Peer },
    RTCPeerConnection: Peer,
    document: {
      querySelectorAll: () => [],
      body: { appendChild() {} },
      createElement: () => ({ dataset: {}, style: {}, remove() {} }),
    },
    navigator: {
      mediaDevices: {
        async getUserMedia() {
          calls.push('microphone');
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    },
  });
  const ui = {
    root: {
      dataset: {},
      classList: { remove() {} },
      querySelectorAll: () => [],
      remove() {},
    },
    button: { setAttribute() {} },
    buttonLabel: {},
    status: {},
    detail: {},
    helpDetail: {},
    errorDetail: {},
    errorTitle: {},
    errorHint: {},
  };
  const controller = new GevRealtimeController({
    runner: async () => ({}),
    ui,
    debugSink: null,
    radioLayer: { pause: () => calls.push('pause-radio'), setVoiceDucked() {} },
    backend: {
      async requestAvailability() {
        calls.push('availability');
        return availability;
      },
      async requestToken() {
        calls.push('token');
        if (tokenFailure) throw tokenFailure;
        return { token: 'test', model: resolveVoiceModel('mini').id };
      },
      async negotiate() {
        calls.push('negotiate');
        return 'answer';
      },
    },
  });
  t.after(() => controller.stop());
  return { controller, ui, calls, track };
}

test('missing setup and restricted voice never mint tokens, request microphones, or interrupt radio', async (t) => {
  for (const code of ['VOICE_NOT_CONFIGURED', 'VOICE_AUTH_REQUIRED']) {
    const { controller, ui, calls } = fixture(t, {
      availability: {
        available: false,
        code,
        message: 'Voice requires setup or access.',
      },
    });
    await controller.refreshAvailability();
    assert.equal(ui.root.dataset.availability, 'unavailable');
    await controller.start();
    await controller.start({ pushToTalk: true });
    assert.deepEqual(calls, ['availability', 'availability', 'availability']);
    assert.equal(controller.status, 'idle');
    assert.equal(controller.errors.length, 0);
    assert.equal(ui.errorDetail.textContent, '');
    assert.match(ui.helpDetail.textContent, /site owner/);
    assert.equal(
      ui.status.textContent,
      code === 'VOICE_NOT_CONFIGURED' ? 'SETUP NEEDED' : 'ACCESS REQUIRED',
    );
  }
});

test('session stop preserves the controller setup message instead of repainting it as OFF', async (t) => {
  const { controller, ui } = fixture(t, { availability: {
    available: false, code: 'VOICE_NOT_CONFIGURED', message: 'AI voice needs server setup.',
  } });
  const session = createVoiceSession({ runner: async () => ({}), createAdapter: ({ emit }) => {
    controller.onSessionEvent = emit;
    return {
      start: options => controller.start(options),
      stop: options => controller.stop(options),
      sendText() {}, sendMapEvent() {},
    };
  } });
  session.subscribe(event => {
    if (event.type === 'state') ui.status.textContent = event.state === 'idle' ? 'OFF' : event.state;
  });
  await controller.refreshAvailability();
  session.stop();
  assert.equal(session.state, 'idle');
  assert.equal(ui.status.textContent, 'SETUP NEEDED');
});

test('available voice keeps the real token, microphone, and WebRTC sequence', async (t) => {
  const { controller, calls, track } = fixture(t);
  await controller.start();
  assert.ok(calls.indexOf('availability') < calls.indexOf('token'));
  assert.ok(calls.indexOf('token') < calls.indexOf('microphone'));
  assert.ok(calls.indexOf('microphone') < calls.indexOf('negotiate'));
  controller.dc.handlers.get('open')();
  assert.equal(controller.status, 'listening');
  controller.stop();
  assert.equal(track.stopped, 1);
});

test('failed availability check is recoverable without assuming configuration or minting a token', async (t) => {
  const { controller, calls, ui } = fixture(t);
  controller.backend.requestAvailability = async () => {
    throw new TypeError('Failed to fetch');
  };
  await controller.start();
  assert.deepEqual(calls, []);
  assert.equal(ui.status.textContent, 'CHECK CONNECTION');
  assert.equal(controller.status, 'idle');
  controller.backend.requestAvailability = async () => ({ available: true });
  await controller.start();
  assert.ok(calls.includes('token'));
});

test('stopping while availability is pending cannot acquire a token or microphone later', async (t) => {
  const { controller, calls } = fixture(t);
  let release;
  controller.backend.requestAvailability = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = controller.start();
  controller.stop();
  release({ available: true });
  await pending;
  assert.deepEqual(calls, []);
  assert.equal(controller.status, 'idle');
});

test('a stale initial capability check cannot overwrite the successful explicit connection check', async (t) => {
  const { controller } = fixture(t);
  let releaseInitial;
  let checks = 0;
  controller.backend.requestAvailability = () =>
    ++checks === 1
      ? new Promise((resolve) => {
          releaseInitial = resolve;
        })
      : Promise.resolve({ available: true, code: 'VOICE_READY' });
  const initial = controller.refreshAvailability();
  await controller.start();
  controller.dc.handlers.get('open')();
  releaseInitial({ available: false, code: 'VOICE_NOT_CONFIGURED' });
  await initial;
  assert.equal(controller.availability.available, true);
  assert.equal(controller.status, 'listening');
});

test('configuration changing after preflight still fails safely without misleading microphone advice', async (t) => {
  const { controller, calls, ui } = fixture(t, {
    tokenFailure: realtimeError('AI voice is not configured.', {
      code: 'VOICE_NOT_CONFIGURED',
      status: 503,
    }),
  });
  await controller.start();
  assert.equal(calls.filter((call) => call === 'token').length, 1);
  assert.ok(!calls.includes('microphone'));
  assert.equal(controller.status, 'idle');
  assert.equal(ui.status.textContent, 'SETUP NEEDED');
  assert.equal(ui.errorHint.textContent, '');
});

test('Realtime API errors close the live microphone and transport before showing failure', async (t) => {
  const { controller, track, ui } = fixture(t);
  await controller.start();
  controller.dc.handlers.get('open')();
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'error',
      error: { code: 'invalid_api_key', message: 'Provider access denied' },
    }),
  });
  assert.equal(track.stopped, 1);
  assert.equal(controller.pc, null);
  assert.equal(controller.dc, null);
  assert.equal(controller.status, 'error');
  assert.match(ui.errorHint.textContent, /credentials/);
  assert.doesNotMatch(ui.errorHint.textContent, /microphone/);
});

test('a recoverable ICE candidate warning does not falsely mark a live microphone as disconnected', async (t) => {
  const { controller, track } = fixture(t);
  await controller.start();
  controller.dc.handlers.get('open')();
  controller.pc.onicecandidateerror({
    errorCode: 701,
    errorText: 'One candidate failed',
  });
  assert.equal(controller.status, 'listening');
  assert.equal(track.stopped, 0);
  assert.equal(controller.errors.length, 0);
  controller.pc.iceConnectionState = 'failed';
  controller.pc.oniceconnectionstatechange();
  assert.equal(controller.status, 'error');
  assert.equal(track.stopped, 1);
  assert.equal(controller.pc, null);
});

test('permanent failed responses release resources without replaying queued requests', async (t) => {
  const { controller, calls, track } = fixture(t);
  await controller.start();
  controller.dc.handlers.get('open')();
  controller.pendingUserTextResponse = true;
  await controller.handleRealtimeEvent({
    data: JSON.stringify({
      type: 'response.done',
      response: {
        status: 'failed',
        status_details: {
          error: { code: 'insufficient_quota', message: 'Quota exhausted' },
        },
      },
    }),
  });
  assert.equal(controller.status, 'error');
  assert.equal(track.stopped, 1);
  assert.ok(!calls.includes('send'));
});

test('WebRTC channels that never open time out and release the microphone', async (t) => {
  let timeout;
  globals(t, {
    setTimeout: (callback) => {
      timeout = callback;
      return 1;
    },
    clearTimeout() {},
  });
  const { controller, track, ui } = fixture(t, { channelOpen: false });
  await controller.start();
  assert.equal(typeof timeout, 'function');
  timeout();
  assert.equal(track.stopped, 1);
  assert.equal(controller.status, 'error');
  assert.match(ui.errorTitle.textContent, /TIMED OUT/);
});

test('capability transport is no-store, does not use the paid token route and validates responses', async () => {
  const requests = [];
  const backend = createRealtimeBackend({
    statusTransport: async (url, options) => {
      requests.push(url);
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      return Response.json({ available: false, code: 'VOICE_NOT_CONFIGURED' });
    },
    tokenTransport: () => assert.fail('No token should be minted'),
  });
  assert.equal((await backend.requestAvailability()).available, false);
  assert.deepEqual(requests, ['/api/realtime/status']);
  for (const response of [
    Response.json({}),
    new Response('<html>404</html>', { status: 404 }),
  ]) {
    await assert.rejects(
      createRealtimeBackend({
        statusTransport: async () => response,
      }).requestAvailability(),
      /Could not check/,
    );
  }
});

test('error hints distinguish configuration, permissions, quotas and transport failures', () => {
  assert.equal(
    describeVoiceError({ message: 'OPENAI_API_KEY is not set' }).unavailable,
    true,
  );
  assert.match(
    describeVoiceError({ name: 'NotAllowedError' }).hint,
    /Allow microphone/,
  );
  assert.match(
    describeVoiceError({ name: 'NotFoundError' }).hint,
    /Connect or enable/,
  );
  assert.equal(describeVoiceError({ status: 429 }).retryable, true);
  assert.equal(
    describeVoiceError({ code: 'insufficient_quota', status: 429 }).retryable,
    false,
  );
  assert.match(describeVoiceError({ status: 401 }).hint, /credentials/);
  assert.match(
    describeVoiceError({ code: 'VOICE_CONNECTION_TIMEOUT' }).hint,
    /respond in time/,
  );
});

test('server failure contract preserves setup and transient distinctions across gateway HTTP statuses', async () => {
  for (const [code, status, retryable, hint] of [
    ['VOICE_PROVIDER_ACCESS_DENIED', 502, false, /credentials/],
    ['VOICE_CONFIGURATION_ERROR', 502, false, /model and session settings/],
    ['VOICE_QUOTA_EXHAUSTED', 429, false, /spending limit/],
    ['VOICE_RATE_LIMITED', 429, true, /Wait/],
    ['VOICE_PROVIDER_TIMEOUT', 504, true, /respond in time/],
    ['VOICE_PROVIDER_UNREACHABLE', 502, true, /could not be reached/],
    ['VOICE_PROVIDER_UNAVAILABLE', 502, true, /could not be reached/],
    ['VOICE_INVALID_RESPONSE', 502, true, /invalid response/],
  ]) {
    const backend = createRealtimeBackend({
      tokenTransport: async () =>
        Response.json(
          {
            code,
            retryable,
            error: 'Actionable server detail',
          },
          { status },
        ),
    });
    await assert.rejects(backend.requestToken(), (error) => {
      const description = describeVoiceError(error);
      assert.equal(error.code, code);
      assert.equal(description.retryable, retryable);
      assert.match(description.hint, hint);
      assert.doesNotMatch(description.hint, /microphone/);
      return true;
    });
  }
});
