import test from 'node:test';
import assert from 'node:assert/strict';
import { DataLayerManager } from './manager.js';

test('background polling pause preserves layers, blocks queued ticks, and resumes exactly one timer', async () => {
  const originalSet = globalThis.setInterval,
    originalClear = globalThis.clearInterval;
  const timers = new Map();
  let next = 0,
    updates = 0;
  globalThis.setInterval = (callback) => {
    const id = ++next;
    timers.set(id, callback);
    return id;
  };
  globalThis.clearInterval = (id) => timers.delete(id);
  const manager = new DataLayerManager({});
  manager.register({
    id: 'flights',
    name: 'Flights',
    updateInterval: 1000,
    init() {},
    enable() {},
    disable() {},
    update() {
      updates++;
    },
    getStats: () => ({ count: 0 }),
  });
  try {
    await manager.setEnabled('flights', true);
    assert.equal(timers.size, 1);
    const queuedTick = [...timers.values()][0],
      before = updates;
    manager.setPollingSuspended(true);
    manager.setPollingSuspended(true);
    assert.equal(timers.size, 0);
    assert.equal(manager.isEnabled('flights'), true);
    queuedTick();
    await Promise.resolve();
    assert.equal(updates, before);
    manager.setPollingSuspended(false);
    manager.setPollingSuspended(false);
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    await Promise.resolve();
    assert.equal(updates, before + 1);
    await manager.destroyAll();
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});
