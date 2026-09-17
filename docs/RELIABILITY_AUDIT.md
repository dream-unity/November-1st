# Reliability audit and repair record

The [continuous CCTV video repair](CCTV_LIVE_VIDEO_REPAIR.md) records the later
source-ingestion, playback and transport corrections required for moving video.

The subsequent [radio, camera and traffic repair](LIVE_FEEDS_REPAIR.md) adds
visible, usable feed directories, real-only camera previews, video/HLS transport
and official regional traffic reports. Its verification goes beyond catalogue
availability and supersedes the earlier camera/playback coverage limits below.

This audit follows the reported voice error on the full November-1st application.
The screenshot showed a functioning globe and a failed voice start saying
`OPENAI_API_KEY is not set`, followed by misleading microphone/network advice.
The existing complete upstream source is retained. No layer was replaced with a
mock or a reduced implementation.

## Corrected failures

| Area | Confirmed problem | Correction |
| --- | --- | --- |
| Voice admission | Missing configuration was discovered only while starting a session | A no-cost, request-specific availability endpoint is checked before requesting a token or microphone access; setup/access guidance is shown in the idle control |
| Voice errors | Configuration, account access, quota, microphone and network problems shared incorrect advice | Typed backend failures map to specific explanations; setup/access failures do not create the red runtime-error tray |
| Voice lifecycle | Some API errors left an active microphone behind an error state; candidate warnings were treated as fatal UI errors | Fatal failures stop tracks and close the connection; recoverable ICE candidate warnings remain diagnostics; terminal ICE failure and handshake timeout release the session |
| Voice races | Late availability responses and duplicate stop events could overwrite current UI state | Generation checks reject obsolete preflights; adapters' own idle state is preserved |
| Voice diagnostics | Production attempted writes to the deliberately unavailable local debug-log endpoint | Automatic network debug logging is restricted to development |
| Voice/HUD transport | Unbounded provider replies and malformed or excessive HUD request bodies | Bounded reads, cancellation, finite deadlines, token validation, correct 400/413 handling and sanitized provider failures |
| Hosted access | Paid admission and status were not consistently request-specific | Availability reflects current authorization; preflight does not consume paid request quotas; cross-site ambient-auth requests are rejected |
| Civilian aircraft | Missing quota headers became zero; requests could hang; malformed bodies could enter cache; old observations could appear fresh | Missing-header semantics, bounded acquisition, request coalescing, schema checks, regional fallback and source-time freshness |
| Military aircraft | Unbounded acquisition and invalid upstream error/success bodies | Deadlines, coalescing, bounded JSON validation, sanitized errors and outage backoff |
| Aircraft history/metadata | Oversized or malformed history replies could look successful; refresh failures discarded useful metadata | Explicit 502 responses, strict identifiers, no caching failed history requests, retained last-known enrichment |
| Fire observations | Failed refresh or key loss could leave retained detections looking fresh; invalid coordinates and rolled-over dates were accepted | Cached observations are marked stale; geographic/time validation rejects invalid records; recovery clears stale state |
| Fire transport | Large global snapshots could exceed serverless response limits | Bounded upstream reads, lossless negotiated compression and an explicit persistent-host requirement when the complete result still cannot fit; no silent row truncation |
| Terrain | Blank/out-of-range positions, incorrect oversized-request status and excessively long batches | WGS84 validation, HTTP 400 for invalid requests and a bounded acquisition budget |
| Places, Overpass, GBFS, satellites | Missing deadlines or invalid successful responses could be accepted/cached | Bounded reads and validation; malformed Overpass replies rotate to another mirror; failed GBFS/Places replies are not cached as valid catalogues |
| Directions | HTTP/platform errors could be interpreted as route results | HTTP status and response shape are checked before accepting geometry |
| Camera video | Failed/unsupported playback could leave a black panel | Finite load/stall handling, useful failure text and media lifecycle cleanup |
| Provider settings | Hosted startup probed the intentionally absent local credential editor | A hosted-specific build flag skips it; original local development/preview retains the editor with finite request and disposal handling |
| Status and recovery | Authorization, invalid status and timeouts were conflated; nested startup details were omitted | Distinct explanations, visible setup requirements, complete nested startup details |
| Deployment identity | Uploaded production functions could report a null source revision | The function reads bundled build metadata, matching the frontend revision |
| Container build | The installation hook ran before its required source was copied | Complete source is copied before installation |
| Test execution | Ordinary test concurrency depended on the host CPU count | Predictable concurrency of four, explicit discovered-file and completion reporting; allocation probes remain isolated |

## Coverage and evidence

Review covered the application startup/composition, voice lifecycle, frontend
source adapters, provider middleware and caching contracts, hosted request
admission, native API dispatch, static assets, build tracing, immutable source
bootstrap, GitHub Pages handoff, container entrypoint, dependency inventory and
CI test discovery. Independent reviews cross-checked frontend/backend contracts
and identified additional regressions before publication.

The unchanged upstream regression suite covers the wider layer catalogue,
cockpit/contacts/tracking, scene director, annotations, sharing, map controls,
geometry, selection and lifecycle behavior. New regressions exercise the actual
failures above using deterministic responses, streaming bodies, cancellation and
HTTP server requests. A passing unit test is not a claim of external feed uptime.

See [the verification record](DREAM_UNITY_VERIFICATION.md) for final integrated
test totals, deployment revision and observed production responses.

## External requirements and verification limits

- OpenAI voice/HUD is not activated by this repair. It still needs a valid
  server-held OpenAI credential, provider access and deliberate deployment
  admission. Missing setup is now represented before a microphone request.
- FIRMS, live TomTom traffic and optional photorealistic maps still require their
  respective credentials/entitlements. Simulated traffic remains explicitly
  identified. Configuration presence does not prove provider authorization.
- Continuous AIS ingestion needs an AISStream credential and a persistent Node
  service. The existing bridge and direct persistent entry remain available.
- Serverless invocation duration and response budgets still apply. Compression
  does not make arbitrarily large snapshots or continuous media unlimited.
  [Vercel documents these limits](https://vercel.com/docs/functions/limitations).
- Custom HLS playlists require compatible playback and correct playlist/segment
  delivery; a bundled camera catalogue does not certify every external stream.
- The controlled browser environment cannot initialize WebGL. It can verify the
  public handoff, asset loading, status dialog and startup recovery, but cannot
  certify a hardware-rendered cockpit walkthrough. The supplied screenshot
  demonstrates rendering on the user's browser. Paid voice calls were not made
  without credentials; Docker itself is unavailable in the workspace.

This record documents reproducible corrections and their evidence. It does not
claim that an audit can prove the absence of every future defect, provider outage
or browser-specific failure.
