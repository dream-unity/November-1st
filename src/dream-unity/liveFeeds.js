import { createRadioStreamPlayer } from '../layers/radio/playback.js';
import { createCctvVideoPlayback } from '../sources/cctvVideoPlayback.js';
import { createCctvEmbedPlayback } from '../sources/cctvEmbedPlayback.js';
import { cameraMediaKind, cameraMediaLabel } from '../sources/cctvTypes.js';
import { mountTrafficReports } from '../ui/trafficReports.js';
import {
  filterFeedDirectory,
  cameraCountry,
  cameraCountryOptions,
  interleaveCameraCountries,
  readFeedDirectory,
  readCctvSnapshot,
  feedCoordinates,
  RADIO_COUNTRY_DIRECTORIES,
} from './liveFeedsModel.js';
import './liveFeeds.css';
import '../ui/styles/trafficReports.css';

const TITLES = {
  radio: 'Live radio',
  cctv: 'Public cameras',
  traffic: 'Traffic reports',
};
const PAGE_SIZE = 30;
const radioCountryCode = (name) =>
  Object.entries(RADIO_COUNTRY_DIRECTORIES).find(
    ([, value]) => value === name,
  )?.[0] || '';
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
    if (!feedCoordinates(item)) {
      show.disabled = true;
      show.textContent = 'Globe location unavailable';
      show.title =
        'This broadcaster has not supplied a reliable map location. Its audio is still available.';
      return show;
    }
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
    const suppliedCountry =
      new URLSearchParams(globalThis.location?.search || '').get('country') ||
      '';
    const initialCountry = /^[a-z]{2}$/i.test(suppliedCountry)
      ? suppliedCountry.toUpperCase()
      : '';
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
        : 'Live video is selected by default. Choose a country and camera to watch a direct stream or the provider’s official video player. Video starts muted where supported. Snapshots and finite clips are available separately; coverage varies by country and provider.',
      'du-feeds-intro',
    );
    const filters = element('div', '', 'du-feeds-filters');
    const searchLabel = element(
      'label',
      kind === 'radio'
        ? 'Search name, country, language or genre'
        : 'Search camera, country, city or provider',
    );
    const search = element('input');
    search.type = 'search';
    search.maxLength = 200;
    search.placeholder =
      kind === 'radio'
        ? 'e.g. jazz, London, French'
        : 'e.g. Australia, GB, Tokyo, highway';
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
    if (kind === 'radio') {
      for (const name of Object.values(RADIO_COUNTRY_DIRECTORIES))
        region.append(new Option(name, name));
      if (Object.hasOwn(RADIO_COUNTRY_DIRECTORIES, initialCountry))
        region.value = RADIO_COUNTRY_DIRECTORIES[initialCountry];
    }
    regionLabel.append(region);
    const refresh = button('Refresh directory');
    const countryFilter = kind === 'cctv' ? element('select') : null;
    filters.append(searchLabel);
    if (countryFilter) {
      const countryLabel = element('label', 'Country');
      countryFilter.setAttribute('aria-label', 'Filter cameras by country');
      countryFilter.append(new Option('All countries', ''));
      countryLabel.append(countryFilter);
      filters.append(countryLabel);
    }
    filters.append(regionLabel);
    const mediaFilter = kind === 'cctv' ? element('select') : null;
    const mediaOptions = [
      ['live', 'Live video'],
      ['snapshot', 'Snapshots'],
      ['video', 'Clips / other videos'],
      ['all', 'All cameras'],
    ];
    if (mediaFilter) {
      const mediaLabel = element('label', 'Camera media');
      mediaFilter.setAttribute('aria-label', 'Camera media type');
      for (const [value, label] of mediaOptions)
        mediaFilter.append(new Option(label, value));
      mediaFilter.value = 'live';
      mediaLabel.append(mediaFilter);
      filters.append(mediaLabel);
      filters.classList.add('du-feeds-camera-filters');
    }
    filters.append(refresh);
    if (kind === 'radio') {
      for (const name of Object.values(RADIO_COUNTRY_DIRECTORIES)) {
        const shortcut = button(`${name} stations`);
        shortcut.addEventListener(
          'click',
          () => {
            region.value = name;
            search.value = '';
            region.dispatchEvent(new Event('change'));
          },
          { signal },
        );
        filters.append(shortcut);
      }
    }
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
    const publisherLinks = element('section', '', 'du-feed-publisher-links');
    publisherLinks.hidden = true;
    if (kind === 'cctv') results.append(publisherLinks);
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
    let publisherSources = [];
    let visibleCount = PAGE_SIZE;
    let selected = null;
    let request = null;
    let mediaLifetime = null;
    let disposeMedia = () => {};
    let loadGeneration = 0;
    let radioCatalogCountry = '';
    let requestedRadioCountry = null;
    let initialCountryApplied = false;
    const radioCountryNames = new Set(Object.values(RADIO_COUNTRY_DIRECTORIES));
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
          : [item.city, item.state, cameraCountry(item).name, item.provider]
              .filter(Boolean)
              .join(' · '),
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
        if (!feedCoordinates(item))
          detail.append(
            element(
              'p',
              'This station has no verified map location; you can still listen here.',
              'du-feeds-note',
            ),
          );
        detail.append(
          element(
            'p',
            `${['curated-ukraine', 'curated-australia'].includes(item.sourceKind) ? 'This stream was listed from its broadcaster’s published source.' : 'Station metadata is supplied by the Radio Browser community.'} Broadcaster geographic restrictions may apply. An entry in the directory does not guarantee that its stream is currently online.`,
            'du-feeds-note',
          ),
        );
        if (item.sourcePage && item.sourcePage !== item.homepage) {
          const sourceLink = element('a', 'View broadcaster stream source');
          sourceLink.href = item.sourcePage;
          sourceLink.target = '_blank';
          sourceLink.rel = 'noopener noreferrer';
          detail.append(sourceLink);
        }
        disposeMedia = () => player.destroy();
        start();
      } else {
        const attribution = element(
          'p',
          [item.credit, item.license].filter(Boolean).join(' · '),
          'du-feeds-note',
        );
        if (item.feedType === 'embed') {
          const embed = element('div', '', 'du-feed-embed');
          const playVideo = button('Play video');
          const pauseVideo = button('Pause video');
          const retry = button('Retry video');
          const mediaLabel = element(
            'p',
            `${cameraMediaLabel(item)} · Official provider player`,
            'du-feed-media-kind',
          );
          detail.append(mediaLabel, embed);
          const playback = createCctvEmbedPlayback({
            container: embed,
            embedUrl: item.embedUrl,
            title: item.name,
            sourcePage: item.sourcePage,
            statusUrl: `/api/cctv/embed-status/${encodeURIComponent(item.id)}`,
            playbackKind: item.playbackKind,
            requireLiveStatus: item.liveOnly === true,
            visibilityTarget: document,
            autoPlay: cameraMediaKind(item) === 'live',
            onStatus(value) {
              if (mediaSignal.aborted) return;
              status.textContent = value.message || value.status;
              const verifiedLabel = {
                unknown: 'Live status unconfirmed',
                ended: 'Broadcast ended',
                unavailable: 'Broadcast unavailable',
              }[value.liveStatus];
              mediaLabel.textContent = `${verifiedLabel || cameraMediaLabel(item)} · Official provider player`;
              playVideo.disabled = value.status === 'playing';
              pauseVideo.disabled = ![
                'playing',
                'loading',
                'ready',
                'blocked',
              ].includes(value.status);
              retry.hidden = !['unavailable', 'unsupported', 'ended'].includes(
                value.status,
              );
            },
          });
          playVideo.addEventListener('click', () => playback.play(), {
            signal: mediaSignal,
          });
          pauseVideo.addEventListener('click', () => playback.pause(), {
            signal: mediaSignal,
          });
          retry.addEventListener('click', () => playback.retry(), {
            signal: mediaSignal,
          });
          actions.append(playVideo, pauseVideo, retry);
          detail.append(
            element(
              'p',
              'Use the provider’s video controls for sound or fullscreen. Its availability, advertising and geographic restrictions apply. If embedding is unavailable, use the provider link below. Closing this panel or changing cameras stops the player.',
              'du-feeds-note',
            ),
          );
          disposeMedia = () => playback.destroy();
        } else if (['mp4', 'webm', 'hls'].includes(item.feedType)) {
          const video = element('video');
          video.controls = true;
          video.muted = true;
          video.playsInline = true;
          video.preload = 'auto';
          video.loop = false;
          video.setAttribute('aria-label', `${item.name} camera video`);
          detail.append(
            element('p', cameraMediaLabel(item), 'du-feed-media-kind'),
            video,
          );
          const playVideo = button('Play video');
          const pauseVideo = button('Pause video');
          const retry = button('Retry video');
          const playback = createCctvVideoPlayback({
            playbackKind: item.playbackKind,
            visibilityTarget: document,
            video,
            url: `/api/cctv/media/${encodeURIComponent(item.id)}`,
            feedType: item.feedType,
            autoPlay: cameraMediaKind(item) === 'live',
            onStatus(value) {
              if (mediaSignal.aborted) return;
              status.textContent =
                value.status === 'playing'
                  ? cameraMediaKind(item) === 'live'
                    ? 'Playing continuous camera video. Network and broadcaster delay may apply.'
                    : cameraMediaKind(item) === 'clip'
                      ? 'Playing a finite camera clip; this is not a continuous live stream.'
                      : 'Playing camera video. The source does not confirm continuous live coverage.'
                  : value.message || value.status;
              playVideo.disabled = value.status === 'playing';
              pauseVideo.disabled = ![
                'playing',
                'loading',
                'ready',
                'reconnecting',
              ].includes(value.status);
              retry.hidden = !['unavailable', 'unsupported', 'ended'].includes(
                value.status,
              );
            },
          });
          playVideo.addEventListener('click', () => playback.play(), {
            signal: mediaSignal,
          });
          pauseVideo.addEventListener('click', () => playback.pause(), {
            signal: mediaSignal,
          });
          retry.addEventListener('click', () => playback.retry(), {
            signal: mediaSignal,
          });
          actions.append(playVideo, pauseVideo, retry);
          detail.append(
            element(
              'p',
              'Video starts muted. Use the video controls for sound or fullscreen. Closing this panel or changing cameras stops the stream.',
              'du-feeds-note',
            ),
          );
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
        if (item.sourcePage) {
          const sourceLink = element('a', 'Visit camera provider');
          sourceLink.href = item.sourcePage;
          sourceLink.target = '_blank';
          sourceLink.rel = 'noopener noreferrer';
          detail.append(sourceLink);
        }
      }
      name.focus({ preventScroll: true });
      detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      renderList();
    }
    function renderList() {
      publisherLinks.replaceChildren();
      const externalMatches =
        kind === 'cctv' && ['live', 'all'].includes(mediaFilter.value)
          ? filterFeedDirectory(
              publisherSources,
              search.value,
              region.value,
              'all',
              countryFilter.value,
            )
          : [];
      publisherLinks.hidden = !externalMatches.length;
      if (externalMatches.length) {
        publisherLinks.append(
          element('h3', 'Watch on the publisher’s website'),
        );
        publisherLinks.append(
          element(
            'p',
            `${externalMatches.length} additional camera links. These publishers keep playback on their own websites; they are counted separately from the in-app cameras.`,
            'du-feeds-note',
          ),
        );
        const links = element('ul');
        for (const camera of externalMatches) {
          const row = element('li');
          const link = element(
            'a',
            `${camera.name} · ${camera.city}, ${camera.state}`,
          );
          link.href = camera.sourcePage;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          row.append(
            link,
            element(
              'span',
              ` — live video checked ${new Date(camera.verifiedAt).toLocaleDateString()}. Availability can change.`,
            ),
          );
          links.append(row);
        }
        publisherLinks.append(links);
      }
      if (mediaFilter) {
        for (const option of mediaFilter.options) {
          const label = mediaOptions.find(
            ([value]) => value === option.value,
          )[1];
          const matching = filterFeedDirectory(
            items,
            search.value,
            region.value,
            option.value,
            countryFilter.value,
          ).length;
          option.textContent = `${label} (${matching})`;
        }
      }
      const filtered = filterFeedDirectory(
        items,
        search.value,
        region.value,
        mediaFilter?.value || 'all',
        countryFilter?.value || '',
      );
      const matches =
        kind === 'cctv' ? interleaveCameraCountries(filtered) : filtered;
      list.replaceChildren();
      const shown = matches.slice(0, visibleCount);
      const itemLabel = kind === 'radio' ? 'stations' : 'cameras';
      count.textContent = matches.length
        ? `Showing ${shown.length} of ${matches.length} matching ${itemLabel} (${items.length} in this directory).`
        : items.length
          ? kind === 'cctv'
            ? 'No in-app cameras match this media type, search, country and region. Change the filters to view other available sources.'
            : 'No matches. Try a different search or region.'
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
                item.state,
                cameraCountry(item).name,
                item.provider,
                cameraMediaLabel(item),
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
    region.addEventListener(
      'change',
      () => {
        resetFilter();
        if (kind === 'radio') {
          const targetCountry = radioCountryCode(region.value);
          if (
            targetCountry !== radioCatalogCountry ||
            (requestedRadioCountry !== null &&
              requestedRadioCountry !== targetCountry)
          )
            void loadDirectory();
        }
      },
      { signal },
    );
    countryFilter?.addEventListener(
      'change',
      () => {
        updateRegions();
        resetFilter();
      },
      { signal },
    );
    mediaFilter?.addEventListener('change', resetFilter, { signal });
    more.addEventListener(
      'click',
      () => {
        visibleCount += PAGE_SIZE;
        renderList();
      },
      { signal },
    );
    function updateRegions() {
      const previousRegion = region.value;
      region.replaceChildren(
        new Option(
          kind === 'radio' ? 'All countries' : 'All cities / regions',
          '',
        ),
      );
      const regionalItems = countryFilter
        ? filterFeedDirectory(
            [...items, ...publisherSources],
            '',
            '',
            'all',
            countryFilter.value,
          )
        : items;
      const names = new Set(
        regionalItems
          .map((item) => (kind === 'radio' ? item.country : item.city))
          .filter(Boolean),
      );
      if (kind === 'radio') {
        for (const name of names) radioCountryNames.add(name);
        for (const name of radioCountryNames) names.add(name);
      }
      for (const name of [...names].sort((a, b) => a.localeCompare(b)))
        region.append(new Option(name, name));
      region.value = [...region.options].some(
        (option) => option.value === previousRegion,
      )
        ? previousRegion
        : '';
    }
    async function loadDirectory() {
      const generation = ++loadGeneration;
      request?.abort();
      request = new AbortController();
      const requestSignal = AbortSignal.any([signal, request.signal]);
      const requestedCountry =
        kind === 'radio' ? radioCountryCode(region.value) : '';
      requestedRadioCountry = requestedCountry;
      refresh.disabled = true;
      directoryStatus.textContent = 'Loading directory…';
      try {
        const data = await readFeedDirectory(kind, {
          signal: requestSignal,
          country: requestedCountry,
        });
        if (requestSignal.aborted || generation !== loadGeneration) return;
        radioCatalogCountry = requestedCountry;
        items = data.items;
        publisherSources = data.publisherSources;
        if (selected) {
          const replacement = items.find((item) => item.id === selected.id);
          if (
            !replacement ||
            replacement.streamUrl !== selected.streamUrl ||
            replacement.streamFormat !== selected.streamFormat ||
            replacement.liveOnly !== selected.liveOnly ||
            replacement.playbackKind !== selected.playbackKind ||
            replacement.embedUrl !== selected.embedUrl
          ) {
            stopMedia();
            selected = null;
            detail.replaceChildren(
              element(
                'p',
                'The selected source changed or is no longer in this directory. Choose an entry to play its current stream.',
              ),
            );
          }
        }
        if (countryFilter) {
          const previousCountry = countryFilter.value;
          countryFilter.replaceChildren(new Option('All countries', ''));
          for (const country of cameraCountryOptions(items))
            countryFilter.append(
              new Option(
                `${country.name} — ${country.live} listed live / ${country.total} cameras`,
                country.value,
              ),
            );
          countryFilter.value = [...countryFilter.options].some(
            (option) => option.value === previousCountry,
          )
            ? previousCountry
            : '';
          if (
            !initialCountryApplied &&
            initialCountry &&
            [...countryFilter.options].some(
              (option) => option.value === initialCountry,
            )
          )
            countryFilter.value = initialCountry;
        }
        updateRegions();
        if (kind === 'radio' && !initialCountryApplied && initialCountry) {
          const matching = items.find(
            (item) => item.countryCode?.toUpperCase() === initialCountry,
          );
          if (
            matching &&
            [...region.options].some(
              (option) => option.value === matching.country,
            )
          )
            region.value = matching.country;
        }
        initialCountryApplied = true;
        directoryStatus.textContent = !items.length
          ? 'This directory currently contains no entries. Try refreshing later.'
          : `${data.stale || data.degraded ? 'Cached / degraded directory. ' : ''}${data.updatedAt ? `Directory updated ${new Date(data.updatedAt).toLocaleString()}. ` : ''}${data.rejected ? `${data.rejected} unusable entries were excluded. ` : ''}Choose an entry to check its media.`;
        renderList();
      } catch (error) {
        if (!requestSignal.aborted)
          directoryStatus.textContent = `${errorCopy(error)}${items.length ? ' Previous directory retained.' : ''}`;
      } finally {
        if (!signal.aborted && generation === loadGeneration) {
          requestedRadioCountry = null;
          refresh.disabled = false;
        }
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
