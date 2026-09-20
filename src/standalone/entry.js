import { createStandaloneApplication } from './application.js';
import { describeError } from './errors.js';
import {
  installDreamUnityChrome,
  showStartupFailure,
} from '../dream-unity/chrome.js';
import { installLiveFeeds } from '../dream-unity/liveFeeds.js';
import { createGlobeFeedActions } from '../dream-unity/globeFeeds.js';

let application;
let started = false;

function reportStartupFailure(error) {
  console.error("God's Eye View initialization failed:", error);
  showStartupFailure({ message: describeError(error), errors: error?.errors });
}

/** Start the complete runtime once, after the visitor chooses Continue. */
export function startGodsEye() {
  if (started) return application;
  started = true;
  try {
    application = createStandaloneApplication({
      googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
      cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
      allowQaRegistration: import.meta.env.DEV,
    });
    const globeFeeds = createGlobeFeedActions(application);
    const liveFeeds = installLiveFeeds({
      openOnGlobe: globeFeeds.openOnGlobe,
      beforeRadioPlay: globeFeeds.beforeRadioPlay,
    });
    installDreamUnityChrome({
      onOpenFeed: (kind, opener) => liveFeeds.open(kind, opener),
    });
    const initialFeed = new URLSearchParams(window.location.search).get('feed');
    if (['radio', 'cctv', 'traffic'].includes(initialFeed))
      liveFeeds.open(initialFeed);

    application.start().catch(reportStartupFailure);
  } catch (error) {
    // Construction owns the page once. Recover with Reload rather than promise
    // a second construction after a partially initialized runtime.
    reportStartupFailure(error);
  }
  return application;
}
