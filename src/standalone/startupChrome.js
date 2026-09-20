import { startApplicationChrome } from '../app/startupChrome.js';
import { initKeySetup } from '../keySetup.js';
export function startStandaloneChrome(options) {
  return startApplicationChrome({
    // The entry screen already offers New User / Continue before startup.
    initializeWelcome: null,
    initializeSettings: initKeySetup,
    ...options,
  });
}
