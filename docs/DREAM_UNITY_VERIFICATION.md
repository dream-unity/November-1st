# Verification record

## Reliability repair verification — 2026-09-16 UTC

This section supersedes the earlier baseline for the reliability repair.
See [the audit and correction matrix](RELIABILITY_AUDIT.md).

- `npm test`: **330 test files completed; 4,200 tests, 4,199 passed,
  zero failed/cancelled, one Windows-only native-DACL test skipped**. This includes
  both isolated Node 24 allocation probes. Ordinary tests use concurrency four.
- `npm run test:host`: **51 passed**, with complete TAP totals. This includes
  actual HTTP routing/authentication, credential-free voice preflight, streamed
  payload limits, body disposal, all-provider mounting and lossless large fire
  snapshot transport checks.
- Production build, import/package ownership checks, formatting, setup doctor,
  immutable-bootstrap checkout check and whitespace checks passed.
- Both hosted and original upstream builds were checked to preserve the
  distinction between hosted deployment settings and the local key editor.
- Dependency audit reported zero known vulnerabilities in both production-only
  and complete installed dependency inventories at the time of this check.

The source is published and then explicitly deployed: this connector-created
Vercel project does not automatically deploy every Git commit. Use
`/build-info.json` and `/api/health` to compare the revision of the running frontend
and provider function. The live verification results are recorded below after
deployment. No credentialed voice, paid map or other paid-provider request was
made to validate this repair.

### Live checks of the repair

The complete repair was published as
`76cac7c479ad2757966ec5cca1c1ef10ae814456` and deployed successfully as
`dpl_2apLty3cmBQE9ZB9TFHycFbKWWio`. Both frontend build metadata and API health
reported that exact revision. The GitHub Pages workflow and all three CI jobs
(Node 24.14, Node 26, Windows onboarding) completed successfully.

Public checks at approximately 23:51–23:54 UTC on 2026-09-16:

| Check | Observed result |
| --- | --- |
| GitHub Pages entry | Browser reached the full application's stable Vercel URL |
| Host health | HTTP 200; 20 providers mounted; revision matches frontend |
| Voice preflight | HTTP 200; `VOICE_NOT_CONFIGURED`, available=false; accurate server-setup message |
| Token request with configuration confirmed absent | Structured HTTP 503 with the same configuration code; no OpenAI call |
| Capabilities | 17 source groups; six optional groups accurately marked as requiring configuration/access/persistent service |
| Civilian aircraft around Austin | HTTP 200; 455 aircraft records |
| Military aircraft | HTTP 200; 232 aircraft records |
| Satellites | HTTP 200; 20 station orbital records including ISS |
| Radio | HTTP 200; 750 stations; stale=false, degraded=false |
| Cameras | HTTP 200; 3,661 catalogue entries, 2.63 MB response |
| Launches | HTTP 200; 25 records |
| Melbourne weather | HTTP 200; status=ready using the required latitude/longitude parameters |
| FIRMS/TomTom configuration | HTTP 200; hasKey=false |
| AIS | Explicit HTTP 503 persistent-service requirement |
| Invalid terrain coordinates | HTTP 400; rejected before acquisition |
| Unknown nested API/voice suffix | JSON 404 |
| Hosted local key editor/debug writer | JSON 404 as intended |

The first weather probe used shortened query names rather than the documented
contract and correctly received HTTP 400; the corrected latitude/longitude
request above succeeded. The source status DOM contained the correct six setup
requirements and voice guidance. The controlled browser still cannot initialize
WebGL. That exposed a further usability issue: the startup recovery overlay
covered the normal source-status button. The follow-up adds a Data sources action
inside the recovery panel; the normal functioning globe is unchanged.

These catalogue/HTTP checks do not certify individual broadcaster playback,
paid voice sessions or 3D rendering. The complete runtime remains dependent on
the external requirements in the audit record.

## Earlier baseline — 2026-09-16

## Local source verification

- Complete upstream pinned to `0d41b6be5490db1f10a171f238be75db4d4ec3b4`.
- Full production build passed: 606 transformed modules, original standalone composition retained.
- Original import/package boundary checks passed (715 modules,54 portable entries).
- Original formatting check passed (918 source files).
- Original suite:325 files,4159 tests;4158 passed,0 failed/cancelled,1 Windows-only native-DACL test skipped. Ordinary tests used concurrency4; both GC allocation probes ran independently with Node24.19.0 and --expose-gc.
- Production host integration suite:12 tests passed. Covers mount/routing behavior, missing API responses, safe static serving, hosted key-editor/log blocking, Connect route-case/dot authentication bypass regression, metered endpoint admission and throttle, origins, asynchronous rejection, and AIS bridge behavior.
- Bootstrap verification: immutable source checksum, archive path/link rejection, initial payload consistency, repeated installation.

## Production deployment

Live application: https://november-1st-sable.vercel.app/

Verified deployed source: `eae6e910824d4ce7d10c51cbb95ea8c2f3b43b55`. Vercel deployment: `dpl_zXuyZpBtWGBa5bZXnQ7QvbyLGK37`. `/build-info.json` reports the exact target and upstream revisions. The full frontend and one Node provider function deployed successfully. Later documentation/test-only commits do not automatically redeploy this connector-created project; automatic Git deployment is not configured.

Live read-only checks on 2026-09-16 (approximately22:46UTC):

| Check | Observed result |
| --- | --- |
| Full application HTML and build identity | HTTP200; full original application shell; exact source identity |
| Health and capabilities | HTTP200;20 request providers mounted; configuration distinguished from feed availability |
| Civilian aircraft | HTTP200;89 aircraft through the public ADS-B fallback on the initial deployment |
| Launches | HTTP200;25 launch records on the initial deployment |
| Melbourne weather | HTTP200; current22:30 observation on the initial deployment |
| Military aircraft after route fix | HTTP200;242 records,191 positioned; sampled observations0–1.1seconds old |
| Satellite station catalogue | HTTP200;20 records, including current ISS orbital elements |
| Radio catalogue | HTTP200;750 stations; stale=false and degraded=false |
| Camera catalogue | HTTP200;3482 entries across11 providers;2.51MB response |
| FIRMS and traffic status | HTTP200;hasKey=false, accurately reporting absent configuration |
| AIS including nested track route | HTTP503; explicit persistent-service requirement |
| Unknown nested API | JSON404 from host, not a static HTML fallback |
| Hosted credential editor | JSON404 as intended |

The first live deployment revealed Vercel's native dynamic filename did not catch nested API paths. An explicit `/api/:path*` rewrite to the `api/index.js` function fixed this; real nested satellite/radio/camera/military responses above verify the correction. A native-entry integration regression test was added, bringing host tests to12.

The deployment browser loaded the full interface and local Cesium assets, but reported “The browser supports WebGL, but initialization failed.” The recovery UI displayed correctly. This prevents certification of globe/cockpit interactions in that browser; it is not evidence that the application fails on all supported hardware. Catalogue success does not prove playback of every camera or radio stream.

The existing compact Dream Unity portal deployment has not been redirected. The live link above is the new complete-source application.

## Scope of evidence

Source inclusion and a green build do not prove every live provider or every graphical interaction works. The full layer catalogue and original interaction modules are retained; they were not replaced by a reduced application. External feeds can be rate-limited, unavailable, geographically restricted or inaccessible from the test network.

A keyless local live probe returned actual military aircraft and bundled camera catalogue entries. Several external providers timed out or returned explicit degraded/unavailable responses from the workspace. The satellite probe also returned current ISS orbital elements. Bundled camera records are not proof that every camera video stream is live. Credentialed capabilities were not exercised because credentials were not supplied.

The browser environment previously reported unavailable WebGL and could not open the local service. A complete hardware-accelerated globe/cockpit/voice walkthrough cannot be inferred from HTTP or unit tests. Verify these on a supported browser with WebGL and the relevant provider configuration.

## Deployment constraints retained explicitly

- Vercel runs the full frontend and20 request-oriented upstream providers. Persistent Node mode mounts21 including AIS.
- Continuous vessel ingestion requires a persistent host and AISStream key.
- Vercel has invocation duration, payload and per-instance state limits. Long radio/camera streams and unusually large FIRMS/global responses may require the persistent host. A function is not a replacement for an unlimited persistent process.
- OpenAI voice/HUD, FIRMS, TomTom and optional photorealistic providers require their own configuration and, where applicable, account entitlement. No paid provider was activated during this implementation.
- Metered routes require deliberate admission configuration. Per-process limits are not a shared global budget.
- New source/deployment is separate from the pre-existing compact application. This work does not imply the old portal URL has been changed.
