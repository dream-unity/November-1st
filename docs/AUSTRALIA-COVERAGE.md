# Australian live camera and radio coverage

Source audit date: **17 September 2026**. Source evidence, catalogue counts and deployed playback checks are recorded separately below. A listed feed is not a guarantee of current availability.

## Camera inventory

The catalogue contains **15 in-app camera entries: 13 additions and the two existing Sydney/Melbourne entries**. A separate collection contains **8 “Watch on publisher” links**; these are not counted as in-app live cameras. Several feeds show different views of one site, so camera count is not city count.

| State or territory | In-app entries | Publisher links | Locations represented |
| --- | ---: | ---: | --- |
| New South Wales | 5 | 0 | Sydney Harbour; Bonny Hills; Orange FalconCam, three views |
| Victoria | 1 | 2 | Melbourne skyline; 367 Collins Falcons, two views |
| Queensland | 0 | 3 | Southport/Main Beach; Agnes Water; Seventeen Seventy |
| South Australia | 2 | 3 | Port Lincoln osprey nest, two views; Adelaide, three views |
| Western Australia | 3 | 0 | Busselton Jetty panorama and two underwater views |
| Northern Territory | 4 | 0 | Darwin Zen Rooftop, three views; Fannie Bay |
| Tasmania | 0 | 0 | No eligible continuous live source verified in this audit |
| Australian Capital Territory | 0 | 0 | No eligible continuous live source verified in this audit |
| **Total** | **15** | **8** | **Coverage is not available in every city.** |

The new in-app records are in `config/cctv_sources.australia.json`; the existing two are in `config/cctv_sources.global.json`. Separate publisher destinations are in `config/cctv_sources.australia-publisher.json`. Coordinates identify approximate public landmarks or owner-published locations, not surveyed camera positions.

### Evidence for the additions

| Publisher | New views | Evidence observed |
| --- | ---: | --- |
| [Bonny Hills Beach House](https://www.bonnyhillsbeachhouse.com.au/surfcam-live/) | 1 | Owner-linked YouTube broadcast: current live metadata, playable status and embedding allowed |
| [Charles Sturt University FalconCam](https://science-health.csu.edu.au/falconcam/live-streams) | 3 | Ledge, nest box and tower broadcasts: current live metadata and embedding allowed |
| [Busselton Jetty](https://busseltonjetty.com.au/live-webcams/) | 3 | Panorama and north/south underwater broadcasts: current live metadata and embedding allowed |
| [Port Lincoln Osprey](https://sharkcagediving.com.au/osprey) | 2 | [PTZ](https://www.youtube.com/watch?v=xW1YcHVp7Ko) and [wide](https://www.youtube.com/watch?v=_gIf6CYeDG8) broadcasts: current live metadata and embedding allowed |
| [Zen Rooftop Darwin](https://www.zenrooftopbardarwin.com/live-rooftop-views/) | 3 | Original IPCamLive players decoded video with advancing playback time and live indication |
| [Darwin Trailer Boat Club](https://dtbc.com.au/live-camera/) | 1 | Original IPCamLive player decoded video with advancing playback time and live indication; intermittent buffering observed |

YouTube source checks require `isLiveNow`, successful playability and permission to embed. They do **not** independently prove decoded frames in the application. Source browser playback likewise does not prove deployment playback. A keyless YouTube watch-page check can return `unknown` from the hosting network. The optional **server-side** `YOUTUBE_API_KEY` enables the official video API fallback for an unknown result; it must not be put in browser configuration. It does not override an explicit ended, offline or embedding-denied result.

### Why some cameras open on their publisher

- **Adelaide:** [River Torrens/Elder Park](https://www.cityofadelaide.com.au/webcams/river-torrens-and-elder-park/), [Town Hall South](https://www.cityofadelaide.com.au/webcams/town-hall-south/) and [Town Hall North](https://www.cityofadelaide.com.au/webcams/town-hall-north/) decoded 1280×720 video on their owner pages, with playback advancing approximately 74–122 seconds. A directly opened Castr player reported “Content not available”. The exact restriction was not established; no stream was extracted to circumvent it.
- **Melbourne:** [367 Collins North](https://www.youtube.com/watch?v=dNKk0ivuWe4) and [South](https://www.youtube.com/watch?v=oibsohQ14cY) reported current live broadcasts but explicitly disallowed embedding.
- **Southport:** the [club camera](https://sslsc.com.au/surf-cam-weather/) decoded advancing video and its live playlist advanced. The club’s [terms, section 9.1](https://sslsc.com.au/terms-of-use/), require written consent for retransmission/distribution; this implementation links to the owner.
- **Gladstone Ports Corporation:** [Agnes Water](https://gpcl.com.au/environment/live-beach-cameras/agnes-water-webcam/) and [Seventeen Seventy](https://gpcl.com.au/environment/live-beach-cameras/1770-webcam/) showed advancing decoded media, infinite duration and live indication. Agnes Water needed a reload after a media/network error. Seventeen Seventy remained dark with a loading overlay; independent scene motion and a visible current clock were not confirmed. These players lack a reviewed in-app current-live verifier and remain publisher links.

Snapshots, timelapses, ended broadcasts and known prerecorded fallbacks were excluded. Examples include Adelaide’s still-image views, offline City Skate, Tasmanian refreshed-image cameras, ended ReefCam streams and JCU Daintree recordings. Timeouts and unavailable pages were treated as unverified, not proof that no live service exists. ACT and Tasmania remain explicit coverage gaps.

## Radio inventory and verification

The captured `/api/radio/stations?country=AU` result contains **306 unique entries: 79 curated sources and 227 community-directory sources**. The curated set comprises **51 MP3/AAC streams and 28 live-only HLS streams**, representing all six states, the ACT and the NT. This does not establish coverage of every city. **262 entries have no coordinates** and receive no invented map pin.

Curated progressive sources returned public HTTPS audio bytes without a finite content length. Curated HLS sources had no end marker, advanced sequence numbers or final segments across two requests, and returned media segment bytes. Publisher provenance was reviewed separately. These checks establish transport evidence at the recorded time, not audible programme identity or successful browser playback.

The **227 community entries are not individually confirmed live streams** and retain unknown playback classification. The 306 total must not be described as 306 verified live stations. Duplicate stream aliases, mislabelled playlist files, a finite forest recording and an ABC candidate with mismatched station provenance were excluded. Old ABC URLs returning HTTP 403 were not admitted. Publisher outages, geographic restrictions and later URL changes remain possible.

This audit does not claim that every repository error or potential failure has been resolved.

## Deployed verification, 17 September 2026

The implementation at commit `9714ea41a54a3d2a9b7f464c83922fe447129aea` was deployed to production. `/api/health` and `/build-info.json` returned that exact commit. Both GitHub Pages entry links preserved their feed/country query when redirecting to the application:

- [Australian cameras](https://dream-unity.github.io/November-1st/?feed=cctv&country=AU)
- [Australian radio](https://dream-unity.github.io/November-1st/?feed=radio&country=AU)

Production returned 3,768 camera entries, including 231 Australian entries: **15 declared live sources and 216 snapshots**, with **8 publisher links counted separately**. The default Live video filter showed 15; Adelaide correctly showed no in-app cameras and three publisher links. Snapshot entries are not counted as continuous video.

Two representative Darwin cameras were verified **inside the deployed app**: Zen Storm decoded 1920×1080 video and advanced from 21.00 to 32.00 seconds; Fannie Bay decoded 1920×1088 and advanced from 19.04 to 31.04 seconds. Both showed intermittent buffering. The application's Pause control removed each iframe completely. Other Darwin source players had been checked separately during source research; these two are the deployed browser playback samples.

Busselton South's deployed status check was **unconfirmed**, so the app correctly withheld its iframe and offered retry/source controls. This is not evidence that the owner's broadcast is offline. The 15 listed entries must not be described as 15 successfully verified in-app streams. A configured server `YOUTUBE_API_KEY` is an optional official route for checking live status when the public watch-page check is unavailable; no key was configured in this release.

Australian radio returned **306** entries and the existing Ukraine endpoint retained **152**. ABC Radio Hobart's HLS stream reached the player's media-driven playing state, paused, resumed and stopped. Territory FM's progressive audio also reached playing. Switching to Ukraine retired the Australian selection, and returning to Australia restored the full directory. Audio is not attached to the page DOM, so these browser observations establish the player event/state flow rather than an independently measured audio clock or identified spoken programme.

Validation passed: the full unit suite and serialized allocation gates, all **59 host tests**, package boundaries, formatting and production build. The final publisher-admission changes passed their six focused tests. [GitHub CI](https://github.com/dream-unity/November-1st/actions/runs/35203962946) passed on Node 24.14, Node 26 and Windows onboarding. GitHub Pages deployment succeeded.

The cloud test browser cannot initialize WebGL. The existing recovery correctly kept radio and camera directories usable, but the 3D globe itself could not be visually verified in that browser.

A separate bounded request batch across all 15 Australian status endpoints returned one live result (Zen Harbour), five HTTP 200 unknown results (YouTube), and nine client-side transport timeouts. The nine unanswered requests cannot be classified as live or offline from that batch. The successful YouTube results and the deployed browser sample demonstrate a current verification limitation; they do not establish that every YouTube source is unavailable.

The post-verification cleanup removes internal review instructions from Darwin attribution copy and records this report. Playback and provider logic remain the code verified above.
