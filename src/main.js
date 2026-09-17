import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import {
  installDreamUnityChrome,
  showStartupFailure,
} from './dream-unity/chrome.js';
import { installLiveFeeds } from './dream-unity/liveFeeds.js';
import { createGlobeFeedActions } from './dream-unity/globeFeeds.js';

const application = createStandaloneApplication({
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

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  showStartupFailure({ message: describeError(error), errors: error?.errors });
});

export { application };
