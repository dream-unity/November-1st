import { createStandaloneApplication } from './application.js';
import { describeError } from './errors.js';
import {
  installDreamUnityChrome,
  showStartupFailure,
} from '../dream-unity/chrome.js';
import { installLiveFeeds } from '../dream-unity/liveFeeds.js';
import { createGlobeFeedActions } from '../dream-unity/globeFeeds.js';
import '../dream-unity/earth-theme.css';

let application;
let started = false;
let ports = null;
let entryOptions = {};
let disposeChrome = () => {};
let liveFeeds;
let placeSearch;
let startup;

function reportStartupFailure(error) {
  console.error("God's Earth View initialization failed:", error);
  showStartupFailure({
    message: describeError(error),
    errors: error?.errors,
    onHome: entryOptions.onHome,
  });
}

/** Start the complete runtime once, after the visitor chooses Continue. */
export function startGodsEye(options = {}) {
  if (started) return application;
  started = true;
  entryOptions = options;
  try {
    application = createStandaloneApplication({
      googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
      cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
      voice: false,
      allowQaRegistration: import.meta.env.DEV,
      onPlaceSearch: (search) => {
        placeSearch = search;
      },
    });
    const globeFeeds = createGlobeFeedActions(application);
    liveFeeds = installLiveFeeds({
      openOnGlobe: globeFeeds.openOnGlobe,
      beforeRadioPlay: globeFeeds.beforeRadioPlay,
    });
    disposeChrome = installDreamUnityChrome({
      onOpenFeed: (kind, opener) => liveFeeds.open(kind, opener),
      onHome: options.onHome,
    });
    const initialFeed = new URLSearchParams(window.location.search).get('feed');
    if (['radio', 'cctv', 'traffic'].includes(initialFeed))
      liveFeeds.open(initialFeed);

    startup = application.start();
    startup.catch(reportStartupFailure);
    ports = {
      application,
      ready: async () => {
        const components = await startup;
        const restoration =
          await components.controls.styleManager.initialRestorePromise;
        return { components, restoration };
      },
      getPlaceSearch: () => placeSearch,
      openFeed: (kind) => liveFeeds.open(kind),
      destroy: async () => {
        // Chrome and feed directories are entry-owned, outside app constructors.
        liveFeeds?.destroy();
        disposeChrome();
        await application.destroy();
      },
    };
  } catch (error) {
    // Construction owns the page once. Recover with Reload rather than promise
    // a second construction after a partially initialized runtime.
    reportStartupFailure(error);
  }
  return application;
}

/** Narrow owned ports for the trusted embedded host; no debug globals required. */
export function getStandalonePorts() {
  return ports;
}
