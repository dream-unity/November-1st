import {
  readDeploymentStatus,
  providerStatusLabel,
  providerStatusDetails,
  deploymentStatusFailureCopy,
  startupFailureCopy,
} from './status.js';
import './chrome.css';

const HOME_URL = 'https://dreamunity.one/';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function homeLink() {
  const link = element('a', '↖ Dream Unity');
  link.href = HOME_URL;
  link.setAttribute('aria-label', 'Return to Dream Unity');
  return link;
}

/** Add navigation and honest provider configuration without changing the globe. */
export function installDreamUnityChrome({ onOpenFeed } = {}) {
  const lifetime = new AbortController();
  const nav = element('nav', '', 'du-navigation');
  nav.setAttribute('aria-label', 'Dream Unity navigation');
  const statusButton = element('button', 'Data sources');
  statusButton.id = 'du-open-source-status';
  statusButton.type = 'button';
  statusButton.dataset.connection = 'checking';
  statusButton.setAttribute('aria-haspopup', 'dialog');
  statusButton.setAttribute('aria-controls', 'du-source-status');
  nav.append(homeLink(), statusButton);
  const feeds = element('div', '', 'du-feed-shortcuts');
  feeds.setAttribute('role', 'group');
  feeds.setAttribute('aria-label', 'Live feeds');
  for (const [kind, label] of [
    ['radio', 'Live radio'],
    ['cctv', 'CCTV cameras'],
    ['traffic', 'Traffic reports'],
  ]) {
    const button = element('button', label);
    button.id = `du-open-${kind}`;
    button.type = 'button';
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => onOpenFeed?.(kind, button), {
      signal: lifetime.signal,
    });
    feeds.append(button);
  }
  nav.append(feeds);
  document.getElementById('title-bar')?.append(nav);

  const dialog = element('dialog', '', 'du-dialog');
  dialog.id = 'du-source-status';
  dialog.setAttribute('aria-labelledby', 'du-source-title');
  const heading = element('h2', 'Data sources');
  heading.id = 'du-source-title';
  const closeButton = element('button', 'Close');
  closeButton.type = 'button';
  closeButton.className = 'du-close';
  const header = element('div', '', 'du-dialog-header');
  header.append(heading, closeButton);
  const state = element('p', 'Checking the data service…', 'du-service-state');
  state.setAttribute('role', 'status');
  const explanation = element(
    'p',
    'This shows how each source is configured. Availability, coverage and update times depend on the source. A configured source may still be temporarily unavailable.',
    'du-source-explanation',
  );
  const rows = element('dl', '', 'du-provider-list');
  const footer = element('div', '', 'du-dialog-footer');
  const refresh = element('button', 'Check again');
  refresh.type = 'button';
  const attribution = element('a', 'About God’s Eye View');
  attribution.href = 'https://github.com/bilawalsidhu/gods-eye-view';
  attribution.target = '_blank';
  attribution.rel = 'noopener noreferrer';
  footer.append(refresh, attribution);
  dialog.append(header, state, explanation, rows, footer);
  document.body.append(dialog);

  let checking = false;
  async function check() {
    if (checking) return;
    checking = true;
    refresh.disabled = true;
    state.textContent = 'Checking the data service…';
    try {
      const { providers } = await readDeploymentStatus({
        signal: lifetime.signal,
      });
      if (lifetime.signal.aborted) return;
      rows.replaceChildren();
      for (const provider of providers) {
        const row = element('div', '', 'du-provider');
        const name = element('dt', provider.label);
        const value = element('dd');
        value.append(
          element(
            'span',
            providerStatusLabel(provider.status),
            'du-provider-status',
          ),
        );
        for (const detail of providerStatusDetails(provider))
          value.append(element('p', detail));
        row.append(name, value);
        rows.append(row);
      }
      const setupCount = providers.filter((provider) =>
        ['not-configured', 'protected', 'requires-persistent-service'].includes(
          provider.status,
        ),
      ).length;
      state.textContent = setupCount
        ? `Data service connected. ${setupCount} optional sources need setup or access; details are listed below.`
        : 'Data service connected. Source configuration is listed below.';
      statusButton.dataset.connection = 'connected';
      statusButton.title = state.textContent;
    } catch (error) {
      if (lifetime.signal.aborted) return;
      rows.replaceChildren();
      state.textContent = deploymentStatusFailureCopy(error);
      statusButton.dataset.connection = 'unavailable';
      statusButton.title =
        'Source status unavailable. Open details or check again.';
    } finally {
      checking = false;
      refresh.disabled = false;
    }
  }
  const events = { signal: lifetime.signal };
  let returnFocus = statusButton;
  statusButton.addEventListener(
    'click',
    () => {
      if (!dialog.open) {
        const active = document.activeElement;
        returnFocus = active?.closest('.du-recovery-actions')
          ? active
          : statusButton;
        dialog.showModal();
      }
      void check();
    },
    events,
  );
  closeButton.addEventListener('click', () => dialog.close(), events);
  refresh.addEventListener('click', () => void check(), events);
  // Register before the application: its cockpit and voice shortcuts also use
  // document capture. Native dialog/button keyboard behavior remains intact.
  const guardModalKeys = (event) => {
    if (dialog.open) event.stopImmediatePropagation();
  };
  for (const type of ['keydown', 'keyup'])
    document.addEventListener(type, guardModalKeys, {
      ...events,
      capture: true,
    });
  dialog.addEventListener('close', () => returnFocus.focus(), events);
  void check();
  return () => {
    lifetime.abort();
    if (dialog.open) dialog.close();
    nav.remove();
    dialog.remove();
  };
}

/** Display recovery after startup fails; no substitute map is claimed. */
export function showStartupFailure(error) {
  const copy = startupFailureCopy(error);
  const loadingScreen = document.getElementById('loading-screen');
  if (!loadingScreen) return;
  loadingScreen.classList.remove('hidden');
  loadingScreen.classList.add('du-startup-failed');
  const container = element('section', '', 'du-recovery');
  container.setAttribute('aria-labelledby', 'du-recovery-title');
  const title = element('h2', copy.title);
  title.id = 'du-recovery-title';
  title.tabIndex = -1;
  const detail = element('details');
  detail.append(
    element('summary', 'Error details'),
    element('pre', copy.detail),
  );
  const actions = element('div', '', 'du-recovery-actions');
  const reload = element('button', 'Reload globe');
  reload.type = 'button';
  reload.addEventListener('click', () => window.location.reload());
  const sources = element('button', 'Data sources');
  sources.type = 'button';
  sources.setAttribute('aria-haspopup', 'dialog');
  sources.addEventListener('click', () => {
    sources.focus();
    document.getElementById('du-open-source-status')?.click();
  });
  actions.append(reload, sources, homeLink());
  const feedActions = element('div', '', 'du-recovery-actions');
  for (const [kind, label] of [
    ['radio', 'Live radio'],
    ['cctv', 'CCTV cameras'],
    ['traffic', 'Traffic reports'],
  ]) {
    const button = element('button', label);
    button.type = 'button';
    button.dataset.feedKind = kind;
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => {
      button.focus();
      document.getElementById(`du-open-${kind}`)?.click();
    });
    feedActions.append(button);
  }
  container.append(
    title,
    element('p', copy.guidance),
    actions,
    element(
      'p',
      'Radio, cameras and traffic reports are also available without the 3D globe.',
    ),
    feedActions,
    detail,
  );
  loadingScreen.replaceChildren(container);
  // Cesium's startup error panel sits above the loading screen and intercepts
  // its recovery controls. Remove only the failed globe's duplicate overlay,
  // after our replacement (including the original error details) is ready.
  document
    .getElementById('cesiumContainer')
    ?.querySelectorAll('.cesium-widget-errorPanel')
    .forEach((panel) => panel.remove());
  title.focus();
}
