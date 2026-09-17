# Radio, cameras and traffic repair — 2026-09-17

The previous deployment checks proved that catalogues could load. They did not
establish that a visitor could find a station, hear its stream, view an actual
camera image, or read a traffic report. This repair addresses those complete
paths while retaining the full upstream globe, layers and interaction system.

## Confirmed gaps and repairs

| Area | Failure found | Resulting behavior |
| --- | --- | --- |
| Discovery | Radio was nested inside collapsed Context controls; layers defaulted off; enabling CCTV did not necessarily select a camera | Visible Live radio, CCTV cameras and Traffic reports buttons open searchable directories with explicit selection and playback |
| Graphics failure | Feed access depended on successful WebGL startup | The same provider feeds remain usable in a normal accessible dialog when the globe fails; recovery offers direct feed buttons |
| Radio transport | Unresolved playback, stalled streams and late events could leave misleading states; terminal failures could leave tuner hiss | Finite connection/stall deadlines, cancellation, retry, specific error messages and complete media cleanup |
| Audio ownership | A separate directory player could overlap the globe tuner or lose browser click activation | A direct user click synchronously stops the globe tuner before starting the shared radio transport; closing/changing tabs releases audio |
| Camera display | The camera panel treated video sources as still images | Configured video sources receive a real video element; native HLS or lazily loaded hls.js handles compatible streams |
| Camera truthfulness | Synthetic or Street View fallback images could appear to be camera availability | Strict snapshot requests return a registered camera image or an explicit failure; the directory rejects fallback/SVG replies |
| Camera transport | Relative HLS playlists were not relayed correctly; video responses could exceed serverless budgets | Registered-origin/directory restrictions, playlist rewriting, bounded redirects/bodies, finite deadlines and explicit size failures |
| Camera access | Configuring Google could put even free camera snapshots behind paid admission | Strict snapshots bypass paid-provider admission because their server path cannot call Street View; non-strict fallback requests remain protected |
| Traffic | Street Traffic animated vehicles and optional flow speeds did not supply incident reports | A separate official incident/roadworks service and searchable report panel; simulation is never presented as a report |
| Traffic integrity | Successful HTTP alone cannot establish freshness or coverage; old TomTom tiles were re-stamped as fresh | Provider update time, retrieval time, active/planned filtering, stale/partial states, coalescing and bounded retry/backoff; stale flow tiles no longer become fresh LIVE speeds |
| Globe handoff | Slow catalogue loads could override a newer target or a closed panel | Cancellation and existing camera-ownership generation checks; exact selection where available, explicit coordinate fallback otherwise; cockpit ownership is respected |
| Lifecycle/accessibility | Hidden nested controls and obsolete asynchronous work made recovery difficult | Search, region filters, explicit result counts/pagination, keyboard tabs, focus restoration, visible retry and cleanup on close |

## Coverage

- **Radio:** Radio Browser's bounded HTTPS station catalogue. Streams come
  directly from broadcasters; their outages, codecs and regional restrictions
  remain authoritative. An entry is not proof of a currently playable programme.
- **CCTV:** The existing registered public camera catalogue. Many agencies supply
  periodically refreshed images, not continuous video. Retrieval time is labelled
  separately from the camera's unknown capture time. Configured MP4/WebM/HLS is
  supported subject to the source, browser and host limits.
- **Traffic reports:** [Austin / Travis County active incidents](https://data.austintexas.gov/d/dx9v-zd7x)
  and [Fintraffic Digitraffic road announcements and roadworks](https://www.digitraffic.fi/en/road-traffic/).
  Coverage is explicitly regional, not global. These reports are separate from
  simulated Street Traffic and optional TomTom flow speeds. Finnish reports may
  only be available in Finnish; multi-point geometry is labelled approximate.
- **Globe:** Show on globe connects selected entries to the existing application.
  It does not replace the original layer or cockpit implementations, autoplay
  audio, or enable simulated traffic when opening a real incident.

## Verification standard

Targeted regressions exercise media failures and delayed events, tab/close
cleanup, source schema and byte limits, real-only snapshots, HLS rewriting and
boundaries, report freshness, camera authority and host admission. Full repository
tests, build, formatting and package ownership checks are run before publication.
Final results and deployed revision are recorded in
[DREAM_UNITY_VERIFICATION.md](DREAM_UNITY_VERIFICATION.md).

Bounded production-source probes obtained MP3/AAC frames from Deutschlandfunk,
RAC1, Houston Public Media and Radio Paradise. A Virgin UK response was a regional
restriction announcement, demonstrating why receiving audio is not a guarantee
of the intended programme. Ten of eleven initial camera probes returned JPEG
data; one returned a fallback. Visual inspection found eight road scenes, an
Austin provider outage card and an Ontario image with an older burned-in date.
The initially failing Calgary source succeeded on a direct retry. The known
Austin outage card is now rejected by exact byte fingerprint. This demonstrates
why JPEG transport alone does not prove a current camera view; provider capture
time and intermittent outages remain visible verification limits. Official
traffic responses were checked against actual schemas and publication timestamps
before integration.

The controlled browser cannot initialize WebGL, so it cannot certify a hardware
cockpit walkthrough. It can exercise the new feed interface, actual audio/video
state and image display without weakening or substituting the full globe. Paid
voice, optional provider keys and continuous AIS hosting remain separate setup
requirements documented in [the reliability audit](RELIABILITY_AUDIT.md).
