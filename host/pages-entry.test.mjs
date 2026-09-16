import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expandApplicationHtml } from '../build/application-html.js';
import { stripPagesEntry } from '../build/pages-entry.js';

const source = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const appUrl = 'https://november-1st-sable.vercel.app/';

function entryBlock(name) {
  const match = source.match(
    new RegExp(
      `<!-- du:pages-entry-${name}:start -->[\\s\\S]*?<!-- du:pages-entry-${name}:end -->`,
    ),
  );
  assert.ok(match, `Source document must contain the ${name} Pages entry`);
  return match[0];
}

function inlineScripts(markup) {
  return [...markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map(
    ([, attributes, code]) => {
      assert.doesNotMatch(attributes, /\bsrc\s*=|\btype\s*=\s*["']module["']/i);
      return code;
    },
  );
}

function executeEntry(name, address) {
  const current = new URL(address);
  const destinations = [];
  const location = {
    origin: current.origin,
    href: current.href,
    hostname: current.hostname,
    pathname: current.pathname,
    search: current.search,
    hash: current.hash,
    replace(destination) {
      destinations.push(String(destination));
    },
  };
  const link = {
    href: appUrl,
    setAttribute(name, value) {
      this[name] = value;
    },
  };
  const document = {
    getElementById(id) {
      return id === 'du-pages-open' ? link : null;
    },
  };
  const scripts = inlineScripts(entryBlock(name));
  assert.ok(scripts.length, `The ${name} Pages entry must contain its script`);
  const window = { location, document };
  for (const script of scripts) {
    runInNewContext(
      script,
      { window, location, document, URL },
      { timeout: 500 },
    );
  }
  return { destinations, link };
}

test('raw GitHub Pages document navigates to the full application with exact shared state', () => {
  const query = '?source=Dream%20Unity&label=a%2Bb&empty=';
  const hash = '#lat=-37.81&lon=144.96&alt=800&heading=0&style=nvg&ui=c%2Cl';
  for (const path of ['/November-1st/', '/November-1st/index.html']) {
    const { destinations } = executeEntry(
      'head',
      `https://dream-unity.github.io${path}${query}${hash}`,
    );
    assert.deepEqual(destinations, [appUrl + query + hash]);
  }
  assert.ok(
    source.indexOf(entryBlock('head')) < source.indexOf('src="/src/main.js"'),
    'The classic navigation script must run before the raw Vite entry',
  );
});

test('shared state cannot replace the fixed application origin', () => {
  const query = '?redirect=https%3A%2F%2Fevil.example%2F&next=//evil.example';
  const hash = '#https://evil.example/?lat=1';
  const { destinations } = executeEntry(
    'head',
    `https://dream-unity.github.io/November-1st/${query}${hash}`,
  );
  assert.deepEqual(destinations, [appUrl + query + hash]);
  assert.equal(new URL(destinations[0]).origin, new URL(appUrl).origin);
});

test('application origin does not navigate back to itself', () => {
  const { destinations } = executeEntry(
    'head',
    `${appUrl}?source=pages#lat=-37.81&lon=144.96`,
  );
  assert.deepEqual(destinations, []);
});

test('manual fallback exists without JavaScript and retains shared state when enhanced', () => {
  const body = entryBlock('body');
  const staticMarkup = body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  assert.match(staticMarkup, /id="du-pages-entry"/);
  const linkTag = staticMarkup.match(
    /<a\b[^>]*\bid="du-pages-open"[^>]*>/i,
  )?.[0];
  assert.ok(linkTag, 'The source document must expose a real manual link');
  assert.ok(linkTag.includes(`href="${appUrl}"`));
  assert.doesNotMatch(linkTag, /\bhidden\b|display\s*:\s*none/i);
  const query = '?source=pages&name=a%2Bb';
  const hash = '#lat=50.45&lon=30.52&target=abc123';
  const { link } = executeEntry(
    'body',
    `https://dream-unity.github.io/November-1st/${query}${hash}`,
  );
  assert.equal(link.href, appUrl + query + hash);
});

test('application HTML expansion removes the gateway while retaining the complete upstream shell', () => {
  const html = expandApplicationHtml(source);
  assert.doesNotMatch(html, /du:pages-entry|du-pages-entry|du-pages-open/);
  assert.doesNotMatch(html, /location\.replace\(/);
  assert.doesNotMatch(html, /gev:template/);
  assert.match(html, /id="cesiumContainer"/);
  assert.match(html, /id="first-run-launcher"/);
  assert.match(html, /id="control-panel"/);
  assert.match(html, /type="module" src="\/src\/main\.js"/);
});

test('gateway stripping rejects incomplete and duplicate marker blocks', () => {
  const head = entryBlock('head');
  const body = entryBlock('body');
  assert.throws(() =>
    stripPagesEntry(head.replace('<!-- du:pages-entry-head:end -->', '')),
  );
  assert.throws(() =>
    stripPagesEntry(head.replace('<!-- du:pages-entry-head:start -->', '')),
  );
  assert.throws(() => stripPagesEntry(`${head}\n${head}\n${body}`));
  assert.equal(
    stripPagesEntry('<!doctype html><title>Fixture</title>'),
    '<!doctype html><title>Fixture</title>',
  );
});
