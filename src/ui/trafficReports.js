import {
  TRAFFIC_REPORT_REGIONS,
  trafficReportDate,
} from '../sources/trafficReports.js';
import { readResponseJsonCapped } from '../sources/httpBody.js';

export async function fetchTrafficReports(
  region,
  { fetchImpl = (...args) => globalThis.fetch(...args), signal } = {},
) {
  if (!TRAFFIC_REPORT_REGIONS.some((entry) => entry.id === region))
    throw new TypeError('Unsupported traffic region');
  const response = await fetchImpl(
    `/api/traffic/reports?region=${encodeURIComponent(region)}`,
    { signal },
  );
  if (!response.ok)
    throw new Error(
      'The official traffic feed could not be loaded. Try Refresh shortly.',
    );
  const payload = await readResponseJsonCapped(response, 3_750_000, signal);
  signal?.throwIfAborted();
  if (
    payload?.region?.id !== region ||
    !Array.isArray(payload.reports) ||
    payload.reports.length > 1500 ||
    typeof payload.stale !== 'boolean' ||
    typeof payload.partial !== 'boolean' ||
    !trafficReportDate(payload.fetchedAt) ||
    !trafficReportDate(payload.sourceUpdatedAt) ||
    payload.reports.some(
      (report) =>
        !report ||
        typeof report.id !== 'string' ||
        typeof report.title !== 'string' ||
        !trafficReportDate(report.updatedAt),
    )
  )
    throw new Error(
      'The traffic service returned an invalid report snapshot. Try Refresh shortly.',
    );
  return payload;
}

function displayTime(value) {
  const date = trafficReportDate(value);
  return date
    ? new Date(date).toLocaleString(undefined, {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' UTC'
    : 'not supplied';
}

/** Accessible list works with or without a WebGL scene; the globe jump is optional. */
export function mountTrafficReports(container, { onGlobe, fetchImpl } = {}) {
  const document = container.ownerDocument;
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const root = el('section', '', 'traffic-reports');
  root.setAttribute('aria-label', 'Official traffic reports');
  const intro = el(
    'p',
    'Published incidents and roadworks for the regions below. Animated Street Traffic dots are a separate visualization; without a TomTom key, those dots are simulated.',
    'traffic-reports-help',
  );
  const toolbar = el('div', '', 'traffic-reports-toolbar');
  const label = el('label', 'Report region');
  const regionSelect = el('select');
  regionSelect.setAttribute('aria-label', 'Traffic report region');
  for (const region of TRAFFIC_REPORT_REGIONS) {
    const option = el('option', region.label);
    option.value = region.id;
    regionSelect.append(option);
  }
  label.append(regionSelect);
  const refreshButton = el('button', 'Refresh');
  refreshButton.type = 'button';
  toolbar.append(label, refreshButton);
  const coverage = el('p', '', 'traffic-reports-help');
  const sourceLink = el('a');
  sourceLink.target = '_blank';
  sourceLink.rel = 'noopener noreferrer';
  const status = el('p', '', 'traffic-reports-status');
  status.setAttribute('role', 'status');
  const times = el('p', '', 'traffic-reports-help');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Find a road, place or incident';
  search.setAttribute('aria-label', 'Search traffic reports');
  const kind = el('select');
  kind.setAttribute('aria-label', 'Traffic report type');
  for (const [value, title] of [
    ['all', 'All reports'],
    ['incident', 'Incidents'],
    ['roadworks', 'Roadworks'],
    ['planned', 'Planned works'],
  ]) {
    const option = el('option', title);
    option.value = value;
    kind.append(option);
  }
  const filters = el('div', '', 'traffic-reports-toolbar');
  filters.append(search, kind);
  const list = el('div', '', 'traffic-reports-list');
  const more = el('button', 'Show more reports');
  more.type = 'button';
  more.hidden = true;
  root.append(
    intro,
    toolbar,
    coverage,
    sourceLink,
    status,
    times,
    filters,
    list,
    more,
  );
  container.append(root);

  let destroyed = false;
  let controller = null;
  let generation = 0;
  let snapshot = null;
  let visibleCount = 40;
  let requestTimer = null;
  let regionId = 'austin';

  function renderReports() {
    list.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase();
    const filtered = (snapshot?.reports || []).filter(
      (report) =>
        (!query ||
          [report.title, report.description, report.location, report.agency]
            .join(' ')
            .toLocaleLowerCase()
            .includes(query)) &&
        (kind.value === 'all' ||
          kind.value === report.kind ||
          kind.value === report.status),
    );
    if (!filtered.length && snapshot)
      list.append(
        el(
          'p',
          snapshot.reports.length
            ? 'No reports match these filters.'
            : 'The publishing authority currently lists no active incidents or roadworks for this feed. This does not establish that every road is clear.',
        ),
      );
    for (const report of filtered.slice(0, visibleCount)) {
      const article = el('article', '', 'traffic-reports-item');
      article.append(el('h3', report.title));
      const labels = [
        report.status === 'planned' ? 'PLANNED' : 'REPORTED ACTIVE',
        report.kind === 'roadworks' ? 'ROADWORKS' : 'INCIDENT',
      ];
      article.append(el('p', labels.join(' · '), 'traffic-reports-help'));
      if (report.location) article.append(el('p', report.location));
      if (report.description && report.description !== report.location)
        article.append(el('p', report.description));
      article.append(
        el(
          'p',
          `Report updated ${displayTime(report.updatedAt)}${report.agency ? ' · ' + report.agency : ''}`,
          'traffic-reports-help',
        ),
      );
      if (report.startedAt || report.endsAt)
        article.append(
          el(
            'p',
            `${report.status === 'planned' ? 'Scheduled start' : 'Started'}: ${displayTime(report.startedAt)}${report.endsAt ? ' · Expected end: ' + displayTime(report.endsAt) : ''}`,
            'traffic-reports-help',
          ),
        );
      const point = report.position;
      if (
        typeof onGlobe === 'function' &&
        Number.isFinite(point?.latitude) &&
        Number.isFinite(point?.longitude) &&
        Math.abs(point.latitude) <= 90 &&
        Math.abs(point.longitude) <= 180
      ) {
        const locate = el('button', 'View report location on globe');
        locate.type = 'button';
        locate.addEventListener('click', () => {
          Promise.resolve()
            .then(() => onGlobe({ ...point, title: report.title }))
            .catch((error) => {
              if (!destroyed)
                status.textContent =
                  (typeof error?.message === 'string'
                    ? error.message.slice(0, 300) + ' '
                    : '') +
                  'The globe could not move to this report. Its location and details are still available here.';
            });
        });
        article.append(
          locate,
          el('small', report.locationPrecision || 'Reported location'),
        );
      }
      list.append(article);
    }
    more.hidden = filtered.length <= visibleCount;
    more.textContent = `Show more reports (${Math.min(visibleCount, filtered.length)} of ${filtered.length} shown)`;
  }

  async function load({ changedRegion = false } = {}) {
    if (destroyed) return;
    const token = ++generation;
    controller?.abort();
    clearTimeout(requestTimer);
    controller = new AbortController();
    const activeController = controller;
    requestTimer = setTimeout(() => activeController.abort(), 25_000);
    if (changedRegion) {
      snapshot = null;
      visibleCount = 40;
      search.value = '';
      kind.value = 'all';
      times.textContent = '';
      renderReports();
    }
    const region = TRAFFIC_REPORT_REGIONS.find(
      (entry) => entry.id === regionId,
    );
    coverage.textContent = region.coverage;
    sourceLink.textContent = `Source: ${region.source}`;
    sourceLink.href = region.sourceUrl;
    status.textContent = 'Loading official traffic reports…';
    status.dataset.state = 'loading';
    refreshButton.disabled = true;
    try {
      const result = await fetchTrafficReports(regionId, {
        fetchImpl,
        signal: activeController.signal,
      });
      if (destroyed || token !== generation) return;
      snapshot = result;
      status.dataset.state = result.stale ? 'stale' : 'ready';
      status.textContent = `${result.stale ? 'STALE SNAPSHOT · ' : ''}${result.reports.length} official reports. ${result.message || ''}${result.partial ? ' Coverage is capped; consult the source for all reports.' : ''}`;
      times.textContent = `Source updated ${displayTime(result.sourceUpdatedAt)} · Retrieved ${displayTime(result.fetchedAt)} · Refreshes every minute while this tab is open.`;
      renderReports();
    } catch (error) {
      if (destroyed || token !== generation) return;
      status.dataset.state = 'stale';
      status.textContent = `${snapshot ? 'STALE SNAPSHOT · Refresh failed; the previous reports remain below. ' : ''}${activeController.signal.aborted ? 'Traffic request timed out. Try Refresh.' : error.message}`;
    } finally {
      if (!destroyed && token === generation) {
        clearTimeout(requestTimer);
        refreshButton.disabled = false;
      }
    }
  }

  const selectRegion = () => {
    regionId = regionSelect.value;
    void load({ changedRegion: true });
  };
  const refresh = () => {
    void load();
  };
  const filter = () => {
    visibleCount = 40;
    renderReports();
  };
  const showMore = () => {
    visibleCount += 40;
    renderReports();
  };
  regionSelect.addEventListener('change', selectRegion);
  refreshButton.addEventListener('click', refresh);
  search.addEventListener('input', filter);
  kind.addEventListener('change', filter);
  more.addEventListener('click', showMore);
  const interval = setInterval(() => {
    if (!document.hidden && !refreshButton.disabled) refresh();
  }, 60_000);
  void load();
  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation++;
      controller?.abort();
      clearTimeout(requestTimer);
      clearInterval(interval);
      regionSelect.removeEventListener('change', selectRegion);
      refreshButton.removeEventListener('click', refresh);
      search.removeEventListener('input', filter);
      kind.removeEventListener('change', filter);
      more.removeEventListener('click', showMore);
      root.remove();
    },
  };
}
