import {
  createCountryRadioDirectory,
  normalizeCountryRadioSources,
  mergeCountryRadioStations,
  loadCountryRadioSources,
  loadCountryRadioExclusions,
} from './radio/countryDirectory.js';

export const UKRAINE_RADIO_LIMIT = 600;
const country = Object.freeze({
  countryCode: 'UA',
  countryName: 'Ukraine',
  countryKey: 'ukraine',
  limit: UKRAINE_RADIO_LIMIT,
  queryLimit: 1000,
});

export function normalizeUkraineRadioSources(records) {
  return normalizeCountryRadioSources(records, country);
}
export function mergeUkraineRadioStations(curated, directory) {
  return mergeCountryRadioStations(curated, directory, country);
}
export function loadUkraineRadioSources(options = {}) {
  return loadCountryRadioSources({ ...options, ...country });
}
export function loadUkraineRadioExclusions(options = {}) {
  return loadCountryRadioExclusions({ ...options, ...country });
}
export function createUkraineRadioDirectory(options = {}) {
  return createCountryRadioDirectory({
    loadSources: loadUkraineRadioSources,
    loadExclusions: loadUkraineRadioExclusions,
    ...options,
    ...country,
  });
}
