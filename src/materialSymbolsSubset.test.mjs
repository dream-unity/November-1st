import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = path.resolve(SRC_ROOT, '..');
const INDEX_HTML = path.join(REPO_ROOT, 'index.html');

/** The glyph written as element text: `<span class="material-symbols-outlined">radar</span>`. */
const SPAN_TEXT =
  /class="[^"]*material-symbols-outlined[^"]*"[^>]*>\s*([a-z0-9_]+)\s*</g;
/** A whole `textContent =` statement, across lines, so a multi-line ternary is read once. */
const TEXT_ASSIGNMENT = /(?:textContent|innerText)\s*=\s*([^;]{0,400})/gs;
const STRING_LITERAL = /['"`]([a-z0-9_]{2,})['"`]/g;
const COMPARISON_BEFORE = /(?:===|!==|==|!=|<=|>=|<|>)\s*$/;
const COMPARISON_AFTER = /^\s*(?:===|!==|==|!=|<=|>=|<|>)/;

/** Ignore condition values at every ternary depth, while retaining output glyphs. */
function assignedGlyphs(statement) {
  const normalized = statement.replaceAll('?.', '.');
  const assigned = normalized.includes('?')
    ? normalized.slice(normalized.indexOf('?') + 1)
    : normalized;
  return [...assigned.matchAll(STRING_LITERAL)]
    .filter((literal) => {
      const before = assigned.slice(0, literal.index);
      const after = assigned.slice(literal.index + literal[0].length);
      return !COMPARISON_BEFORE.test(before) && !COMPARISON_AFTER.test(after);
    })
    .map((literal) => literal[1]);
}

/**
 * Files that SHIP markup. Tests assert on markup, they do not render it.
 *
 * The panel markup lives in `src/ui/templates/*.html`, so HTML under `src` is
 * read as well: a glyph named only in a template is still a glyph the font has
 * to carry.
 */
function sourceFiles(directory = SRC_ROOT) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (
      entry.isFile() &&
      /\.(js|mjs|html)$/.test(entry.name) &&
      !entry.name.endsWith('.test.mjs')
    ) {
      files.push(absolute);
    }
  }
  return [...files.sort(), INDEX_HTML];
}

/**
 * Glyph names the sources ask the icon font for.
 *
 * Errs WIDE on purpose. A name the font does not carry costs nothing — Google
 * ignores an unknown `icon_names` entry and still returns 200 — while a glyph
 * the subset is missing breaks the interface SILENTLY: the ligature never
 * forms, so the element renders the literal word `right_panel_open` instead of
 * falling back to a visible box.
 *
 * A literal to the LEFT of a `?` is the condition being tested, not the text
 * being shown, so it is dropped: `status === 'loading' ? …` must not enrol
 * `loading`. Nested branches may contain further conditions, so comparison
 * operands on either side are excluded at every depth. Optional chaining is
 * neutralised first — `payload?.newsStatus`
 * is not a ternary, and splitting on its `?` would keep the condition.
 * @returns {Map<string, string>} glyph -> the first file that names it.
 */
function referencedGlyphs() {
  const found = new Map();
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    const add = (glyph) => {
      if (!found.has(glyph)) found.set(glyph, relative);
    };
    for (const match of source.matchAll(SPAN_TEXT)) add(match[1]);
    for (const match of source.matchAll(TEXT_ASSIGNMENT)) {
      for (const glyph of assignedGlyphs(match[1])) add(glyph);
    }
  }
  return found;
}

/** The `icon_names` list index.html asks Google for. */
function subsettedGlyphs(html = readFileSync(INDEX_HTML, 'utf8')) {
  const match =
    /Material\+Symbols\+Outlined[^"]*[?&]icon_names=([a-z0-9_,]+)/.exec(html);
  assert.ok(
    match,
    'index.html must request Material Symbols with an icon_names subset',
  );
  return new Set(match[1].split(','));
}

test('every glyph the sources render is in the icon_names subset', () => {
  const subset = subsettedGlyphs();
  const missing = [...referencedGlyphs()]
    .filter(([glyph]) => !subset.has(glyph))
    .map(([glyph, file]) => `${glyph} (${file})`);

  assert.deepEqual(
    missing,
    [],
    'Glyphs named by the sources but absent from the index.html icon_names list. ' +
      'Add them there — an unlisted glyph renders as its own name on screen: ' +
      missing.join(', '),
  );
});

test('the unused Material Icons Round family is not loaded', () => {
  // A second icon font, 173 kB, for a family no source ever uses — and
  // src/cockpitMarkup.test.mjs already asserts the markup must not use it.
  const html = readFileSync(INDEX_HTML, 'utf8');
  assert.doesNotMatch(
    html,
    /Material\+Icons\+Round/,
    'index.html loads an icon font nothing renders',
  );
});

test('glyph discovery excludes nested condition values while retaining every rendered glyph branch', () => {
  assert.deepEqual(
    assignedGlyphs(`
    kind === 'cctv'
      ? state?.status === 'live' ? 'play_arrow' : 'clip' === state.status ? 'movie' : 'videocam'
      : state.status === 'ready' ? 'pause' : 'stop'
  `),
    ['play_arrow', 'movie', 'videocam', 'pause', 'stop'],
  );
  assert.deepEqual(assignedGlyphs(`'play_arrow'`), ['play_arrow']);
  assert.deepEqual(assignedGlyphs(`'ready' === status`), []);
  assert.deepEqual(
    assignedGlyphs(`status !== 'ready' ? 'play_arrow' : 'pause'`),
    ['play_arrow', 'pause'],
  );
});
