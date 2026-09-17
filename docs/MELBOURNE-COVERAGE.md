# Greater Melbourne live cameras and radio

Audit: 17 September 2026 UTC (18 September in Melbourne). This is a bounded source and repository audit, not a guarantee that every suburb has a public camera or that every possible software error is resolved.

## Scope and behavior

The new **Greater Melbourne** selector covers explicitly reviewed metropolitan/suburban services, including represented Mornington Peninsula and Yarra Ranges locations. It does not classify all Victorian sources as Melbourne. The radio endpoint is `/api/radio/stations?country=AU&city=melbourne`; the camera directory applies the same explicit metropolitan metadata locally.

- [Melbourne cameras](https://dream-unity.github.io/November-1st/?feed=cctv&country=AU&city=melbourne)
- [Melbourne radio](https://dream-unity.github.io/November-1st/?feed=radio&country=AU&city=melbourne)

The default camera filter remains **Live video**. Snapshot refreshes, MP4 recordings, ended YouTube streams and known prerecorded fallbacks are not substitutes for continuous live footage. The live HLS relay rejects ENDLIST/VOD playlists and confines media requests to the reviewed stream origin and directory. An unconfirmed YouTube current-live check withholds the iframe and offers the publisher source; it does not silently serve an archive.

Country-to-city radio changes use separate request identities. Late requests cannot overwrite a newer selection. A failed change of scope must not leave an Australia-wide list under a Melbourne label. Community Radio Browser entries mentioning Melbourne are separately labelled inferred location claims; only the curated services have publisher-reviewed Melbourne geography. Unknown station coordinates remain null.

## Camera source evidence

Added **7 camera entries**, bringing Greater Melbourne to **8 in-app entries plus 2 separate publisher-only links**. The 7 additions comprise 6 YouTube broadcasts with current-live metadata and 1 HLS stream with decoded owner-page video. These are source evidence counts, not a claim that all 8 play successfully in the deployed app. Australia now has 22 listed live camera entries.

The source registry records exact publisher URLs, verification timestamps and approximate landmark coordinates. These identify locations, not calibrated camera poses. Source metadata checks and decoded browser playback are different levels of evidence.

| Added view | Public publisher | Evidence at audit |
| --- | --- | --- |
| Sunshine station | [Sunshine Railcam](https://www.youtube.com/watch?v=5nUQRLkivms) | Current-live YouTube metadata, successful playability and embedding enabled; creator-owned channel, not an official railway-operator camera |
| South Yarra station | [Steven Hoefel](https://www.youtube.com/watch?v=7Lu9rWg7ngI) | Current-live YouTube metadata and embedding enabled; title identifies station; creator attribution retained |
| Mount Martha beach/sailing grounds | [Mount Martha Yacht Club](https://www.mmyc.org.au/weather-webcam) | Owner page embeds the exact current-live YouTube broadcast |
| Mornington harbour | [Mornington Yacht Club](https://www.morningtonyc.com.au/weathercam/) | Owner page links the current-live YouTube broadcast |
| Elwood foreshore | [Elwood Sailing Club](https://www.elwoodsc.com/blog/esc-webcam-2/) | Owner channel resolves to a current-live YouTube broadcast with embedding enabled |
| Spotswood public trailer yard | [Spotswood Trailers](https://spotswoodtrailers.com.au/) | Owner-published continuous HLS: advancing media sequence, no end marker, decoded 1280×720 video with increasing playback time and a current Melbourne timestamp |
| West Gate Bridge | [Spotswood Trailers bridge camera](https://spotswoodtrailers.com.au/WestGateBridgeTrafficCameraSpotswoodTrailers.html) | Owner dynamic iframe identifies current broadcast; YouTube liveNow/OK/embedding enabled. This is a separate view from the trailer yard |

Sunshine and South Yarra landmark coordinates come from the official [Sunshine](https://www.metrotrains.com.au/stations/sunshine/) and [South Yarra](https://www.metrotrains.com.au/stations/south-yarra/) station maps. Spotswood coordinates come from the owner map, corroborated by the bridge broadcast's mounting-location description.

The existing Platinum Apartments Melbourne skyline remains included. The two 367 Collins Falcons broadcasts remain separate **Watch on publisher** links because the publisher disables embedding. They are not counted as in-app cameras. No station, camera or scene is duplicated merely to increase the count.

### Excluded or unresolved candidates

- [Fed Square Fed Cam](https://fedsquare.com/fed-cam) remained offline on the owner's player, including one recheck after its published morning opening time. Its player also did not advertise third-party embedding.
- Royal Melbourne Yacht Squadron feeds refreshed JPEG images, not continuous video.
- Davey's Bay player reported restricted access; no bypass or stream extraction was attempted.
- Rod Laver Arena earthTV was under maintenance; the displayed alternative was not Melbourne footage.
- Reef Cam expressly uses prerecorded fallback when offline; current real-time footage was not established.
- Zoos Victoria's older animal camera collection included ended broadcasts; current live footage was not established.
- The Victorian transport agency's operational-camera count is not a public continuous-stream inventory. No unverified staff cameras were added.
- Wyndham Harbour public YouTube metadata was live, but the relationship to the current owner website (which requires email signup) was not corroborated. No gated content was accessed; this candidate remains excluded.
- Unlocated city-intersection channels were held when precise public location/provenance could not be corroborated.

These are availability/evidence gaps, not proof that the locations have no live camera. Publisher schedules, changing broadcast IDs, embedding restrictions and network failures remain possible. Public YouTube metadata from the research network does not prove decoding in the app. Vercel's keyless metadata check can return unknown; the existing optional server-only `YOUTUBE_API_KEY` supplies an official fallback without weakening the current-live requirement. No key is provisioned by this change.

## Radio evidence

Added 21 distinct Melbourne/metro programmes; 4 existing services received explicit Melbourne metadata. Australian curated directory: 79 → 100. Melbourne curated view: 25 services.

Each new progressive stream returned 16,384 bytes (commercial 3MP/Magic: 8,192), an audio MIME type and no finite Content-Length. GOLD/KIIS returned advancing HLS media playlists without ENDLIST and playable AAC segment bytes. Audible programme identity was not checked. No coordinates were inferred.

The Melbourne scope covers local metro stations plus suburban services in Greater Melbourne, including Mornington Peninsula and Yarra Ranges. National ABC/SBS and unrelated Victorian stations remain outside the Melbourne scope.

| New service | Geography evidence | Exact stream provenance | Live check |
|---|---|---|---|
| 3CR 855 AM | Official homepage locates the station at 21 Smith Street, Fitzroy, Melbourne. [source](https://www.3cr.org.au/) | Official homepage embeds Triton td-player station=3CR; Radio Browser supplied the public AAC transport. [source](https://www.3cr.org.au/) | 16384 audio bytes; continuous transport |
| 3ZZZ 92.3FM | Official homepage identifies the station as serving multicultural Melbourne. [source](https://www.3zzz.com.au/) | Official stationnow API lists 3ZZZAAC.aac with an optional distributor query. [source](https://www.3zzz.com.au/wp-json/metaradio/v1/stationnow/?station=1) | 16384 audio bytes; continuous transport |
| 3KND Kool N Deadly | Official homepage describes Melbourne Indigenous radio and gives its Bundoora studio address. [source](https://www.3knd.org.au/) | Official homepage links player.listenlive.co/71121, whose configuration identifies the 3KND mount. [source](https://player.listenlive.co/71121) | 16384 audio bytes; continuous transport |
| SYN 90.7FM | Official About page says SYN 90.7 FM broadcasts across Naarm/Melbourne. [source](https://www.syn.org.au/about) | Official homepage offers its live player; public 3SYNAAC transport discovered through Radio Browser AU. [source](https://www.syn.org.au/) | 16384 audio bytes; continuous transport |
| 3WBC 94.1FM | Official homepage describes local content for the inner eastern suburbs of Melbourne. [source](https://www.3wbc.org.au/) | Exact stream URL embedded in official homepage player. [source](https://www.3wbc.org.au/) | 16384 audio bytes; continuous transport |
| 96.5 Inner FM | Official About page identifies service to Banyule, Manningham and Darebin and Heidelberg studios. [source](https://www.innerfm.org.au/about/) | Official homepage links player.listenlive.co/71581, whose configuration identifies the 3NR mount. [source](https://player.listenlive.co/71581) | 16384 audio bytes; continuous transport |
| Plenty Valley FM 88.6 | Official homepage identifies Melbourne outer north east coverage and Mill Park studios. [source](https://www.pvfm.org.au/) | Official stationnow API lists 3PVRAAC.aac with an optional distributor query. [source](https://www.pvfm.org.au/wp-json/metaradio/v1/stationnow/?station=1) | 16384 audio bytes; continuous transport |
| Radio Eastern FM 98.1 | Official homepage metadata describes community radio in Melbourne outer east. [source](https://www.radioeasternfm.com.au/) | Exact stream URL listed in official stationnow API. [source](https://www.radioeasternfm.com.au/wp-json/metaradio/v1/stationnow/?station=1) | 16384 audio bytes; continuous transport |
| 3MDR 97.1FM | Official About page states service from Ferntree Gully to Emerald and Silvan to Berwick, and Upwey South studios. [source](https://3mdr.com/about/) | Official broadcaster About page advertises livestream; public 3MDRAAC transport discovered through Radio Browser AU. [source](https://3mdr.com/) | 16384 audio bytes; continuous transport |
| 88.3 Southern FM | Official homepage metadata identifies Bayside Melbourne community radio. [source](https://southernfm.com.au/) | Exact stream URL embedded in official homepage JavaScript player. [source](https://southernfm.com.au/assets/index-BzhH8Nyl.js) | 16384 audio bytes; continuous transport |
| RPP FM 98.7 | Official About page states Mornington Peninsula, Frankston and southern Kingston coverage, and Mornington studios. [source](https://www.rppfm.com.au/about) | Exact stream URL embedded as data-url on official /programs-1 player page. [source](https://www.rppfm.com.au/programs-1) | 16384 audio bytes; continuous transport |
| Golden Days Radio 95.7FM | Official contact page identifies studios in Glen Huntly. [source](https://goldendaysradio.com/contacts/) | Official /gdr-streaming-player/ embeds Asura golden_days_radio player pointing to the same public station server. [source](https://goldendaysradio.com/gdr-streaming-player/) | 16384 audio bytes; continuous transport |
| 89.9 TheLight | Official homepage title identifies family-friendly Christian radio in Melbourne. [source](https://www.thelight.com.au/) | Public HTTPS stream on broadcaster thelight.com.au domain discovered through Radio Browser AU; broadcaster live-radio homepage reviewed. [source](https://www.thelight.com.au/) | 16384 audio bytes; continuous transport |
| Vision Australia Radio Melbourne | Official website labels this regional live player Melbourne; other Vision Australia regional feeds are excluded. [source](https://radio.visionaustralia.org/) | Official website Melbourne live-listen option links player.listenlive.co/65771, whose configuration identifies the 3RPH mount. [source](https://player.listenlive.co/65771) | 16384 audio bytes; continuous transport |
| Sunbury Radio 99.3FM | Official homepage title identifies service to Sunbury and Melbourne north west. [source](https://www.sunburyradio.com.au/) | Exact stream URL listed in official stationnow API. [source](https://www.sunburyradio.com.au/wp-json/metaradio/v1/stationnow/?station=1) | 16384 audio bytes; continuous transport |
| Yarra Valley FM 99.1 | Official homepage identifies Healesville studios and service to Yarra Ranges, Cardinia and eastern Melbourne metropolitan areas. [source](https://yarravalleyfm.org.au/) | Exact stream URL published on official /listen.html live-simulcast page. [source](https://yarravalleyfm.org.au/listen.html) | 16384 audio bytes; continuous transport |
| 3MBS Digital | Official broadcaster site is branded 3MBS Melbourne. [source](https://www.3mbs.org.au/) | Exact 3MBS_DAB.mp3 URL in official page JavaScript switch for the DAB live channel; FM variant was not added. [source](https://www.3mbs.org.au/_next/static/chunks/pages/%5B%5B...slug%5D%5D-c098fc4014802ff7.js) | 16384 audio bytes; continuous transport |
| GOLD104.3 Melbourne | Broadcaster homepage title explicitly identifies Melbourne. [source](https://www.gold1043.com.au/) | Exact streamUrl embedded in broadcaster homepage player configuration. [source](https://www.gold1043.com.au/) | HLS advancing; segment 200 |
| KIIS 1011 Melbourne | Broadcaster homepage title explicitly identifies Melbourne. [source](https://www.kiis1011.com.au/) | Exact streamUrl embedded in broadcaster homepage player configuration. [source](https://www.kiis1011.com.au/) | HLS advancing; segment 200 |
| 3MP 1377 Melbourne | Homepage describes Melbourne's Easy Music - 1377 AM & DAB+ 3MP. [source](https://3mp.com.au/) | Exact streamUrl embedded as domainInfo.streamingLink in official homepage. [source](https://3mp.com.au/) | 8192 audio bytes; continuous transport |
| Magic 1278 Melbourne | Official Melbourne-local programme text (Magic Mandy with the latest on Melbourne's roads; Melbourne's friendliest brekky host) in station homepage. [source](https://www.magic1278.com.au/) | Exact streamUrl embedded as domainInfo.streamingLink in official homepage. [source](https://www.magic1278.com.au/) | 8192 audio bytes; continuous transport |

Existing services tagged: PBS 106.7FM (Collingwood), Triple R, JOY 94.9, ABC Radio Melbourne. Existing stream verification was preserved.

## Exclusions

- J-AIR: Official live URL returned finite HTML, not audio; not curated.
- Kiss FM: HTTPS stream probe returned 502.
- 3MBS FM: Official FM transport was blocked in this environment; verified official DAB programme included instead.
- 3ZZZ DAB and second bitrate variants: Official DAB configuration shares FM AAC fallback; no evidence of a distinct programme, excluded as possible duplicate.
- 3WBC second stream: No evidence of continuous distinct programming; primary programme only.
- Casey Radio / 979fm / WYN FM / North West: Official source or playable HTTPS stream not established within the verification batch.
- National ABC and SBS: National services are not Melbourne-local services; retained in Australia without Melbourne tag.
- 3AW: Official homepage config ssoEnabled=yes; no addition without clear public access basis.
- RSN: Official player config requireLogin=true and requireExpatInOtherRegion=true.
- Nova 100 / Smooth 91.5: Official station pages returned 403. Exact official stream could not be independently established in this batch.
- Fox / Triple M Melbourne: Official network homepages returned 403. LiSTNR station pages returned empty SSR station data; no official stream established.
- ABC Radio Melbourne: Already present in the curated directory.

Radio Browser country query returned 1,758 discovery rows, including duplicate bitrate variants, national services, HTTP feeds and unrelated regional stations. Discovery source: https://de1.api.radio-browser.info/json/stations/bycountrycodeexact/AU?hidebroken=true&limit=10000. Each accepted service was checked against its official broadcaster page. Full machine-readable checks are in melbourne-radio-evidence.json.

## Release verification

Local validation passed on Node 24.19: **4,552 unit/allocation tests passed**, one Windows-only test skipped on Linux; **59 host tests passed**; 736-module import checks, package boundaries, 939-file formatting check and the production build passed. The final Elwood registry addition also passed all 9 camera admission tests. The initial implementation commit `17f395870d5262e78f8a90518304eefa67119d58` passed GitHub CI (Node 24, Node 26 and Windows onboarding) and GitHub Pages deployment. Production `/api/health` and `/build-info.json` confirmed that exact commit and the complete upstream application.

Both GitHub Pages deep links preserved `feed`, `country=AU` and `city=melbourne`. The camera directory displayed all 8 Melbourne entries, zero Melbourne snapshots and the 2 separately counted publisher links. The Australia catalogue contained 238 cameras: 22 listed live sources and 216 snapshots; global catalogue counts may change as upstream directories refresh.

The first radio response had 28 Melbourne entries, including 25 curated. Production review identified an alternate-host 3KND duplicate and a login-restricted 3AW entry returning via Radio Browser; exact ID/URL exclusions remove both without removing any curated Melbourne service. The resulting projection has 26 entries for that directory snapshot (25 curated plus one explicitly labelled community match).

Inside the deployed app, **3CR 855 AM** reached the media-driven playing state, paused, resumed and stopped. **GOLD104.3 Melbourne** also reached playing through its HLS transport. Switching to the nationwide Australia directory cleared the old list and stopped the selected Melbourne station; switching back restored the metropolitan list. Audio is not attached to the DOM: these observations verify actual media event/state flow, not audible programme identity or an independently measured audio clock.

All seven Melbourne YouTube status requests returned HTTP 200 with **unknown current-live status** on the hosting network. The Sunshine browser check consequently withheld the iframe and offered retry/source controls. This is a current deployment limitation, not an offline finding and not successful in-app playback. The broadcasts had current-live metadata from the research network. A server-side `YOUTUBE_API_KEY` remains unconfigured; it is the existing optional official verification fallback.

The first deployed Spotswood HLS test exposed a real compatibility defect: playlists arrived, but video fragments returned HTTP 502 because the publisher labelled MPEG-TS bytes as `text/vnd.trolltech.linguist`. The correction accepts only that specific `.ts` MIME mismatch after bounded MPEG-TS packet validation, then serves `video/mp2t`. HTML/text errors, malformed packets, origin escapes, oversized resources and archived playlists remain rejected. Final playback verification is recorded below.

The cloud browser could not initialize WebGL. Recovery kept the radio and camera directories usable, but the globe itself was not visually verified in this environment.

The fragment MIME repair and final directory cleanup passed **96 focused regressions**, all **59 host tests**, formatting and production rebuild. A freshly fetched real camera segment sample also passed the actual relay function, preserving all bytes and range while returning `video/mp2t`.
