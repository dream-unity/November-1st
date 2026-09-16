import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { voiceAvailability } from '../server/providers/openai/status.js';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

const enabled = (value) => String(value || '').trim() === '1';
const present = (value) => Boolean(String(value || '').trim());

/** Deployment-owned configuration. Provider credentials never enter this object. */
export function readHostConfig(
  env = process.env,
  mode = env.VERCEL ? 'serverless' : 'persistent',
) {
  if (!['persistent', 'serverless'].includes(mode))
    throw new Error('Unknown host runtime');
  const username = String(env.GEV_BASIC_AUTH_USER || 'dream-unity');
  const password = String(env.GEV_BASIC_AUTH_PASSWORD || '');
  if (present(env.GEV_BASIC_AUTH_USER) && !password) {
    throw new Error('GEV_BASIC_AUTH_USER requires GEV_BASIC_AUTH_PASSWORD');
  }
  let aisOrigin = null;
  if (present(env.GEV_PERSISTENT_API_ORIGIN)) {
    const url = new URL(env.GEV_PERSISTENT_API_ORIGIN);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    ) {
      throw new Error(
        'GEV_PERSISTENT_API_ORIGIN must be an HTTPS origin without a path or credentials',
      );
    }
    aisOrigin = url.origin;
  }
  const allowedOrigins = String(
    env.GEV_ALLOWED_ORIGINS ||
      'https://dream-unity.github.io,https://dreamunity.one',
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const origin of allowedOrigins) {
    if (new URL(origin).origin !== origin)
      throw new Error('GEV_ALLOWED_ORIGINS must contain exact origins');
  }
  return {
    mode,
    distDir: path.resolve(projectRoot, env.GEV_DIST_DIR || 'dist'),
    stateDir: path.resolve(
      env.GEV_STATE_DIR ||
        (mode === 'serverless'
          ? path.join(os.tmpdir(), 'november-first')
          : projectRoot),
    ),
    commit:
      env.DU_SOURCE_COMMIT ||
      env.VERCEL_GIT_COMMIT_SHA ||
      env.GITHUB_SHA ||
      null,
    basicAuth: password ? { username, password } : null,
    serviceToken: String(env.GEV_SERVICE_TOKEN || ''),
    allowPaidPublic: enabled(env.GEV_ALLOW_PAID_PUBLIC),
    allowedOrigins,
    aisOrigin,
    aisToken: String(env.GEV_PERSISTENT_API_TOKEN || ''),
    port: Number(env.PORT || 3000),
    hostname: env.HOST || '0.0.0.0',
  };
}

/** Configuration presence only: never claim that an upstream request succeeded. */
export function capabilityReport(
  config,
  env = process.env,
  { authorized = false } = {},
) {
  const has = (...names) => names.every((name) => present(env[name]));
  const paidAvailable = authorized || config.allowPaidPublic;
  const optional = (id, label, names, detail, paid = false) => ({
    id,
    label,
    status: has(...names)
      ? paid && !paidAvailable
        ? 'protected'
        : 'configured'
      : 'not-configured',
    detail,
  });
  const providers = [
    ...[
      [
        'flights',
        'Civilian aircraft',
        'Public ADS-B and OpenSky fallback; coverage and quotas vary.',
      ],
      [
        'military',
        'Military aircraft',
        'Public adsb.lol feed; visibility depends on broadcast coverage.',
      ],
      [
        'satellites',
        'Satellites',
        'CelesTrak orbital elements; rendered positions are calculated, not live telemetry.',
      ],
      ['earthquakes', 'Earthquakes', 'USGS public feed.'],
      [
        'cctv',
        'Public cameras',
        'Registered public camera feeds; some sources can be offline.',
      ],
      ['radio', 'World radio', 'Radio Browser catalogue and station streams.'],
      [
        'launches',
        'Rocket launches',
        'Launch Library public feed; public quota applies.',
      ],
      [
        'weather',
        'Weather and regional context',
        'Open-Meteo, public place search and regional sources.',
      ],
      [
        'transit',
        'Transit and bikeshare',
        'Registered public feeds; coverage varies by city.',
      ],
      [
        'infrastructure',
        'Infrastructure and routes',
        'OpenStreetMap, registered reference data and routing.',
      ],
      ['maps', 'Globe imagery and terrain', 'Keyless map and terrain sources.'],
    ].map(([id, label, detail]) => ({ id, label, status: 'keyless', detail })),
    {
      id: 'vessels',
      label: 'Live vessels',
      status:
        config.mode === 'serverless'
          ? config.aisOrigin
            ? 'configured'
            : 'requires-persistent-service'
          : has('AISSTREAM_API_KEY')
            ? 'configured'
            : 'not-configured',
      detail:
        config.mode === 'serverless'
          ? config.aisOrigin
            ? 'Forwarded to the configured persistent AIS service; connection has not been verified.'
            : 'Continuous AIS ingestion needs a persistent Node service and AISStream key.'
          : 'Persistent AISStream connection and accumulated tracks; AISSTREAM_API_KEY required.',
    },
    optional(
      'fires',
      'Active fires',
      ['FIRMS_MAP_KEY'],
      'NASA FIRMS account key required.',
    ),
    optional(
      'traffic',
      'Live traffic speeds',
      ['TOMTOM_API_KEY'],
      'Without a TomTom key, traffic animation is simulated.',
    ),
    {
      id: 'photorealistic',
      label: 'Photorealistic 3D',
      status:
        has('CESIUM_ION_TOKEN') || has('GOOGLE_MAPS_API_KEY')
          ? 'configured'
          : 'not-configured',
      detail:
        'Optional Cesium ion entitlement or separately configured Google Maps browser key; the frontend must be rebuilt when these build-time values change.',
    },
    {
      id: 'voice',
      label: 'AI voice and HUD',
      ...voiceAvailability({
        apiKey: env.OPENAI_API_KEY,
        authorized: paidAvailable,
      }),
      detail:
        'Configuration and access status for this request; provider credentials are not tested until a session starts.',
    },
    {
      id: 'google',
      label: 'Google place search',
      status:
        has('GOOGLE_MAPS_SERVER_API_KEY') || has('GOOGLE_MAPS_API_KEY')
          ? !paidAvailable
            ? 'protected'
            : 'configured'
          : 'not-configured',
      detail:
        'Optional metered Google provider; keyless search remains available.',
    },
  ];
  return {
    runtime: config.mode,
    providers,
    note: 'Configuration status only; upstream availability is determined when requested.',
    state:
      config.mode === 'serverless'
        ? 'Provider caches and accumulated histories are local to each function instance and can reset. Provider quotas are not coordinated across instances.'
        : 'Provider caches and accumulated histories are held by this Node process; mount GEV_STATE_DIR on durable storage to retain disk caches.',
  };
}
