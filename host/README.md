# Production provider host

The built browser application and **all upstream provider modules** are retained.
This host attaches the same upstream middleware factories used by standalone
preview to a production Connect HTTP application. It does not run the Vite dev
server, recreate data layers, or load the previous reduced Vercel application.

## Persistent Node deployment

Use the Node version in the root `package.json`, install dependencies, and build:

```sh
npm ci
npm run build
npm start
```

`npm start` loads an optional local `.env`; on a managed host, configure secrets
as environment variables. `HOST` defaults to `0.0.0.0`; `PORT` defaults to `3000`.
Use the platform's HTTPS reverse proxy. `GEV_STATE_DIR` selects a writable,
preferably durable, state directory. It holds the upstream `.gev-cache` tree.
The host resolves source catalogues and the built application independently of
that directory. Run one instance per AISStream key: upstream ingestion retains
one persistent WebSocket and its watchdog, with proper shutdown on SIGTERM.
Multiple instances require deliberate shared caching and quota coordination.

## Existing GitHub → Vercel route

`api/index.js` is a Node function for `/api/*`. The full built frontend is
served from `dist`. Each warm function instance retains upstream request caches;
disk caching uses `/tmp/november-first` and can disappear at any cold start.
Upstream provider service duration, payload limits, and per-instance caches remain
subject to the deployment platform. This is not a persistent process.
Long radio/media proxy streams can be interrupted when a function reaches its
maximum duration; native public station URLs may continue independently. A
persistent deployment is the complete path for continuous streams. Full-world
FIRMS results and large catalogues must also fit the platform's response limit;
increasing function duration does not increase that payload limit. FIRMS uses
lossless gzip when accepted by the client and measures the encoded response
against a conservative 4 MiB budget. If the complete result still does not fit,
the layer explains that a persistent host is required. It never silently drops
fire records to fit the function budget.

Continuous AIS ingestion is **not** started in a function. Without a persistent
service, `/api/ais-live` returns HTTP 503 and an explicit
`requires-persistent-service` state. To enable it while keeping the same public
Vercel URL, deploy the persistent host and set:

```dotenv
# Vercel environment:
GEV_PERSISTENT_API_ORIGIN=https://your-persistent-host.example
GEV_PERSISTENT_API_TOKEN=your-server-to-server-token

# Persistent host environment:
AISSTREAM_API_KEY=your-aisstream-key
GEV_SERVICE_TOKEN=your-server-to-server-token
```

The fixed bridge forwards only the vessel snapshot and vessel track read routes.
It does not accept a destination URL from the browser and does not follow
redirects. Hosted snapshots are capped at 5,000 vessels and 4 MB to fit the
function response budget; a direct persistent deployment retains the full
upstream 50,000-row ceiling. `GEV_SERVICE_TOKEN` permits bearer-authenticated API
requests to bypass deployment Basic Auth and use protected paid endpoints; it
does not, by itself, make the public keyless endpoints private.

## Optional providers and hosted access

No provider key is needed to start the complete application. Provider coverage,
public service availability and request limits still apply. Configure the
upstream `.env.example` provider names for enhanced feeds:

- `AISSTREAM_API_KEY`: live vessels on the persistent service.
- `FIRMS_MAP_KEY`: NASA active-fire products.
- `TOMTOM_API_KEY`: live traffic speeds; otherwise traffic is simulated.
- `CESIUM_ION_TOKEN` / `GOOGLE_MAPS_API_KEY`: optional map sources, subject to
  account entitlements and billing. Browser map credentials must be restricted
  to the published origins; they are build-time browser configuration.
- `OPENAI_API_KEY`: server-held AI voice and HUD credentials.
- `GOOGLE_MAPS_SERVER_API_KEY`: separate server-held Google credential.

The local `/api/setup/*` key editor and the local conversation-log writer are
always unavailable in this host. Configure credentials through deployment
settings, never through a public form.

Cost-bearing OpenAI and Google server routes fail closed by default even if a
key is configured. Either protect the persistent deployment (or the API routes
when using Vercel's separately served static files) with
`GEV_BASIC_AUTH_PASSWORD` and optional `GEV_BASIC_AUTH_USER` (default
`dream-unity`), use server-to-server bearer authentication, or deliberately enable
public metered usage with `GEV_ALLOW_PAID_PUBLIC=1`. The host's per-process limit
defaults to 30 paid requests/minute and is adjustable with
`GEV_PAID_REQUESTS_PER_MINUTE`. This bounds requests, **not provider spend** or
Realtime session length, and is not a distributed quota. Use provider budget
controls and platform access protection for public metered deployments.

The Google protection also covers CCTV frame requests when a Google key is
configured, because the upstream camera implementation may use metered Street
View as a fallback. With no Google key the public camera routes remain available.

`GEV_ALLOWED_ORIGINS` is a comma-separated list of exact cross-origin browser
origins; defaults are the Dream Unity domain and its GitHub Pages origin.
Same-origin use works without CORS. A protected deployment should open directly
at its own URL so browser HTTP Basic authentication can work normally. On
Vercel, visit `/api/health` directly to sign in before using protected features.
Protecting Vercel's static pages themselves requires platform access protection.

## Verification and truthfulness

`/api/health` proves only that the host mounted its middleware, lists the mounted
providers, and includes the deployment commit from platform configuration or bundled build metadata.
`/api/capabilities` reports credential and architecture configuration without
disclosing values. Metered-provider status reflects this request's access: a
server-side bearer token configured on the deployment does not grant a public
visitor access. Neither endpoint claims that an upstream feed was fetched,
that provider permissions are valid, or that rendered positions were observed.
Provider responses remain responsible for actual freshness and availability.

```sh
npm run test:host
```

The host tests verify actual middleware prefix routing, all-provider mounting,
static-file boundaries, blocked key-writing routes, metered-route authorization,
rate limits, async rejection handling, CORS, lifecycle teardown, and the restricted
AIS bridge. They do not claim to exercise real external provider uptime.


## Voice availability and failure contracts

`GET /api/realtime/status` is a read-only, no-cost preflight. It reports
`available`, `configured`, `status`, `code`, `message`, and `retryable` without
minting a session, requesting a microphone, contacting OpenAI, or consuming the
paid-route request quota. A configured key is not proof of provider validity.

- `VOICE_NOT_CONFIGURED`: the owner must enable OpenAI on the server.
- `VOICE_AUTH_REQUIRED`: the current visitor has no protected-provider access.
- `VOICE_READY`: the deployment configuration permits a session attempt.

Session creation separately distinguishes provider access rejection, exhausted
quota, rate limits, invalid model/session configuration, timeouts, unreachable
providers, and invalid responses. Upstream errors are sanitized. Token payloads
and AI HUD responses are bounded during streaming, and malformed/oversized HUD
requests receive explicit HTTP 400/413 responses before any provider call.
Unavailable credentials do not consume the paid quota; template placeholders
are treated as absent. These checks do not replace provider billing limits or
prove that a credential is valid.
