/** Keep the full application dormant until either Continue button is chosen. */
export function installWelcome({
  documentRef = globalThis.document,
  loadApplication,
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

  const enter = async () => {
    if (entering || entered) return;
    entering = true;
    buttons.forEach((button) => {
      button.disabled = true;
    });
    status.textContent = 'Opening God’s Eye View…';
    root.setAttribute('aria-busy', 'true');
    try {
      const runtime = await loadApplication();
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
      shell.hidden = true;
      shell.inert = true;
      root.hidden = false;
      status.textContent =
        'The app could not load. Check your connection and choose Continue to try again.';
      buttons.forEach((button) => {
        button.disabled = false;
      });
      (guide.hidden ? directContinue : guideContinue).focus();
      console.error('God’s Eye entry failed:', error);
    } finally {
      entering = false;
      root.setAttribute('aria-busy', 'false');
    }
  };
  directContinue.addEventListener('click', enter);
  guideContinue.addEventListener('click', enter);
}
