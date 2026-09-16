import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import {
  installDreamUnityChrome,
  showStartupFailure,
} from './dream-unity/chrome.js';

installDreamUnityChrome();

const application = createStandaloneApplication({
  googleApiKey: import.meta.env.GOOGLE_MAPS_API_KEY,
  cesiumToken: import.meta.env.CESIUM_ION_TOKEN,
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  showStartupFailure({ message: describeError(error), errors: error?.errors });
});

export { application };
