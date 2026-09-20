import { installWelcome } from './dream-unity/welcome.js';

// Retain the public binding used by local QA; it is created only on Continue.
export let application;

installWelcome({
  loadApplication: async () => {
    const runtime = await import('./standalone/entry.js');
    return {
      startGodsEye() {
        application = runtime.startGodsEye();
      },
    };
  },
});
