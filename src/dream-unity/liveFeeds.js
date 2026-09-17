import { createRadioStreamPlayer } from '../layers/radio/playback.js';
import { createCctvVideoPlayback } from '../sources/cctvVideoPlayback.js';
import { mountTrafficReports } from '../ui/trafficReports.js';
import {
  filterFeedDirectory,
  readFeedDirectory,
  readCctvSnapshot,
} from './liveFeedsModel.js';
import './liveFeeds.css';
import '../ui/styles/trafficReports.css';

const TITLES = {
  radio: 'Live radio',
  cctv: 'Public cameras',
  traffic: 'Traffic reports',
};
const PAGE_SIZE = 30;
function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text) {
  const node = element('button', text);
  node.type = 'button';
  return node;
}
function errorCopy(error) {
  return error?.name === 'TimeoutError'
    ? 'The source took too long to respond. Try again.'
    : error?.message || 'The source is unavailable. Try again.';
}

/** A direct, accessible route into the original providers, including without WebGL. */
export function installLiveFeeds({
  openOnGlobe,
  beforeRadioPlay = () => {},
} = {}) {
  const lifetime = new AbortController();
  const dialog = element('dialog', '', 'du-feeds');
  dialog.id = 'du-live-feeds';
  dialog.setAttribute('aria-labelledby', 'du-feeds-title');
  const header = element('header', '', 'du-feeds-header');
  const title = element('h2', 'Live feeds');
  title.id = 'du-feeds-title';
  const close = button('Close');
  close.setAttribute('aria-label', 'Close live feeds');
  header.append(title, close);
  const tabs = element('div', '', 'du-feeds-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Live feed types');
  const tabButtons = new Map();
  for (const [kind, label] of Object.entries(TITLES)) {
    const tab = button(label);
    tab.id = `du-feed-tab-${kind}`;
    tab.dataset.kind = kind;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'du-feeds-panel');
    tab.addEventListener('click', () => mount(kind), {
      signal: lifetime.signal,
    });
    tabs.append(tab);
    tabButtons.set(kind, tab);
  }
  const panel = element('section', '', 'du-feeds-panel');
  panel.id = 'du-feeds-panel';
  panel.setAttribute('role', 'tabpanel');
  const notice = element(
    'p',
    'Public feeds depend on their broadcasters and source agencies. Coverage and availability vary.',
    'du-feeds-note',
  );
  dialog.append(header, tabs, panel, notice);
  document.body.append(dialog);
  let activeKind = null;
  let scope = null;
  let disposePanel = () => {};
  let returnFocus = null;
  let destroyed = false;
  let toastTimer;
  let toast;

  function announceAfterClose(message) {
    if (!message) return;
    clearTimeout(toastTimer);
    toast?.remove();
    toast = element('div', message, 'du-feed-toast');
    toast.setAttribute('role', 'status');
    document.body.append(toast);
    toastTimer = setTimeout(() => {
      toast?.remove();
      toast = null;
    }, 10_000);
  }
  function cleanup() {
    scope?.abort();
    scope = null;
    disposePanel();
    disposePanel = () => {};
    activeKind = null;
  }
  function focusAfterClose(kind) {
    const visible = (node) =>
      node?.isConnected &&
      node !== document.body &&
      !dialog.contains(node) &&
      !node.disabled &&
      !node.hidden &&
      node.getClientRects().length > 0 &&
      globalThis.getComputedStyle(node).visibility !== 'hidden';
    const loading = document.getElementById('loading-screen');
    const recovery = loading?.classList.contains('du-startup-failed')
      ? loading.querySelector(`[data-feed-kind="${kind}"]`)
      : null;
    const target = [
      recovery,
      returnFocus,
      document.getElementById(`du-open-${kind}`),
    ].find(visible);
    target?.focus();
  }
  function globeAction(kind, item, status, signal) {
    if (typeof openOnGlobe !== 'function') return null;
    const show = button('Show on globe');
    show.addEventListener(
      'click',
      async () => {
        show.disabled = true;
        try {
          const result = await openOnGlobe(kind, item, { signal });
          if (signal.aborted) return;
          if (result?.opened === false)
            throw new Error(result.message || 'The globe is not ready.');
          dialog.close();
          announceAfterClose(result?.message);
        } catch (error) {
          if (!signal.aborted) status.textContent = errorCopy(error);
        } finally {
          if (!signal.aborted) show.disabled = false;
        }
      },
      { signal },
    );
    return show;
  }

  function mount(kind) {
    if (
      destroyed ||
      !Object.hasOwn(TITLES, kind) ||
      (activeKind === kind && scope)
    )
      return;
    cleanup();
    scope = new AbortController();
    const signal = scope.signal;
    activeKind = kind;
    title.textContent = TITLES[kind];
    for (const [id, tab] of tabButtons) {
      tab.setAttribute('aria-selected', String(id === kind));
      tab.tabIndex = id === kind ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `du-feed-tab-${kind}`);
    panel.replaceChildren();
    if (kind === 'traffic') {
      const traffic = mountTrafficReports(panel, {
        onGlobe:
          typeof openOnGlobe === 'function'
            ? async (item) => {
                const result = await openOnGlobe(
                  'traffic',
                  {
                    ...item,
                    lat: item.latitude,
                    lon: item.longitude,
                  },
                  { signal },
                );
                if (signal.aborted) return;
                if (result?.opened === false)
                  throw new Error(result.message || 'The globe is not ready.');
                dialog.close();
                announceAfterClose(result?.message);
              }
            : undefined,
      });
      disposePanel = () => traffic.destroy();
      return;
    }
    const intro = element(
      'p',
      kind === 'radio'
        ? 'Search radio stations, then choose Listen. Audio comes directly from the broadcaster; it stops when this panel closes or you change feed type.'
        : 'Choose a public camera to view its latest available image or video. Snapshots are not continuous video; retrieval time is not the camera capture time.',
      'du-feeds-intro',
    );
    const filters = element('div', '', 'du-feeds-filters');
    const searchLabel = element(
      'label',
      kind === 'radio'
        ? 'Search name, country, language or genre'
        : 'Search camera, city or provider',
    );
    const search = element('input');
    search.type = 'search';
    search.maxLength = 200;
    search.placeholder =
      kind === 'radio'
        ? 'e.g. jazz, London, French'
        : 'e.g. Austin, Finland, highway';
    searchLabel.append(search);
    const regionLabel = element(
      'label',
      kind === 'radio' ? 'Country' : 'City / region',
    );
    const region = element('select');
    region.setAttribute(
      'aria-label',
      kind === 'radio' ? 'Filter by country' : 'Filter by city or region',
    );
    region.append(
      new Option(
        kind === 'radio' ? 'All countries' : 'All cities / regions',
        '',
      ),
    );
    regionLabel.append(region);
    const refresh = button('Refresh directory');
    filters.append(searchLabel, regionLabel, refresh);
    const directoryStatus = element(
      'p',
      'Loading directory…',
      'du-feeds-status',
    );
    directoryStatus.setAttribute('role', 'status');
    const layout = element('div', '', 'du-feeds-layout');
    const results = element('div', '', 'du-feeds-results');
    const count = element('p', '', 'du-feeds-count');
    count.setAttribute('role', 'status');
    const list = element('ul', '', 'du-feeds-list');
    const more = button('Show more');
    more.hidden = true;
    results.append(count, list, more);
    const detail = element('section', '', 'du-feed-detail');
    detail.setAttribute(
      'aria-label',
      kind === 'radio' ? 'Radio player' : 'Camera preview',
    );
    detail.append(
      element(
        'p',
        kind === 'radio'
          ? 'Choose a station to listen.'
          : 'Choose a camera to preview.',
      ),
    );
    layout.append(results, detail);
    panel.append(intro, filters, directoryStatus, layout);
    let items = [];
    let visibleCount = PAGE_SIZE;
    let selected = null;
    let request = null;
    let mediaLifetime = null;
    let disposeMedia = () => {};
    let loadGeneration = 0;
    function stopMedia() {
      mediaLifetime?.abort();
      mediaLifetime = null;
      disposeMedia();
      disposeMedia = () => {};
    }
    function selection(item) {
      stopMedia();
      selected = item;
      mediaLifetime = new AbortController();
      const mediaSignal = mediaLifetime.signal;
      detail.replaceChildren();
      const name = element('h3', item.name);
      name.tabIndex = -1;
      const location = element(
        'p',
        kind === 'radio'
          ? [item.state, item.country].filter(Boolean).join(', ')
          : [item.city, item.provider].filter(Boolean).join(' · '),
      );
      const status = element('p', '', 'du-feeds-status');
      status.setAttribute('role', 'status');
      const actions = element('div', '', 'du-feed-actions');
      detail.append(name, location, status);
      const globe = globeAction(kind, item, status, mediaSignal);
      if (kind === 'radio') {
        const play = button('Play / retry');
        const pause = button('Pause');
        const stop = button('Stop');
        const volumeLabel = element('label', 'Volume');
        const volume = element('input');
        volume.type = 'range';
        volume.min = '0';
        volume.max = '1';
        volume.step = '0.05';
        volume.value = '0.65';
        volume.setAttribute('aria-label', 'Radio volume');
        volumeLabel.append(volume);
        const player = createRadioStreamPlayer({
          onState(state) {
            if (mediaSignal.aborted) return;
            const labels = {
              stopped: 'Ready to play.',
              loading: 'Connecting to broadcaster…',
              playing: 'Playing broadcaster audio.',
              buffering: 'Buffering live radio…',
              paused: 'Paused.',
              error: 'This stream could not play.',
            };
            status.textContent =
              state.audioError || labels[state.audioState] || 'Ready to play.';
            play.disabled = ['playing', 'loading', 'buffering'].includes(
              state.audioState,
            );
            pause.disabled = !['playing', 'loading', 'buffering'].includes(
              state.audioState,
            );
            stop.disabled = state.audioState === 'stopped';
          },
        });
        player.setStation(item);
        player.setVolume(0.65);
        const start = () => {
          try {
            beforeRadioPlay();
            void player.play().catch((error) => {
              if (!mediaSignal.aborted) status.textContent = errorCopy(error);
            });
          } catch (error) {
            status.textContent = errorCopy(error);
          }
        };
        play.addEventListener('click', start, { signal: mediaSignal });
        pause.addEventListener('click', () => player.pause(), {
          signal: mediaSignal,
        });
        stop.addEventListener('click', () => player.stop(), {
          signal: mediaSignal,
        });
        volume.addEventListener(
          'input',
          () => player.setVolume(Number(volume.value)),
          { signal: mediaSignal },
        );
        actions.append(play, pause, stop);
        if (globe) actions.append(globe);
        detail.append(
          actions,
          volumeLabel,
          element(
            'p',
            [...item.tags, ...item.languages].join(' · '),
            'du-feeds-note',
          ),
        );
        if (item.homepage) {
          const link = element('a', 'Visit broadcaster website');
          link.href = item.homepage;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          detail.append(link);
        }
        detail.append(
          element(
            'p',
            'Station metadata is supplied by the Radio Browser community. Broadcaster geographic restrictions may apply. An entry in the directory does not guarantee that its stream is currently online.',
            'du-feeds-note',
          ),
        );
        disposeMedia = () => player.destroy();
        start();
      } else {
        const attribution = element(
          'p',
          [item.credit, item.license].filter(Boolean).join(' · '),
          'du-feeds-note',
        );
        if (['mp4', 'webm', 'hls'].includes(item.feedType)) {
          const video = element('video');
          video.controls = true;
          video.muted = true;
          video.playsInline = true;
          video.setAttribute('aria-label', `${item.name} camera video`);
          detail.append(video);
          const playback = createCctvVideoPlayback({
            video,
            url: `/api/cctv/media/${encodeURIComponent(item.id)}`,
            feedType: item.feedType,
            autoPlay: false,
            onStatus(value) {
              if (!mediaSignal.aborted)
                status.textContent =
                  value.message ||
                  (value.status === 'ready'
                    ? 'Camera video is ready. Use the playback controls.'
                    : value.status);
            },
          });
          const retry = button('Retry video');
          retry.addEventListener('click', () => playback.retry(), {
            signal: mediaSignal,
          });
          actions.append(retry);
          disposeMedia = () => playback.destroy();
        } else {
          const image = element('img');
          image.alt = `Latest available snapshot from ${item.name}`;
          image.hidden = true;
          const refreshImage = button('Refresh snapshot');
          const autoLabel = element('label', '', 'du-feed-auto');
          const auto = element('input');
          auto.type = 'checkbox';
          autoLabel.append(
            auto,
            document.createTextNode('Refresh every 30 seconds while visible'),
          );
          let frameRequest = null;
          let objectUrl = null;
          let fetching = false;
          let lastRetrieved = '';
          image.addEventListener(
            'error',
            () => {
              if (!mediaSignal.aborted) {
                image.hidden = true;
                lastRetrieved = '';
                status.textContent =
                  'The camera image could not be decoded. Try another camera or retry.';
              }
            },
            { signal: mediaSignal },
          );
          async function refreshSnapshot() {
            if (fetching || mediaSignal.aborted) return;
            fetching = true;
            refreshImage.disabled = true;
            frameRequest = new AbortController();
            const frameSignal = AbortSignal.any([
              mediaSignal,
              frameRequest.signal,
            ]);
            status.textContent = lastRetrieved
              ? `Refreshing snapshot; previous image retrieved at ${lastRetrieved}.`
              : 'Loading camera snapshot…';
            try {
              const blob = await readCctvSnapshot(item, {
                signal: frameSignal,
              });
              if (frameSignal.aborted) return;
              const next = URL.createObjectURL(blob);
              image.src = next;
              image.hidden = false;
              if (objectUrl) URL.revokeObjectURL(objectUrl);
              objectUrl = next;
              lastRetrieved = new Date().toLocaleTimeString();
              status.textContent = `Snapshot retrieved at ${lastRetrieved}. Camera capture time may be earlier.`;
            } catch (error) {
              if (!frameSignal.aborted)
                status.textContent = `${errorCopy(error)}${lastRetrieved ? ` Previous image retained, retrieved at ${lastRetrieved}.` : ''}`;
            } finally {
              fetching = false;
              if (!mediaSignal.aborted) refreshImage.disabled = false;
            }
          }
          refreshImage.addEventListener('click', () => void refreshSnapshot(), {
            signal: mediaSignal,
          });
          const timer = setInterval(() => {
            if (auto.checked && !document.hidden) void refreshSnapshot();
          }, 30_000);
          actions.append(refreshImage);
          detail.append(image, autoLabel);
          disposeMedia = () => {
            frameRequest?.abort();
            clearInterval(timer);
            image.removeAttribute('src');
            if (objectUrl) URL.revokeObjectURL(objectUrl);
          };
          void refreshSnapshot();
        }
        if (globe) actions.append(globe);
        detail.append(actions, attribution);
      }
      name.focus({ preventScroll: true });
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      renderList();
    }
    function renderList() {
      const matches = filterFeedDirectory(items, search.value, region.value);
      list.replaceChildren();
      const shown = matches.slice(0, visibleCount);
      const itemLabel = kind === 'radio' ? 'stations' : 'cameras';
      count.textContent = matches.length
        ? `Showing ${shown.length} of ${matches.length} matching ${itemLabel} (${items.length} in this directory).`
        : items.length
          ? 'No matches. Try a different search or region.'
          : '';
      for (const item of shown) {
        const row = element('li');
        const select = button(
          `${kind === 'radio' ? 'Listen to' : 'View'} ${item.name}`,
        );
        select.setAttribute('aria-pressed', String(selected?.id === item.id));
        const label = element('span', item.name, 'du-feed-name');
        const subtitle = element(
          'span',
          kind === 'radio'
            ? [item.country, item.tags.slice(0, 3).join(', ')]
                .filter(Boolean)
                .join(' · ')
            : [
                item.city,
                item.provider,
                ['mp4', 'webm', 'hls'].includes(item.feedType)
                  ? 'Video'
                  : 'Snapshot',
              ]
                .filter(Boolean)
                .join(' · '),
          'du-feed-subtitle',
        );
        select.setAttribute('aria-label', select.textContent);
        select.replaceChildren(label, subtitle);
        select.dataset.feedId = item.id;
        row.append(select);
        list.append(row);
      }
      more.hidden = shown.length >= matches.length;
      more.textContent = `Show ${Math.min(PAGE_SIZE, Math.max(0, matches.length - shown.length))} more`;
    }
    list.addEventListener(
      'click',
      (event) => {
        const id = event.target?.closest?.('button[data-feed-id]')?.dataset
          .feedId;
        const item = id && items.find((entry) => entry.id === id);
        if (item) selection(item);
      },
      { signal },
    );
    const resetFilter = () => {
      visibleCount = PAGE_SIZE;
      renderList();
    };
    search.addEventListener('input', resetFilter, { signal });
    region.addEventListener('change', resetFilter, { signal });
    more.addEventListener(
      'click',
      () => {
        visibleCount += PAGE_SIZE;
        renderList();
      },
      { signal },
    );
    async function loadDirectory() {
      const generation = ++loadGeneration;
      request?.abort();
      request = new AbortController();
      const requestSignal = AbortSignal.any([signal, request.signal]);
      refresh.disabled = true;
      directoryStatus.textContent = 'Loading directory…';
      try {
        const data = await readFeedDirectory(kind, { signal: requestSignal });
        if (requestSignal.aborted || generation !== loadGeneration) return;
        items = data.items;
        const previousRegion = region.value;
        region.replaceChildren(
          new Option(
            kind === 'radio' ? 'All countries' : 'All cities / regions',
            '',
          ),
        );
        for (const name of [
          ...new Set(
            items.map((item) => item.country || item.city).filter(Boolean),
          ),
        ].sort((a, b) => a.localeCompare(b)))
          region.append(new Option(name, name));
        if (
          [...region.options].some((option) => option.value === previousRegion)
        )
          region.value = previousRegion;
        directoryStatus.textContent = !items.length
          ? 'This directory currently contains no entries. Try refreshing later.'
          : `${data.stale || data.degraded ? 'Cached / degraded directory. ' : ''}${data.updatedAt ? `Directory updated ${new Date(data.updatedAt).toLocaleString()}. ` : ''}${data.rejected ? `${data.rejected} unusable entries were excluded. ` : ''}Choose an entry to check its media.`;
        renderList();
      } catch (error) {
        if (!requestSignal.aborted)
          directoryStatus.textContent = `${errorCopy(error)}${items.length ? ' Previous directory retained.' : ''}`;
      } finally {
        if (!signal.aborted && generation === loadGeneration)
          refresh.disabled = false;
      }
    }
    refresh.addEventListener('click', () => void loadDirectory(), { signal });
    disposePanel = () => {
      loadGeneration++;
      request?.abort();
      stopMedia();
    };
    void loadDirectory();
  }

  close.addEventListener('click', () => dialog.close(), {
    signal: lifetime.signal,
  });
  dialog.addEventListener(
    'close',
    () => {
      const kind = activeKind;
      cleanup();
      if (!destroyed) focusAfterClose(kind);
    },
    { signal: lifetime.signal },
  );
  // Install before the globe's capture shortcuts. Preserve browser-native input,
  // dialog Escape and button Space/Enter behavior while isolating globe commands.
  const guard = (event) => {
    if (!dialog.open) return;
    if (
      event.type === 'keydown' &&
      event.target?.getAttribute?.('role') === 'tab' &&
      ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    ) {
      const kinds = [...tabButtons.keys()];
      const index = kinds.indexOf(activeKind);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? kinds.length - 1
            : (index + (event.key === 'ArrowRight' ? 1 : -1) + kinds.length) %
              kinds.length;
      event.preventDefault();
      mount(kinds[next]);
      tabButtons.get(kinds[next]).focus();
    }
    event.stopImmediatePropagation();
  };
  for (const event of ['keydown', 'keyup'])
    document.addEventListener(event, guard, {
      signal: lifetime.signal,
      capture: true,
    });
  return {
    open(kind, opener) {
      if (destroyed || !Object.hasOwn(TITLES, kind)) return;
      const active = document.activeElement;
      returnFocus = active?.closest?.('.du-recovery-actions')
        ? active
        : opener || active;
      if (!dialog.open) dialog.showModal();
      mount(kind);
      tabButtons.get(kind).focus();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cleanup();
      lifetime.abort();
      if (dialog.open) dialog.close();
      dialog.remove();
      clearTimeout(toastTimer);
      toast?.remove();
    },
  };
}
