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
    let loads = 0;
    let starts = 0;
    installWelcome({
      documentRef,
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
    assert.equal(nodes['du-welcome'].hidden, true);
    assert.equal(nodes['du-application'].hidden, false);
    assert.equal(nodes['du-application'].inert, false);
    nodes['du-continue'].dispatchEvent(new Event('click'));
    await settle();
    assert.equal(loads, 1);
    assert.equal(starts, 1);
  });
}

test('an import failure keeps the welcome visible, announces recovery and permits one retry', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { documentRef, nodes } = fixture();
  let loads = 0;
  let starts = 0;
  installWelcome({
    documentRef,
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
  assertClosed(nodes);
  assert.ok(nodes['du-welcome-status'].textContent.trim());
  assert.equal(nodes['du-continue'].disabled, false);
  assert.equal(nodes['du-guide-continue'].disabled, false);
  nodes['du-continue'].click();
  await settle();
  assert.equal(loads, 2);
  assert.equal(starts, 1);
  assert.equal(nodes['du-welcome'].hidden, true);
});

test('an initializer that throws restores the gate instead of leaving an empty application visible', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { documentRef, nodes } = fixture();
  let starts = 0;
  installWelcome({
    documentRef,
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
  assert.equal(starts, 2);
  assert.equal(nodes['du-application'].hidden, false);
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
