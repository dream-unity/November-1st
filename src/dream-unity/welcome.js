/** Keep the full application dormant until either Continue button is chosen. */
export function installWelcome({
  documentRef = globalThis.document,
  loadApplication,
  reloadApplication = () => globalThis.location.reload(),
  loadTimeoutMs = 30_000,
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = (timer) => globalThis.clearTimeout(timer),
} = {}) {
  const root = documentRef.getElementById('du-welcome');
  const start = documentRef.getElementById('du-welcome-start');
  const guide = documentRef.getElementById('du-welcome-guide');
  const shell = documentRef.getElementById('du-application');
  const status = documentRef.getElementById('du-welcome-status');
  const newUser = documentRef.getElementById('du-new-user');
  const directContinue = documentRef.getElementById('du-continue');
  const guideContinue = documentRef.getElementById('du-guide-continue');
  const back = documentRef.getElementById('du-guide-back');
  const buttons = [newUser, directContinue, guideContinue, back];
  let entering = false;
  let entered = false;
  let reloadRequired = false;

  newUser.addEventListener('click', () => {
    if (entering || entered) return;
    start.hidden = true;
    guide.hidden = false;
    root.setAttribute('aria-labelledby', 'du-guide-title');
    root.scrollTop = 0;
    documentRef.getElementById('du-guide-title').focus();
  });
  back.addEventListener('click', () => {
    if (entering || entered) return;
    guide.hidden = true;
    start.hidden = false;
    root.setAttribute('aria-labelledby', 'du-welcome-title');
    root.scrollTop = 0;
    newUser.focus();
  });

  const recover = (error) => {
    // Failed imports and stylesheet preloads can remain cached in the current
    // document. A fresh document is required before another attempt is safe.
    reloadRequired = true;
    shell.hidden = true;
    shell.inert = true;
    root.hidden = false;
    status.textContent =
      'The app could not load. Check your connection, then choose Continue to reload and try again.';
    buttons.forEach((button) => {
      button.disabled = false;
    });
    entering = false;
    root.setAttribute('aria-busy', 'false');
    (guide.hidden ? directContinue : guideContinue).focus();
    console.error('God’s Earth entry failed:', error);
  };

  const enter = async () => {
    if (entering || entered) return;
    entering = true;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    status.textContent = 'Opening God’s Earth View…';
    root.setAttribute('aria-busy', 'true');
    if (reloadRequired) {
      try {
        // No URL reconstruction: retain every query parameter and camera hash.
        reloadApplication();
        // Keep the duplicate-click guard active until navigation completes.
      } catch (error) {
        recover(error);
      }
      return;
    }

    let timer;
    try {
      const runtime = await Promise.race([
        Promise.resolve().then(() => loadApplication()),
        new Promise((_, reject) => {
          timer = setTimer(
            () => reject(new Error('Application loading timed out')),
            loadTimeoutMs,
          );
        }),
      ]).finally(() => clearTimer(timer));
      // The race is final: a module arriving after the deadline cannot enter.
      // Give Cesium its visible container before constructing the globe.
      shell.hidden = false;
      shell.inert = false;
      root.hidden = true;
      const loading = documentRef.getElementById('loading-screen');
      if (loading) {
        loading.tabIndex = -1;
        loading.focus({ preventScroll: true });
      }
      runtime.startGodsEye();
      entered = true;
    } catch (error) {
      recover(error);
    } finally {
      entering = false;
      root.setAttribute('aria-busy', 'false');
    }
  };
  directContinue.addEventListener('click', enter);
  guideContinue.addEventListener('click', enter);
}
