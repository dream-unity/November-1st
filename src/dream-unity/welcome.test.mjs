import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';

const hooks = registerHooks({
  load(url, context, next) {
    if (url.endsWith('.css'))
      return { format: 'module', shortCircuit: true, source: 'export {};' };
    return next(url, context);
  },
});
const { installWelcome } = await import('./welcome.js');
hooks.deregister();

class Element extends EventTarget {
  constructor(id, documentRef) {
    super();
    this.id = id;
    this.ownerDocument = documentRef;
    this.hidden = false;
    this.inert = false;
    this.disabled = false;
    this.textContent = '';
    this.attributes = new Map();
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'hidden' || name === 'inert') this[name] = true;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'hidden' || name === 'inert') this[name] = false;
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  click() {
    if (!this.disabled) this.dispatchEvent(new Event('click'));
  }
}

function fixture() {
  const documentRef = { activeElement: null };
  const ids = [
    'du-welcome',
    'du-welcome-start',
    'du-welcome-guide',
    'du-new-user',
    'du-continue',
    'du-guide-continue',
    'du-guide-back',
    'du-guide-title',
    'du-welcome-status',
    'du-application',
  ];
  const nodes = Object.fromEntries(
    ids.map((id) => [id, new Element(id, documentRef)]),
  );
  documentRef.getElementById = (id) => nodes[id] ?? null;
  documentRef.querySelectorAll = () =>
    ['du-new-user', 'du-continue', 'du-guide-continue', 'du-guide-back'].map(
      (id) => nodes[id],
    );
  nodes['du-welcome-guide'].hidden = true;
  nodes['du-application'].hidden = true;
  nodes['du-application'].inert = true;
  nodes['du-welcome'].querySelectorAll = documentRef.querySelectorAll;
  return { documentRef, nodes };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function timerFixture() {
  const timers = new Map();
  const cancelled = [];
  let next = 0;
  return {
    timers,
    cancelled,
    setTimer(callback, delay) {
      const id = ++next;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      cancelled.push(id);
      timers.delete(id);
    },
    expire() {
      for (const [id, { callback }] of timers) {
        timers.delete(id);
        callback();
      }
    },
  };
}

function assertClosed(nodes) {
  assert.equal(nodes['du-welcome'].hidden, false);
  assert.equal(nodes['du-application'].hidden, true);
  assert.equal(nodes['du-application'].inert, true);
}

test('welcome is present before JavaScript and the application starts hidden and inert', async () => {
  const html = await readFile(
    new URL('../../index.html', import.meta.url),
    'utf8',
  );
  const opening = (id) =>
    html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0];
  for (const id of [
    'du-welcome',
    'du-welcome-start',
    'du-new-user',
    'du-continue',
  ]) {
    assert.ok(opening(id), `${id} must exist in the first server response`);
    assert.doesNotMatch(opening(id), /\shidden(?:\s|=|>)/);
  }
  assert.match(opening('du-welcome-guide'), /\shidden(?:\s|=|>)/);
  assert.match(opening('du-application'), /\shidden(?:\s|=|>)/);
  assert.match(opening('du-application'), /\sinert(?:\s|=|>)/);
  assert.match(opening('du-guide-title'), /tabindex="-1"/);
  assert.match(opening('du-welcome-status'), /role="status"/);
  assert.ok(
    html.indexOf('id="du-welcome"') < html.indexOf('id="du-application"'),
  );
});

test('visitors without JavaScript can see the recovery notice above the welcome screen', async () => {
  const [html, css] = await Promise.all([
    readFile(new URL('../../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./welcome.css', import.meta.url), 'utf8'),
  ]);
  const notice = [
    ...html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript\s*>/g),
  ]
    .map((match) => match[1])
    .find((content) => content.includes('This 3D globe needs JavaScript'));
  assert.ok(notice, 'the app must retain visible guidance without JavaScript');
  const noticeDepth = Number(notice.match(/z-index:\s*(\d+)/)?.[1]);
  const welcomeRule = css.match(/#du-welcome\s*\{([^}]+)\}/)?.[1] || '';
  const welcomeDepth = Number(welcomeRule.match(/z-index:\s*(\d+)/)?.[1]);
  assert.ok(Number.isFinite(noticeDepth) && Number.isFinite(welcomeDepth));
  assert.ok(
    noticeDepth > welcomeDepth,
    'welcome must not cover the JavaScript-disabled notice',
  );
  assert.match(notice, /href="https:\/\/dreamunity\.one\/"/);
});

test('installing welcome never starts the app; guide and back only change the welcome view', async () => {
  const { documentRef, nodes } = fixture();
  let loads = 0;
  installWelcome({
    documentRef,
    loadApplication: () => {
      loads++;
    },
  });
  await settle();
  assert.equal(loads, 0);
  assertClosed(nodes);
  nodes['du-new-user'].click();
  assert.equal(nodes['du-welcome-start'].hidden, true);
  assert.equal(nodes['du-welcome-guide'].hidden, false);
  assert.equal(documentRef.activeElement, nodes['du-guide-title']);
  assert.equal(loads, 0);
  assertClosed(nodes);
  nodes['du-guide-back'].click();
  assert.equal(nodes['du-welcome-start'].hidden, false);
  assert.equal(nodes['du-welcome-guide'].hidden, true);
  assert.equal(loads, 0);
  assertClosed(nodes);
});

for (const guided of [false, true]) {
  test(`${guided ? 'guide' : 'direct'} Continue loads once and reveals the app before its initializer runs`, async () => {
    const { documentRef, nodes } = fixture();
    const pending = deferred();
    const clock = timerFixture();
    let loads = 0;
    let starts = 0;
    installWelcome({
      documentRef,
      ...clock,
      loadApplication: () => {
        loads++;
        return pending.promise;
      },
    });
    if (guided) nodes['du-new-user'].click();
    nodes[guided ? 'du-guide-continue' : 'du-continue'].click();
    await settle();
    assert.equal(loads, 1);
    assert.equal(starts, 0);
    assert.equal(clock.timers.size, 1);
    assert.equal([...clock.timers.values()][0].delay, 30_000);
    assertClosed(nodes);
    assert.equal(nodes['du-continue'].disabled, true);
    assert.equal(nodes['du-guide-continue'].disabled, true);
    // Dispatching directly also covers queued events that bypass disabled.click().
    nodes['du-continue'].dispatchEvent(new Event('click'));
    nodes['du-guide-continue'].dispatchEvent(new Event('click'));
    await settle();
    assert.equal(loads, 1);
    pending.resolve({
      startGodsEye() {
        starts++;
        assert.equal(nodes['du-welcome'].hidden, true);
        assert.equal(nodes['du-application'].hidden, false);
        assert.equal(nodes['du-application'].inert, false);
      },
    });
    await settle();
    assert.equal(starts, 1);
    assert.equal(clock.timers.size, 0);
    assert.deepEqual(clock.cancelled, [1]);
    assert.equal(nodes['du-welcome'].hidden, true);
    assert.equal(nodes['du-application'].hidden, false);
    assert.equal(nodes['du-application'].inert, false);
    nodes['du-continue'].dispatchEvent(new Event('click'));
    await settle();
    assert.equal(loads, 1);
    assert.equal(starts, 1);
  });
}

test('an import failure keeps welcome and guide usable and Continue reloads without retrying cached modules', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { documentRef, nodes } = fixture();
  let loads = 0;
  let starts = 0;
  let reloads = 0;
  const clock = timerFixture();
  installWelcome({
    documentRef,
    ...clock,
    reloadApplication: () => {
      reloads++;
    },
    loadApplication: async () => {
      loads++;
      if (loads === 1) throw new Error('Chunk could not be fetched');
      return {
        startGodsEye() {
          starts++;
        },
      };
    },
  });
  nodes['du-continue'].click();
  await settle();
  assert.equal(loads, 1);
  assert.equal(starts, 0);
  assert.equal(clock.timers.size, 0);
  assert.deepEqual(clock.cancelled, [1]);
  assertClosed(nodes);
  assert.match(nodes['du-welcome-status'].textContent, /Continue to reload/);
  assert.equal(nodes['du-continue'].disabled, false);
  assert.equal(nodes['du-guide-continue'].disabled, false);
  assert.equal(nodes['du-welcome'].getAttribute('aria-busy'), 'false');
  nodes['du-new-user'].click();
  assert.equal(nodes['du-welcome-guide'].hidden, false);
  nodes['du-guide-back'].click();
  assert.equal(nodes['du-welcome-start'].hidden, false);
  nodes['du-new-user'].click();
  nodes['du-guide-continue'].click();
  nodes['du-continue'].dispatchEvent(new Event('click'));
  nodes['du-guide-continue'].dispatchEvent(new Event('click'));
  await settle();
  assert.equal(loads, 1);
  assert.equal(starts, 0);
  assert.equal(reloads, 1);
  assertClosed(nodes);
});

test('an initializer that throws restores the gate instead of leaving an empty application visible', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { documentRef, nodes } = fixture();
  let starts = 0;
  let reloads = 0;
  installWelcome({
    documentRef,
    reloadApplication: () => {
      reloads++;
    },
    loadApplication: async () => ({
      startGodsEye() {
        starts++;
        if (starts === 1) throw new Error('Initialization failed');
      },
    }),
  });
  nodes['du-continue'].click();
  await settle();
  assertClosed(nodes);
  assert.ok(nodes['du-welcome-status'].textContent.trim());
  assert.equal(nodes['du-continue'].disabled, false);
  nodes['du-continue'].click();
  await settle();
  assert.equal(starts, 1);
  assert.equal(reloads, 1);
  assertClosed(nodes);
});

for (const lateResult of ['resolve', 'reject']) {
  test(`a stalled import times out, restores the guide, and ignores a late ${lateResult}`, async (t) => {
    t.mock.method(console, 'error', () => {});
    const { documentRef, nodes } = fixture();
    const pending = deferred();
    const clock = timerFixture();
    let loads = 0;
    let starts = 0;
    let reloads = 0;
    installWelcome({
      documentRef,
      ...clock,
      loadTimeoutMs: 1234,
      loadApplication: () => {
        loads++;
        return pending.promise;
      },
      reloadApplication: () => {
        reloads++;
      },
    });
    nodes['du-new-user'].click();
    nodes['du-guide-continue'].click();
    await settle();
    assert.equal([...clock.timers.values()][0].delay, 1234);
    assert.equal(nodes['du-welcome'].getAttribute('aria-busy'), 'true');
    clock.expire();
    await settle();
    assertClosed(nodes);
    assert.equal(nodes['du-welcome-guide'].hidden, false);
    assert.equal(documentRef.activeElement, nodes['du-guide-continue']);
    assert.equal(nodes['du-guide-back'].disabled, false);
    assert.equal(nodes['du-welcome'].getAttribute('aria-busy'), 'false');
    assert.equal(clock.timers.size, 0);
    assert.deepEqual(clock.cancelled, [1]);
    assert.match(nodes['du-welcome-status'].textContent, /Continue to reload/);
    if (lateResult === 'resolve') {
      pending.resolve({
        startGodsEye() {
          starts++;
        },
      });
    } else {
      pending.reject(new Error('The abandoned request eventually failed'));
    }
    await settle();
    assertClosed(nodes);
    assert.equal(starts, 0);
    nodes['du-guide-back'].click();
    nodes['du-continue'].click();
    await settle();
    assert.equal(reloads, 1);
    assert.equal(loads, 1);
    assert.equal(starts, 0);
  });
}

test('default recovery reloads the same URL without reading or rebuilding its query and hash', async (t) => {
  t.mock.method(console, 'error', () => {});
  const original = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const currentUrl =
    'https://november-1st-sable.vercel.app/?feed=radio&name=a%2Bb#camera=1%2C2';
  let actualUrl = currentUrl;
  const reloadCalls = [];
  const location = {
    reload(...args) {
      assert.equal(this, location);
      reloadCalls.push(args);
    },
  };
  for (const key of ['href', 'search', 'hash'])
    Object.defineProperty(location, key, {
      get() {
        throw new Error(`Recovery must not read location.${key}`);
      },
      set(value) {
        actualUrl = value;
        throw new Error(`Recovery must not set location.${key}`);
      },
    });
  try {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: location,
    });
    const { documentRef, nodes } = fixture();
    installWelcome({
      documentRef,
      loadApplication: () => {
        throw new Error('The stylesheet preload failed');
      },
    });
    nodes['du-continue'].click();
    await settle();
    assert.deepEqual(reloadCalls, []);
    nodes['du-continue'].click();
    await settle();
    assert.deepEqual(reloadCalls, [[]]);
    assert.equal(actualUrl, currentUrl);
    assertClosed(nodes);
  } finally {
    if (original) Object.defineProperty(globalThis, 'location', original);
    else delete globalThis.location;
  }
});

test('a blocked reload restores the recovery controls and still never retries the runtime in place', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { documentRef, nodes } = fixture();
  let loads = 0;
  let reloads = 0;
  installWelcome({
    documentRef,
    loadApplication: () => {
      loads++;
      throw new Error('Import failed');
    },
    reloadApplication: () => {
      reloads++;
      throw new Error('Navigation blocked');
    },
  });
  nodes['du-continue'].click();
  await settle();
  nodes['du-continue'].click();
  await settle();
  assertClosed(nodes);
  assert.equal(nodes['du-new-user'].disabled, false);
  assert.equal(nodes['du-continue'].disabled, false);
  assert.equal(nodes['du-welcome'].getAttribute('aria-busy'), 'false');
  assert.equal(loads, 1);
  assert.equal(reloads, 1);
});

test('URL state and stored preferences cannot bypass welcome and are never read or overwritten', async () => {
  const guarded = ['window', 'location', 'localStorage', 'sessionStorage'];
  const originals = guarded.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);
  try {
    for (const key of guarded)
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get() {
          throw new Error(`Welcome must not access ${key}`);
        },
        set() {
          throw new Error(`Welcome must not replace ${key}`);
        },
      });
    const { documentRef, nodes } = fixture();
    for (const key of ['location', 'defaultView', 'cookie'])
      Object.defineProperty(documentRef, key, {
        get() {
          throw new Error(`Welcome must not access document.${key}`);
        },
        set() {
          throw new Error(`Welcome must not replace document.${key}`);
        },
      });
    let loads = 0;
    installWelcome({
      documentRef,
      loadApplication: async () => {
        loads++;
        return { startGodsEye() {} };
      },
    });
    await settle();
    assert.equal(loads, 0);
    assertClosed(nodes);
    nodes['du-new-user'].click();
    nodes['du-guide-back'].click();
    assert.equal(loads, 0);
    nodes['du-continue'].click();
    await settle();
    assert.equal(loads, 1);
    assert.equal(nodes['du-application'].hidden, false);
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('standalone startup disables the retired mission welcome overlay', async () => {
  const chrome = await readFile(
    new URL('../standalone/startupChrome.js', import.meta.url),
    'utf8',
  );
  assert.match(chrome, /initializeWelcome:\s*null/);
});
