import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCatalog } from './catalog.js';
import { createPresentation } from './presentation.js';
import { createFrames } from './frames.js';
import { createProjection } from './projection.js';
import { createCards } from './cards.js';
import { normalizeFeedType, isVideoFeedType } from '../../sources/cctvTypes.js';

test('the globe catalogue and public panel state retain global publisher metadata without constructing proxy frame URLs', () => {
  const state = { _healthById: new Map() };
  const frames = createFrames({
    state,
    services: {},
    parts: {},
    source: {
      getFrameUrl: () => assert.fail('an embedded player has no frame proxy'),
      getMediaUrl: () => assert.fail('an embedded player has no media proxy'),
    },
  });
  const model = {
    safeNumber: (value, fallback) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    normalizeHeading: (value) => value,
    clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
    headingFromId: () => 0,
    normalizeFeedType,
    ensureCameraPose() {},
  };
  const catalog = createCatalog({
    state,
    services: { locations: { CITY_POIS: {} } },
    parts: { model },
  });
  const raw = {
    id: 'public-japan',
    name: 'Public city camera',
    city: 'Tokyo',
    country: 'Japan',
    countryName: 'Japan',
    countryCode: 'JP',
    lat: 35.7,
    lon: 139.7,
    feedType: 'embed',
    playbackKind: 'live',
    liveOnly: true,
    embedUrl: 'https://www.youtube.com/embed/abcdefghijk',
    sourcePage: 'https://publisher.example/camera',
    verifiedAt: '2026-09-17T12:00:00.000Z',
  };
  const [camera] = catalog.buildCatalogFromSources([raw]);
  const presentation = createPresentation({
    state,
    services: {},
    parts: {
      frames,
      calibration: {
        normalizeCalibration: () => ({}),
        deriveCalBadge: () => 'raw-prior',
      },
    },
  });
  const publicState = presentation.getPublicCameraState({ camera }, camera.id);
  for (const field of [
    'country',
    'countryName',
    'countryCode',
    'sourcePage',
    'verifiedAt',
    'liveOnly',
  ]) {
    assert.equal(publicState[field], raw[field]);
  }
  assert.equal(
    publicState.embedUrl,
    'https://www.youtube-nocookie.com/embed/abcdefghijk',
  );
  assert.equal(publicState.playbackKind, 'live');
  assert.equal(publicState.frameUrl, null);
  assert.equal(publicState.mediaUrl, null);
  const strictHls = { ...camera, feedType: 'hls', liveOnly: true };
  assert.equal(frames.frameUrlFor(strictHls), null);
});

test('official camera embeds retain a labelled globe placeholder without creating image, video or iframe textures', (t) => {
  const previousDocument = globalThis.document;
  const previousImage = globalThis.Image;
  const painted = [];
  const canvas = { getContext: () => ({}) };
  globalThis.document = {
    createElement(name) {
      assert.equal(
        name,
        'canvas',
        'only the labelled placeholder belongs to the globe',
      );
      return canvas;
    },
  };
  globalThis.Image = class {
    constructor() {
      assert.fail('embed cannot request a snapshot');
    }
  };
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.Image = previousImage;
  });
  const state = {
    _viewer: { entities: new Cesium.EntityCollection() },
    _cctvOverlayHost: { clearSource() {}, setVisible() {} },
  };
  const record = {
    camera: { id: 'official', name: 'Official live camera', feedType: 'embed' },
    frustumGeometry: { halfW: 1, halfH: 1 },
    frustumPositions: {
      capCenter: new Cesium.Cartesian3(1, 2, 3),
      label: new Cesium.Cartesian3(1, 2, 4),
    },
  };
  const projection = createProjection({
    state,
    services: { render: {} },
    parts: {
      model: {
        normalizeFeedType,
        isVideoFeedType,
        planeOrientationFor: () => Cesium.Quaternion.IDENTITY,
      },
      frames: {
        paintProjectionPlaceholder: (_ctx, _camera, status) =>
          painted.push(status),
      },
    },
  });
  const runtime = projection.createProjectionRuntime(record);
  assert.equal(runtime.mode, 'embed');
  assert.equal(runtime.image, null);
  assert.equal(runtime.video, null);
  assert.equal(runtime.playback, null);
  assert.equal(runtime.planeMaterial.image.getValue(), canvas);
  assert.match(painted[0].message, /camera panel.*projection is unavailable/);
  assert.deepEqual(runtime.overlayEntry.details, [painted[0].message]);
  projection.destroyProjectionRuntime(runtime);
  assert.equal(state._viewer.entities.values.length, 0);
});

test('even a hover or stale ambient-card request cannot fetch a frame for an official embedded camera', (t) => {
  const previousImage = globalThis.Image;
  globalThis.Image = class {
    constructor() {
      assert.fail('embed cannot create a snapshot request');
    }
  };
  t.after(() => {
    globalThis.Image = previousImage;
  });
  const state = {};
  const cards = createCards({ state, services: {}, parts: {} });
  cards.fetchCardFrame(
    { camera: { id: 'official', feedType: 'embed' } },
    {},
    1000,
    { userGesture: true },
  );
  cards.fetchCardFrame(
    { camera: { id: 'live-only', feedType: 'hls', liveOnly: true } },
    {}, 1000, { userGesture: true },
  );
  assert.deepEqual(
    state,
    {},
    'no fetch counters, pending work or frame cache was created',
  );
});
