# Dream Unity deployment

## Architecture

November-1st owns the complete upstream source at the commit recorded in UPSTREAM.md. The full standalone catalogue, layer modules, cockpit, scene director, annotations, share states, voice controller and provider modules remain in the application. Dream Unity navigation is a small addition around the upstream entrypoint.

The frontend and `/api/*` must share an origin. A GitHub Pages portal should link to this application using ordinary navigation. It cannot execute this Node backend. Do not point a GitHub Pages copy at a mutable remote app.js or use arbitrary public CORS relays.

## Vercel

Import this repository as a Vite project, choose Node 24.x and use the committed vercel.json. The installation is `PUPPETEER_SKIP_DOWNLOAD=1 npm ci`; the build is `npm run build`; the static output is `dist`. The `api/index.js` function mounts the original provider middleware. Dynamic CCTV catalogue files are explicitly included.

A connector-based initial deployment may hydrate a checksum-verified immutable archive of this repository before installing dependencies. The generated `deploy-source.json` is deployment input, not committed source. This does not create an automatic Git integration. Link the Git repository in the Vercel project settings for automatic deployments, or publish a new pinned deployment through the same connector.

Health: `/api/health`. Configuration inventory: `/api/capabilities`. Source/build identity: `/build-info.json`. None of these claims all external feeds are currently working. Missing API routes return JSON 404, never the HTML shell.

Serverless function instances can reset or multiply. Upstream in-memory histories, request coalescing and cache budgets are per instance, not globally coordinated. Disk caches use the writable temporary directory. This deployment does not silently start a continuous AIS socket in each function instance.

## Persistent Node service

Build with `npm ci && npm run build`, then run `npm start` behind an HTTPS reverse proxy, or deploy the included Dockerfile to a persistent container service. Configure `HOST=0.0.0.0`, `PORT=8080`, and mount a durable directory at `GEV_STATE_DIR`. The Docker image runs as the unprivileged node user. Run one instance for AIS unless you add a shared collector/cache architecture; duplicate replicas create independent provider connections and budgets.

To use persistent AIS from the Vercel frontend, configure `AISSTREAM_API_KEY` and `GEV_SERVICE_TOKEN` on the persistent host. Configure `GEV_PERSISTENT_API_ORIGIN` (an HTTPS origin without a path) and matching `GEV_PERSISTENT_API_TOKEN` on Vercel. Only the fixed AIS route is bridged. Keep this connection server-side.

## Optional providers

| Capability | Configuration | Condition |
| --- | --- | --- |
| Continuous vessels | AISSTREAM_API_KEY | Persistent collector required |
| Active fires | FIRMS_MAP_KEY | NASA FIRMS account required |
| Live traffic speed tiles | TOMTOM_API_KEY | Without this, upstream traffic animation is simulated |
| Photorealistic 3D | CESIUM_ION_TOKEN or GOOGLE_MAPS_API_KEY | Appropriate provider entitlement/restrictions; browser configuration compiled at build time |
| Google Places | GOOGLE_MAPS_SERVER_API_KEY or GOOGLE_MAPS_API_KEY | Metered server routes protected by host policy |
| AI voice and HUD | OPENAI_API_KEY | Metered server routes protected by host policy |

Never commit secrets. Use environment settings on the host. Browser map tokens are public by design and need provider-side origin restrictions. Rebuild when browser token configuration changes.

For metered endpoints, configure `GEV_BASIC_AUTH_PASSWORD` (optional user defaults to dream-unity), or use service authentication where appropriate. Deliberately setting `GEV_ALLOW_PAID_PUBLIC=1` opens paid endpoints to public requests; do this only with accepted budget limits and provider-side controls. Per-process throttling is not a global spending cap. Vercel static files remain public even when the function is authenticated; private deployments need platform deployment protection or the persistent host behind authentication.

The local .env editor and realtime debug-log writer are blocked in production. Configure provider keys through deployment environment settings, not the local onboarding controls.

## Verification and updates

`npm run verify` checks import/package boundaries, production-host tests, upstream unit tests and production build. `npm run format:check` retains upstream formatting checks. Preserve original license and source attribution. Update upstream by explicit commit, review the diff, rerun tests and compare the full standalone catalogue before deployment.

No automated test can establish permanent availability of external ADS-B, cameras, radio stations, satellite catalogues or other independent providers. Confirm representative responses on the deployed host and report failures separately from source inclusion.
