import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createHudSummaryPolicy } from './services/hudSummaryPolicy.js';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'mgrs'
      ? { url: 'hud-policy-test:mgrs', shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url === 'hud-policy-test:mgrs'
      ? {
          format: 'module',
          shortCircuit: true,
          source: 'export const forward = () => "fixture";',
        }
      : next(url, context);
  },
});
const { IntelHUD } = await import('./hud.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  let contextReads = 0,
    summaries = 0;
  const paints = [];
  const contextOptions = [];
  const voice = {
    startEpoch: 1,
    session: { state: 'listening', isActive: () => true },
    pc: { connectionState: 'connected' },
    dc: { readyState: 'open' },
  };
  const policy = createHudSummaryPolicy({
    getVoice: () => voice,
    fetchImpl: async () =>
      Response.json({
        providers: [
          {
            id: 'voice',
            available: true,
            configured: true,
            status: 'configured',
          },
        ],
      }),
  });
  const hud = Object.create(IntelHUD.prototype);
  Object.assign(hud, {
    _visible: true,
    _destroyed: false,
    _latestMetrics: { latDeg: 30.27, lonDeg: -97.74 },
    _summaryDirty: true,
    _summaryRevision: 0,
    _summaryRequest: null,
    _lastSummarySignature: '',
    basemapContext: {},
    summaryPolicy: policy,
    viewer: { camera: { moveEnd: { removeEventListener() {} } } },
    _composeSummary: () =>
      'NEAR TEXAS CAPITOL (AUSTIN) 1KM | NORTH AMERICA | ALT 2KM',
    _summaryContext: async (options) => {
      contextReads++;
      contextOptions.push(options);
      return { placeLabels: ['Austin'] };
    },
    _setSummaryText: (text) => {
      if (!hud._destroyed) paints.push(text);
    },
    summaryService: {
      summarize: async () => {
        summaries++;
        return {
          ok: true,
          status: 200,
          data: { summary: 'A grounded Austin fixture summary' },
        };
      },
    },
  });
  return {
    hud,
    voice,
    paints,
    contextOptions,
    get contextReads() {
      return contextReads;
    },
    get summaries() {
      return summaries;
    },
  };
}

test('default and denied HUD policy keeps local POI/camera information without starting context or AI requests', async () => {
  for (const summaryPolicy of [{}, { authorize: async () => null }]) {
    const f = fixture();
    f.hud.summaryPolicy = summaryPolicy;
    await f.hud._updateSummary(false, true);
    assert.equal(f.contextReads, 0);
    assert.equal(f.summaries, 0);
    assert.match(f.paints.at(-1), /TEXAS CAPITOL.*AUSTIN.*ALT 2KM/);
  }
});

test('OpenAI-only explicit connected owner can summarize local/cached labels without Google enrichment', async () => {
  const previous = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    const f = fixture();
    await f.hud._updateSummary(false, true);
    assert.equal(f.summaries, 1);
    assert.deepEqual(f.contextOptions, [{ cachedOnly: true }]);
    assert.equal(f.paints.at(-1), 'A grounded Austin fixture summary');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('voice stop/reconnect during place lookup cannot authorize an old HUD OpenAI request', async () => {
  for (const change of [
    (voice) => {
      voice.session.state = 'idle';
    },
    (voice) => {
      voice.pc = { connectionState: 'connected' };
      voice.startEpoch++;
    },
  ]) {
    const f = fixture();
    let finish;
    f.hud._summaryContext = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const updating = f.hud._updateSummary(false, true);
    await tick();
    change(f.voice);
    finish({ placeLabels: ['Old camera context'] });
    await updating;
    assert.equal(f.summaries, 0);
    assert.equal(f.paints.length, 0);
  }
});

test('late HUD responses and context errors after teardown cannot overwrite local/newer content', async () => {
  const previous = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    for (const stage of ['response', 'context']) {
      const f = fixture();
      let finish;
      if (stage === 'response')
        f.hud.summaryService.summarize = () =>
          new Promise((resolve) => {
            finish = resolve;
          });
      else
        f.hud._summaryContext = () =>
          new Promise((resolve, reject) => {
            finish = reject;
          });
      const updating = f.hud._updateSummary(false, true);
      await tick();
      const before = [...f.paints];
      f.hud.destroy();
      finish(
        stage === 'response'
          ? { ok: true, status: 200, data: { summary: 'Late paid response' } }
          : new Error('Late context failure'),
      );
      await updating;
      assert.deepEqual(f.paints, before);
    }
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});

test('HUD destroyed while capabilities are pending never starts geospatial or summary work', async () => {
  const f = fixture();
  let finish;
  f.hud.summaryPolicy = {
    authorize: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const updating = f.hud._updateSummary(false, true);
  f.hud.destroy();
  finish({ isCurrent: () => true });
  await updating;
  assert.equal(f.contextReads, 0);
  assert.equal(f.summaries, 0);
  assert.deepEqual(f.paints, []);
});

test('animated HUD text cannot overwrite a newer local summary or outlive its voice owner', () => {
  const old = {
    document: globalThis.document,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  const element = { textContent: '' };
  const callbacks = new Map();
  let next = 0;
  globalThis.document = { getElementById: () => element };
  globalThis.setInterval = (callback) => {
    callbacks.set(++next, callback);
    return next;
  };
  globalThis.clearInterval = (timer) => callbacks.delete(timer);
  try {
    const f = fixture();
    f.hud._setSummaryText = IntelHUD.prototype._setSummaryText;
    let owns = true;
    f.hud._setSummaryText('Old AI camera description', true, () => owns);
    const oldTimer = f.hud._summaryTypingInterval;
    const oldCallback = callbacks.get(oldTimer);
    oldCallback();
    assert.equal(element.textContent, 'Ol');
    f.hud._setSummaryText('Current local camera and POI', false);
    oldCallback();
    assert.equal(element.textContent, 'Current local camera and POI');
    assert.equal(callbacks.has(oldTimer), false);
    f.hud._setSummaryText('Current AI camera description', true, () => owns);
    const ownerCallback = callbacks.get(f.hud._summaryTypingInterval);
    owns = false;
    ownerCallback();
    assert.match(element.textContent, /TEXAS CAPITOL.*AUSTIN/);
    assert.equal(f.hud._summaryTypingInterval, null);
    owns = true;
    f.hud._setSummaryText('Another AI description', true, () => owns);
    const hiddenCallback = callbacks.get(f.hud._summaryTypingInterval);
    f.hud.hide();
    element.textContent = 'Hidden view stays unchanged';
    hiddenCallback();
    assert.equal(element.textContent, 'Hidden view stays unchanged');
    assert.equal(callbacks.size, 0);
  } finally {
    if (old.document === undefined) delete globalThis.document;
    else globalThis.document = old.document;
    globalThis.setInterval = old.setInterval;
    globalThis.clearInterval = old.clearInterval;
  }
});

test('a superseded HUD response leaves a fresh connected voice able to retry the same camera', async () => {
  const previous = globalThis.window;
  globalThis.window = { setTimeout, clearTimeout };
  try {
    const f = fixture();
    let finish;
    f.hud.summaryService.summarize = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const updating = f.hud._updateSummary(false, true);
    await tick();
    f.voice.session.state = 'idle';
    finish({
      ok: true,
      status: 200,
      data: { summary: 'Old voice description' },
    });
    await updating;
    assert.equal(f.hud._summaryDirty, true);
    assert.equal(f.hud._lastSummarySignature, '');
    f.voice.session.state = 'listening';
    f.voice.startEpoch++;
    let calls = 0;
    f.hud.summaryService.summarize = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        data: { summary: 'Fresh voice description' },
      };
    };
    await f.hud._updateSummary();
    assert.equal(calls, 1);
    assert.equal(f.paints.at(-1), 'Fresh voice description');
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
});
