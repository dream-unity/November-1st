import { startGodsEye, getStandalonePorts } from './entry.js';
import { createGevActionRunner } from '../voice/gevActions.js';
import { readDeploymentStatus } from '../dream-unity/status.js';
import { validateSnapshot } from '../embed/snapshot.js';

export async function createEmbeddedRuntime({ restore, onHome }) {
  if (!validateSnapshot(restore)) throw new Error('Invalid Earth snapshot');
  if (restore) {
    // Only supported hash data reaches the owned share parser, never a host URL.
    const url = new URL(window.location.href);
    url.hash = restore.hashParams;
    if (restore.feed) url.searchParams.set('feed', restore.feed);
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  const shell = document.getElementById('du-application');
  shell.hidden = false;
  shell.inert = false;
  document.getElementById('du-embed-waiting').hidden = true;
  startGodsEye({ onHome });
  const ports = getStandalonePorts();
  if (!ports) throw new Error('Earth ports unavailable');
  let runner,
    components,
    destroyed = false;
  const lifetime = new AbortController();
  const cameraOwners = new Set();
  const syncDocumentVisibility = () =>
    components?.data?.dataManager?.setPollingSuspended?.(
      document.hidden === true,
    );
  document.addEventListener?.('visibilitychange', syncDocumentVisibility);
  let feed = restore?.feed ?? null;
  const statusPromise = readDeploymentStatus({ signal: lifetime.signal })
    .then(({ providers }) =>
      providers.slice(0, 32).map((provider) => ({
        id: String(provider.id).slice(0, 80),
        // Configuration is not evidence that a live provider returned usable data.
        status: [
          'not-configured',
          'protected',
          'requires-persistent-service',
          'unavailable',
        ].includes(provider.status)
          ? provider.status
          : 'unknown',
      })),
    )
    .catch(() => [{ id: 'provider-status', status: 'unavailable' }]);
  function snapshot() {
    const manager = components?.controls?.styleManager?.shareLinkManager;
    // Serializer omits projects/forms/drawing. Be conservative about unsaved state.
    return manager?.exportSnapshot({ feed, hasUnsavedState: true }) ?? null;
  }
  return {
    snapshot,
    async ready() {
      const value = await ports.ready();
      if (destroyed) throw new Error('Earth closed during startup');
      components = value.components;
      syncDocumentVisibility();
      const { scene, controls, data, tools } = components;
      runner = createGevActionRunner({
        viewer: scene.viewer,
        styleManager: controls.styleManager,
        dataManager: data.dataManager,
        sceneDirector: tools.sceneDirector,
        annotations: tools.annotations,
        placeSearch: ports.getPlaceSearch(),
        floorServices: scene.operations.surface.groundFloor,
        annotationResolver: scene.operations.annotationResolver,
        searchNavigation: scene.operations.searchAndFlyTo,
      });
      const restoration = value.restoration;
      const restoreStatus =
        restoration.status === 'not-requested'
          ? 'none'
          : restoration.status === 'failed'
            ? 'failed'
            : restoration.share?.camera === 'applied'
              ? 'applied'
              : 'superseded';
      return {
        app: 'ready',
        globe: 'ready',
        restore: restoreStatus,
        providers: await statusPromise,
      };
    },
    cancel() {
      // Abort only camera work this adapter still owns. A later native user
      // handoff must keep its flight even if the host cancels an older turn.
      for (const owner of cameraOwners) if (owner.isOwned()) owner.abort();
    },
    async command(tool, options) {
      if (!runner || destroyed || !options.isCurrent())
        return {
          status: 'blocked',
          code: 'EARTH_NOT_READY',
          message: 'The globe is not ready.',
        };
      if (tool.name === 'earth_open_feed') {
        await ports.openFeed(tool.args.kind);
        if (!options.isCurrent())
          return {
            status: 'superseded',
            code: 'FEED_SUPERSEDED',
            message: 'A newer action replaced opening this directory.',
          };
        feed = tool.args.kind;
        return {
          status: 'applied',
          code: 'DIRECTORY_OPENED',
          message: `${feed === 'cctv' ? 'Camera' : feed === 'radio' ? 'Radio' : 'Traffic'} directory opened. No stream playback or availability is implied.`,
        };
      }
      const names = {
        earth_fly_to_location: 'fly_to_location',
        earth_fly_to_coordinates: 'fly_to_location',
        earth_zoom_to_globe: 'zoom_to_globe',
        earth_set_layer_visibility: 'set_layer_visibility',
        earth_set_visual_style: 'set_visual_style',
        earth_get_view: 'get_current_view_state',
      };
      const name = names[tool.name];
      if (!name)
        return {
          status: 'rejected',
          code: 'UNKNOWN_TOOL',
          message: 'This Earth action is unavailable.',
        };
      const camera =
        tool.name === 'earth_fly_to_location' ||
        tool.name === 'earth_fly_to_coordinates' ||
        tool.name === 'earth_zoom_to_globe';
      const local = new AbortController();
      const signal = AbortSignal.any([options.signal, local.signal]);
      let ownsNavigation = true;
      const owner = {
        isOwned: () => ownsNavigation,
        abort: () => local.abort('Host cancelled owned navigation'),
      };
      if (camera) cameraOwners.add(owner);
      const cancel = () => {
        if (camera && ownsNavigation)
          components.scene.viewer.camera.cancelFlight();
      };
      signal.addEventListener('abort', cancel, { once: true });
      let unsubscribe = () => {};
      try {
        const args =
          tool.name === 'earth_set_layer_visibility'
            ? { layerId: tool.args.layerId, enabled: tool.args.visible }
            : camera && name === 'fly_to_location'
              ? { ...tool.args, waitForArrival: true }
              : tool.args;
        const pending = runner(name, args, {
          ...options,
          signal,
          isCurrent: () =>
            options.isCurrent() && ownsNavigation && !local.signal.aborted,
        });
        // The runner synchronously claims its initial generation before its first
        // await. Subsequent owner handoffs are user/newer action authority.
        if (camera)
          unsubscribe = components.controls.styleManager.subscribeCameraHandoff(
            () => {
              ownsNavigation = false;
              local.abort('Camera ownership changed');
            },
          );
        const outcome = await pending;
        if (!ownsNavigation)
          return {
            status: 'superseded',
            code: 'USER_NAVIGATION_WON',
            message: 'A newer camera action replaced this destination.',
          };
        if (!options.isCurrent())
          return {
            status: 'superseded',
            code: 'ACTION_SUPERSEDED',
            message: 'The requested action was replaced before completion.',
          };
        if (!outcome?.ok || outcome.cancelled)
          return {
            status: outcome?.cancelled ? 'cancelled' : 'blocked',
            code: 'ACTION_REFUSED',
            message: String(
              outcome?.error ??
                'The owned Earth controller did not apply this action.',
            ).slice(0, 400),
          };
        if (name === 'fly_to_location' && outcome.arrived !== true)
          return {
            status: 'unknown',
            code: 'ARRIVAL_UNCONFIRMED',
            message: 'Navigation started, but arrival was not confirmed.',
          };
        if (tool.name === 'earth_set_layer_visibility') {
          const state = components.data.dataManager.getLayerLifecycleState(
            tool.args.layerId,
          );
          if (!state || state.uncertain || state.enabled !== tool.args.visible)
            return {
              status: 'unknown',
              code: 'LAYER_STATE_UNCONFIRMED',
              message: 'Layer visibility could not be confirmed.',
            };
        }
        if (name === 'get_current_view_state') {
          const lat = outcome.camera?.latitude,
            lon = outcome.camera?.longitude;
          return {
            status: 'noop',
            code: 'VIEW_OBSERVED',
            message:
              Number.isFinite(lat) && Number.isFinite(lon)
                ? `Current view: ${lat.toFixed(4)}, ${lon.toFixed(4)}; style ${outcome.style}.`
                : 'Current view observed. The share snapshot contains supported state.',
          };
        }
        return {
          status: outcome.changed === false ? 'noop' : 'applied',
          code: camera ? 'ARRIVED' : 'STATE_APPLIED',
          message: camera
            ? 'The owned camera controller confirmed completion.'
            : 'The owned Earth controller confirmed the requested state.',
        };
      } finally {
        signal.removeEventListener('abort', cancel);
        unsubscribe();
        cameraOwners.delete(owner);
      }
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      lifetime.abort('Earth document closed');
      document.removeEventListener?.(
        'visibilitychange',
        syncDocumentVisibility,
      );
      for (const owner of cameraOwners) owner.abort();
      components?.scene?.viewer &&
        (components.scene.viewer.useDefaultRenderLoop = false);
      await ports.destroy();
    },
  };
}
