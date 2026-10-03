import test from 'node:test';
import assert from 'node:assert/strict';
import { ShareLinkManager } from '../sharelink.js';
import { validateSnapshot } from './snapshot.js';

test('current owned share snapshot roundtrips without mutating history and reports unsaved state', () => {
  globalThis.window = {
    location: { hash: '#old', href: 'https://earth.example/#old' },
  };
  let writes = 0;
  globalThis.history = {
    replaceState() {
      writes++;
    },
  };
  const manager = new ShareLinkManager({
    camera: {
      changed: { addEventListener: () => () => {} },
      positionCartographic: { latitude: -0.3, longitude: 0.9, height: 10000 },
      heading: 1,
      pitch: -0.5,
      roll: 0,
    },
  });
  const snapshot = manager.exportSnapshot({
    feed: 'radio',
    hasUnsavedState: true,
  });
  assert.equal(validateSnapshot(snapshot), true);
  assert.equal(writes, 0);
  assert.equal(window.location.hash, '#old');
  window.location.hash = '#' + snapshot.hashParams;
  const parsed = manager.parseInitialHash();
  assert.ok(Math.abs(parsed.lat - -17.1887) < 0.0001);
  assert.equal(parsed.alt, 10000);
  assert.equal(snapshot.hasUnsavedState, true);
  assert.equal(snapshot.feed, 'radio');
  manager.destroy();
});

test('snapshot rejects arbitrary navigation fields, duplicates and malformed/out-of-range coordinates', () => {
  const snapshot = {
    format: 'gev-share-v2',
    hashParams: 'v=2&lat=1&lon=2',
    feed: null,
    hasUnsavedState: false,
  };
  assert.equal(validateSnapshot(snapshot), true);
  for (const hashParams of [
    'v=2&lat=1&lon=2&url=https://evil.example',
    'v=2&lat=1&lat=2&lon=2',
    'v=2&lat=Infinity&lon=2',
    'v=2&lat=90.1&lon=2',
    'v=2&lat=1junk&lon=2',
    'lat=1&lon=2',
    'v=2&lon=2',
  ])
    assert.equal(
      validateSnapshot({ ...snapshot, hashParams }),
      false,
      hashParams,
    );
});
