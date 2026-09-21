import { installWelcome } from './dream-unity/welcome.js';
import { createCesiumLoader } from './dream-unity/loadCesium.js';

// Retain the public binding used by local QA; it is created only on Continue.
export let application;

const loadCesium = createCesiumLoader({
  source: `${import.meta.env.BASE_URL}cesium/Cesium.js`,
});

installWelcome({
  loadApplication: async () => {
    // Vite serves Cesium as normal module imports during development. The
    // production build externalizes it to this same-origin classic script.
    if (import.meta.env.PROD) await loadCesium();
    const runtime = await import('./standalone/entry.js');
    return {
      startGodsEye() {
        application = runtime.startGodsEye();
      },
    };
  },
});
