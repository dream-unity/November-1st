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
