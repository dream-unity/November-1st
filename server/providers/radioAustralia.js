import {
  createCountryRadioDirectory,
  normalizeCountryRadioSources,
  mergeCountryRadioStations,
  loadCountryRadioSources,
  loadCountryRadioExclusions,
} from './radio/countryDirectory.js';

export const AUSTRALIA_RADIO_LIMIT = 1500;
const country = Object.freeze({
  countryCode: 'AU',
  countryName: 'Australia',
  countryKey: 'australia',
  limit: AUSTRALIA_RADIO_LIMIT,
  queryLimit: 2500,
  allowHls: true,
});

export function normalizeAustraliaRadioSources(records) {
  return normalizeCountryRadioSources(records, country);
}
export function mergeAustraliaRadioStations(curated, directory) {
  return mergeCountryRadioStations(curated, directory, country);
}
export function loadAustraliaRadioSources(options = {}) {
  return loadCountryRadioSources({ ...options, ...country });
}
export function loadAustraliaRadioExclusions(options = {}) {
  return loadCountryRadioExclusions({ ...options, ...country });
}
export function createAustraliaRadioDirectory(options = {}) {
  return createCountryRadioDirectory({
    loadSources: loadAustraliaRadioSources,
    loadExclusions: loadAustraliaRadioExclusions,
    ...options,
    ...country,
  });
}

/** A city view reuses the complete AU cache without assigning a map location. */
export function melbourneRadioCatalog(catalog) {
  const melbourneToken = /(?:^|[^\p{L}\p{N}])melbourne(?=$|[^\p{L}\p{N}])/iu;
  const stations = catalog.stations.flatMap((station) => {
    if (station.countryCode !== 'AU') return [];
    if (station.sourceKind === 'curated-australia') {
      return station.metroArea === 'melbourne'
        ? [{ ...station, metroMatch: 'curated' }]
        : [];
    }
    // Community directory locations are claims, not publisher verification.
    // Victoria, nearby coordinates and national networks alone are insufficient.
    const mentionsMelbourne = [
      station.name,
      station.state,
      ...(station.tags || []),
    ].some((value) => typeof value === 'string' && melbourneToken.test(value));
    return mentionsMelbourne
      ? [{ ...station, metroMatch: 'community-metadata' }]
      : [];
  });
  const curatedStationCount = stations.filter(
    (station) => station.metroMatch === 'curated',
  ).length;
  return {
    ...catalog,
    stations,
    coverage: {
      ...catalog.coverage,
      countryCode: 'AU',
      city: 'melbourne',
      metroArea: 'melbourne',
      countryStationCount: catalog.stations.length,
      stationCount: stations.length,
      curatedStationCount,
      directoryStationCount: stations.length - curatedStationCount,
      inferredStationCount: stations.length - curatedStationCount,
    },
  };
}
