import { Cartesian3 } from 'cesium';

const FEED_KINDS = new Set(['radio', 'cctv', 'traffic']);

function handoffError(code, message) {
  return Object.assign(new Error(message), { code });
}

function readLocation(item) {
  const source = item?.position ?? item;
  if (!source || typeof source !== 'object') return null;
  const lat = Object.hasOwn(source, 'lat') ? source.lat : source.latitude;
  const lon = Object.hasOwn(source, 'lon') ? source.lon : source.longitude;
  return Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    Number.isFinite(lon) &&
    Math.abs(lon) <= 180
    ? { lat, lon }
    : null;
}

/** Connect the accessible feed directory to the full application's public ports. */
export function createGlobeFeedActions(application) {
  let generation = 0;

  function readReadyComponents() {
    if (application?.getState?.().status !== 'ready') return null;
    const components = application.getComponents?.();
    if (
      !components?.scene?.viewer?.camera ||
      !components?.controls?.styleManager?.beginDeferredLocationNavigation ||
      !components?.controls?.styleManager?.reassertDeferredLocationNavigation ||
      !components?.data?.dataManager ||
      !components?.data?.catalog?.get
    )
      return null;
    return components;
  }

  function requireReady() {
    const components = readReadyComponents();
    if (!components)
      throw handoffError(
        'GLOBE_NOT_READY',
        'The 3D globe is unavailable. You can still use the live feeds here. Reload the globe or enable WebGL to show this location.',
      );
    return components;
  }

  function isReady() {
    return readReadyComponents() !== null;
  }

  // A directory Play gesture must never leave the original globe tuner playing
  // underneath it. This is synchronous so the caller retains audio activation.
  function beforeRadioPlay() {
    const radio = application?.getComponents?.()?.data?.catalog?.get?.('radio');
    radio?.stopPlayback?.({ origin: 'user' });
  }

  async function openOnGlobe(kind, item, { signal } = {}) {
    signal?.throwIfAborted();
    if (!FEED_KINDS.has(kind))
      throw handoffError(
        'INVALID_FEED_KIND',
        'This feed cannot be shown on the globe.',
      );
    const position = readLocation(item);
    if (!position)
      throw handoffError(
        'INVALID_FEED_LOCATION',
        'This item does not have a valid map location.',
      );
    const id = item?.id;
    if (
      kind !== 'traffic' &&
      (typeof id !== 'string' || !id.trim() || id.length > 512)
    )
      throw handoffError(
        'INVALID_FEED_ITEM',
        'Choose a station or camera before showing it on the globe.',
      );
    const components = requireReady();
    const { viewer } = components.scene;
    const { styleManager } = components.controls;
    const { dataManager, catalog } = components.data;
    const requestedGeneration = ++generation;
    const navigationGeneration = styleManager.beginDeferredLocationNavigation();
    if (navigationGeneration === false)
      throw handoffError(
        'GLOBE_NAVIGATION_REFUSED',
        'Exit cockpit mode, then choose Show on globe again.',
      );
    signal?.throwIfAborted();
    const layer = kind === 'traffic' ? null : catalog.get(kind);
    if (kind !== 'traffic') {
      if (!layer)
        throw handoffError(
          'FEED_LAYER_UNAVAILABLE',
          'This globe layer is unavailable.',
        );
      await dataManager.setEnabled(kind, true, { origin: 'user' });
    }

    // Loading a catalogue must not let an old click override a newer target,
    // a disabled layer, or application teardown.
    signal?.throwIfAborted();
    const current = requireReady();
    if (
      requestedGeneration !== generation ||
      current.scene.viewer !== viewer ||
      current.data.dataManager !== dataManager
    )
      throw handoffError(
        'FEED_HANDOFF_SUPERSEDED',
        'A newer globe action replaced this request.',
      );
    const lifecycle = layer ? dataManager.getLayerLifecycleState?.(kind) : null;
    if (
      layer &&
      (!dataManager.isEnabled(kind) ||
        lifecycle?.uncertain ||
        (lifecycle && lifecycle.lifecycleState !== 'enabled'))
    )
      throw handoffError(
        'FEED_LAYER_DISABLED',
        'The globe layer was switched off. Try Show on globe again.',
      );

    if (!styleManager.reassertDeferredLocationNavigation(navigationGeneration))
      throw handoffError(
        'GLOBE_NAVIGATION_REFUSED',
        'Globe navigation changed while this feed loaded. Exit cockpit mode if active, then choose Show on globe again.',
      );
    signal?.throwIfAborted();
    const result = (() => {
      let selected = false;
      let message = null;
      if (kind === 'radio') {
        dataManager.setLayerParams(kind, { filter: 'all' }, { origin: 'user' });
        selected = layer.selectStation(id, {
          autoplay: false,
          focus: true,
          origin: 'user',
        });
        styleManager.setPanelCollapsed('radio-panel', false, {
          explicit: true,
        });
        if (!selected)
          message =
            'Station location shown. This station is outside the globe tuner catalogue; listen using Live radio.';
      } else if (kind === 'cctv') {
        selected = layer.selectCamera(id, { focus: false });
        if (selected) {
          dataManager.setLayerParams(
            kind,
            { selectedCameraId: id },
            { origin: 'user' },
          );
          const focused = layer.focusCamera(id, 1.6);
          if (focused !== 'focused')
            throw handoffError(
              'CAMERA_FOCUS_UNAVAILABLE',
              'The camera could not be shown on the globe. Try again after exiting cockpit mode.',
            );
        } else {
          message =
            'Camera location shown. This camera is outside the globe catalogue; view its feed using CCTV.';
        }
        styleManager.setPanelCollapsed('cctv-panel', false, { explicit: true });
      }
      if (!selected) {
        // Traffic reports are real incidents. Showing one must not silently
        // enable the separate Street Traffic animation or imply tracked cars.
        viewer.camera.flyTo({
          destination: Cartesian3.fromDegrees(
            position.lon,
            position.lat,
            kind === 'radio' ? 85_000 : 8_000,
          ),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          duration: 1.6,
        });
      }
      return { opened: true, selected: Boolean(selected), message };
    })();
    return result;
  }

  return Object.freeze({ isReady, beforeRadioPlay, openOnGlobe });
}
