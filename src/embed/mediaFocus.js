// The embed entry installs this owner before booting Earth. Standalone callers
// keep their original synchronous paths; this module never requests permission.
let activeGate = null;

export function isEmbedMediaFocusActive() {
  return activeGate !== null;
}

export function hasEmbedMediaFocus() {
  return activeGate?.hasFocus() === true;
}

export function guardedMediaFocus(reason = 'player-surface') {
  return activeGate ? activeGate.requestFocus(reason) : Promise.resolve(true);
}

/** An owner must provide positive quiet proof; pause alone is insufficient. */
export function registerMediaOwner(owner) {
  return activeGate?.register(owner) || (() => {});
}

export function installEmbedMediaFocus({ requestFocus, documentRef } = {}) {
  if (activeGate)
    throw new Error('An Earth media focus owner is already installed.');
  if (typeof requestFocus !== 'function')
    throw new TypeError('Media focus requires a parent acknowledgment port.');
  const owners = new Set();
  let epoch = 0;
  let focused = false;
  let destroyed = false;
  let quieting = false;
  let pending = null;
  let quietPending = null;

  const gate = {
    mediaPreflight: typeof documentRef?.querySelectorAll === 'function',
    hasFocus: () => focused && !destroyed && !quieting,
    register(owner) {
      if (destroyed || !owner || typeof owner.isQuiet !== 'function') {
        throw new TypeError(
          'A media owner must prove that its players are quiet.',
        );
      }
      owners.add(owner);
      return () => owners.delete(owner);
    },
    async requestFocus(reason = 'player-surface') {
      if (destroyed || quieting) return false;
      if (focused) return true;
      if (pending) return pending;
      const requestedEpoch = epoch;
      // A rejected, timed out, or obsolete grant never exposes a player.
      const attempt = Promise.resolve()
        .then(() =>
          requestFocus(
            reason === 'native-fullscreen' ? reason : 'player-surface',
          ),
        )
        .then(
          (granted) => {
            if (
              destroyed ||
              quieting ||
              epoch !== requestedEpoch ||
              granted !== true
            )
              return false;
            focused = true;
            return true;
          },
          () => false,
        );
      pending = attempt;
      try {
        return await attempt;
      } finally {
        if (pending === attempt) pending = null;
      }
    },
    async quiet() {
      if (quietPending) return quietPending;
      epoch += 1;
      focused = false;
      pending = null;
      quieting = true;
      const retiring = [...owners];
      const attempt = (async () => {
        const settled = await Promise.allSettled(
          retiring.map(async (owner) => {
            // Removing opaque frames terminates their browsing contexts; API pause
            // commands cannot prove that provider advertising or playback stopped.
            if (typeof owner.quiet === 'function') await owner.quiet();
            else if (typeof owner.destroy === 'function') await owner.destroy();
            else if (typeof owner.pause === 'function') await owner.pause();
            else throw new Error('This media owner cannot be stopped.');
            if (owner.isQuiet() !== true)
              throw new Error('Media state remains unknown.');
          }),
        );
        let blockedPlayerCount = settled.filter(
          (result) => result.status === 'rejected',
        ).length;
        try {
          // Native controls and opaque frames must be removed, not merely
          // paused. An unavailable audit never produces a positive QUIET ACK.
          if (typeof documentRef?.querySelectorAll !== 'function')
            blockedPlayerCount += 1;
          else
            blockedPlayerCount += [
              ...documentRef.querySelectorAll('audio,video,iframe'),
            ].length;
          for (const owner of owners) {
            if (!retiring.includes(owner) && owner.isQuiet() !== true)
              blockedPlayerCount += 1;
          }
        } catch {
          blockedPlayerCount += 1;
        }
        return {
          quiet: blockedPlayerCount === 0,
          blockedPlayerCount: Math.min(32, blockedPlayerCount),
        };
      })();
      quietPending = attempt;
      try {
        return await attempt;
      } finally {
        if (quietPending === attempt) {
          quietPending = null;
          quieting = false;
        }
      }
    },
    destroy() {
      const stopping = gate.quiet();
      destroyed = true;
      if (activeGate === gate) activeGate = null;
      return stopping.finally(() => owners.clear());
    },
  };
  activeGate = gate;
  return gate;
}
