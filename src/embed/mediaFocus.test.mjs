import test from 'node:test';
import assert from 'node:assert/strict';
import {
  guardedMediaFocus,
  hasEmbedMediaFocus,
  installEmbedMediaFocus,
  isEmbedMediaFocusActive,
  registerMediaOwner,
} from './mediaFocus.js';

const emptyDocument = { querySelectorAll: () => [] };

test('standalone media keeps its original permission and playback path', async () => {
  assert.equal(isEmbedMediaFocusActive(), false);
  assert.equal(await guardedMediaFocus(), true);
  assert.equal(hasEmbedMediaFocus(), false);
});

test('players wait for positive parent ACK; parallel mounts share one preflight', async () => {
  let grant;
  const reasons = [];
  const gate = installEmbedMediaFocus({
    documentRef: emptyDocument,
    requestFocus: (reason) => {
      reasons.push(reason);
      return new Promise((resolve) => {
        grant = resolve;
      });
    },
  });
  try {
    const first = guardedMediaFocus('directory-radio');
    const second = guardedMediaFocus('globe-camera-player');
    await Promise.resolve();
    assert.equal(hasEmbedMediaFocus(), false);
    assert.deepEqual(reasons, ['player-surface']);
    grant(true);
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(hasEmbedMediaFocus(), true);
  } finally {
    await gate.destroy();
  }
});

test('QUIET revokes a pending grant, so late parent ACK cannot revive playback', async () => {
  let grant;
  const gate = installEmbedMediaFocus({
    documentRef: emptyDocument,
    requestFocus: () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  });
  try {
    const mount = guardedMediaFocus();
    await Promise.resolve();
    assert.deepEqual(await gate.quiet(), {
      quiet: true,
      blockedPlayerCount: 0,
    });
    grant(true);
    assert.equal(await mount, false);
    assert.equal(hasEmbedMediaFocus(), false);
  } finally {
    await gate.destroy();
  }
});

test('denial, unknown ACK and transport rejection all keep surfaces closed', async () => {
  for (const answer of [
    false,
    undefined,
    { captureStopped: true },
    new Error('expired'),
  ]) {
    const gate = installEmbedMediaFocus({
      documentRef: emptyDocument,
      requestFocus: () =>
        answer instanceof Error ? Promise.reject(answer) : answer,
    });
    try {
      assert.equal(await guardedMediaFocus(), false);
      assert.equal(hasEmbedMediaFocus(), false);
    } finally {
      await gate.destroy();
    }
  }
});

test('QUIET stops every owner even if one fails, and unknown state cannot be acknowledged', async () => {
  const gate = installEmbedMediaFocus({
    documentRef: emptyDocument,
    requestFocus: () => true,
  });
  let firstStopped = false;
  let lastStopped = false;
  registerMediaOwner({
    pause: () => {
      firstStopped = true;
    },
    isQuiet: () => firstStopped,
  });
  registerMediaOwner({
    destroy: () => {
      throw new Error('provider unavailable');
    },
    isQuiet: () => false,
  });
  registerMediaOwner({
    pause: () => {
      lastStopped = true;
    },
    isQuiet: () => lastStopped,
  });
  try {
    assert.equal(await guardedMediaFocus(), true);
    assert.deepEqual(await gate.quiet(), {
      quiet: false,
      blockedPlayerCount: 1,
    });
    assert.equal(firstStopped && lastStopped, true);
    assert.equal(hasEmbedMediaFocus(), false);
  } finally {
    await gate.destroy();
  }
});

test('attached opaque/native controls block QUIET until physically removed', async () => {
  let surfaces = [
    { tagName: 'IFRAME' },
    { tagName: 'VIDEO', paused: true, controls: true },
  ];
  const gate = installEmbedMediaFocus({
    documentRef: { querySelectorAll: () => surfaces },
    requestFocus: () => true,
  });
  registerMediaOwner({
    pause() {},
    isQuiet: () => true,
    getElements: () => surfaces,
  });
  try {
    assert.deepEqual(await gate.quiet(), {
      quiet: false,
      blockedPlayerCount: 2,
    });
    surfaces = [];
    assert.deepEqual(await gate.quiet(), {
      quiet: true,
      blockedPlayerCount: 0,
    });
  } finally {
    await gate.destroy();
  }
});

test('QUIET rejects overlapping activation until asynchronous owner teardown finishes', async () => {
  let finish;
  let stopped = false;
  let requests = 0;
  const gate = installEmbedMediaFocus({
    documentRef: emptyDocument,
    requestFocus: () => {
      requests++;
      return true;
    },
  });
  const unregister = registerMediaOwner({
    quiet: () =>
      new Promise((resolve) => {
        finish = () => {
          stopped = true;
          resolve();
        };
      }),
    isQuiet: () => stopped,
  });
  try {
    const quiet = gate.quiet();
    assert.equal(await guardedMediaFocus(), false);
    assert.equal(requests, 0);
    finish();
    assert.deepEqual(await quiet, { quiet: true, blockedPlayerCount: 0 });
    unregister();
    assert.equal(await guardedMediaFocus(), true);
  } finally {
    unregister();
    await gate.destroy();
  }
});

test('an unavailable native-surface audit never claims complete media preflight or QUIET', async () => {
  const gate = installEmbedMediaFocus({ requestFocus: () => true });
  try {
    assert.equal(gate.mediaPreflight, false);
    assert.deepEqual(await gate.quiet(), {
      quiet: false,
      blockedPlayerCount: 1,
    });
  } finally {
    await gate.destroy();
  }
});

test('overlapping QUIET calls share teardown and cannot end its activation lock early', async () => {
  let finish;
  let stopped = false;
  let stops = 0;
  const gate = installEmbedMediaFocus({
    documentRef: emptyDocument,
    requestFocus: () => true,
  });
  const unregister = registerMediaOwner({
    quiet: () => {
      stops++;
      return new Promise((resolve) => {
        finish = () => {
          stopped = true;
          resolve();
        };
      });
    },
    isQuiet: () => stopped,
  });
  try {
    const first = gate.quiet();
    const second = gate.quiet();
    assert.equal(stops, 1);
    assert.equal(await guardedMediaFocus(), false);
    finish();
    assert.deepEqual(await first, { quiet: true, blockedPlayerCount: 0 });
    assert.deepEqual(await second, { quiet: true, blockedPlayerCount: 0 });
  } finally {
    unregister();
    await gate.destroy();
  }
});

test('a large unknown-player audit stays fail-closed within the bridge count bound', async () => {
  const gate = installEmbedMediaFocus({
    documentRef: {
      querySelectorAll: () => Array.from({ length: 100 }, () => ({})),
    },
    requestFocus: () => true,
  });
  try {
    assert.deepEqual(await gate.quiet(), {
      quiet: false,
      blockedPlayerCount: 32,
    });
  } finally {
    await gate.destroy();
  }
});
