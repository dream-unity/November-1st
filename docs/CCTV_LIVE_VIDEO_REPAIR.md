# Continuous CCTV video repair — 2026-09-17

## Why the previous release showed snapshots

The production catalogue at revision `300c84d` contained 3,661 cameras and
**every entry had `feedType: image`**. The preceding repair added a functioning
video player, but did not connect it to the streaming URLs that Caltrans already
publishes. The Caltrans adapter read `imageData.static.currentImageURL` and
discarded `imageData.streamingVideoURL`. A frequently refreshed JPEG is still a
snapshot, not continuous video.

Caltrans documents these as distinct fields in its
[CCTV field descriptions](https://cwwp2.dot.ca.gov/documentation/cctv/cctv-field-description.htm)
and describes public dataset integration in its
[CCTV documentation](https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm).

## Corrections

| Area | Confirmed defect | Repair |
| --- | --- | --- |
| Source ingestion | Official video URLs were discarded | Validated Caltrans HLS URLs take precedence over their still previews; image-only sources remain snapshots |
| Source identity | Unnamed camera IDs depended on the order of rows and successful district downloads | Stable source identity prevents a reordered catalogue or district outage from assigning an existing ID to another camera |
| Discovery | Thousands of images obscured the absence of video | CCTV opens in Live video, with separate Snapshot, Clips/other videos and All cameras filters and explicit counts |
| Media truthfulness | Video container support was confused with live coverage | Declared live streams, finite clips, unidentified video and snapshots carry distinct classifications |
| Playback state | Metadata/can-play events could look like playing media | Playing, paused, buffering, blocked, ended and unavailable states reflect media events; explicit Play/Pause/Retry controls remain available |
| Playback lifecycle | Pause, browser autoplay refusal and hidden-page work were insufficiently distinguished | User pause is respected; browser refusal retains a manual play path; visibility and selection/close teardown cancel obsolete work |
| Globe integration | The original projection expected only the old ready state | The original camera panel and globe projection recognize the expanded media states without replacing the full application |
| Fragment integrity | A generic range clamp could silently shorten an HLS fragment | Oversized fragments fail explicitly; exact finite ranges are validated, and a safely bounded ignored-range response is sliced correctly |
| Transport status | Missing/expired stream resources became generic relay errors | Actual upstream 404/429/503 statuses remain distinguishable; stale media resources are not reused |
| Request handling | Unsupported methods and malformed camera paths could reach catalogue acquisition | Early method/path rejection avoids unnecessary provider work |
| Provider safety | New streaming URLs extend the relay surface | Exact official origin/district/path validation and the existing registered-directory restrictions are preserved |

The existing camera cap is retained. A provider-declared stream is a candidate
for playback, not a guarantee that its camera is online. The application never
silently replaces failed live video with a still image and calls it live.

## Verification evidence

Source checks obtained master playlists, variant playlists and binary MPEG-TS
segments from two official streams:

- Caltrans D3 **Hwy 5 at Pocket**: media sequence advanced from 981 to 985;
  one acquired segment contained 511,360 bytes.
- Caltrans D7 **I-110: (196) Avenue 26 Off Ramp**: media sequence advanced from
  56,719 to 56,723; one acquired segment contained 146,640 bytes.

Neither playlist contained an end marker. Decoded frames showed roadway scenes.
An independent check through the application's HLS relay acquired a 509,856-byte
D3 segment and observed sequence 984 → 986. These observations establish
continuously advancing video; they do not establish exact camera-to-viewer
latency or the accuracy of a camera's burned-in clock.

The first sampled D4 and D11 stream URLs returned HTTP 404 despite appearing in
the official catalogue. Those failures are retained as evidence of the coverage
limit, not counted as playable cameras.

A native hosted-API regression follows the entire request chain over HTTP:
catalogue → master → variant → binary segment → advancing variant. It includes
Vercel's injected rewrite parameter and encoded resource query, checks no-store
playlists, and proves out-of-directory requests never reach the upstream.

Final automated totals and deployed browser results are recorded in
[DREAM_UNITY_VERIFICATION.md](DREAM_UNITY_VERIFICATION.md).

## Practical limits

- The initial continuous-video integration is Caltrans, California. Other
  agencies' still-only feeds remain under Snapshots.
- The browser player supports native HLS where available and hls.js elsewhere.
  It starts selected live video muted; browsers may require a Play action.
- Camera outages and upstream latency remain visible. There is no claim that
  every catalogue entry has been watched or is online at all times.
- Serverless resource budgets remain enforced. This integration does not open
  unrestricted media URLs, expose credentials, or relay private cameras.
- The controlled browser cannot initialize WebGL. Actual HTML video playback
  can be tested independently; hardware-rendered globe/cockpit verification is
  a separate limitation.
