# Ukraine live cameras and radio

This update adds five owner-published live tourism cameras in **Bukovel / Polianytsia, Ukraine**. All five are at one resort; this is **not coverage of every Ukrainian city**. The existing global camera pack did not include Ukraine. These additions use the resort's continuous HLS video, not periodically refreshed photographs.

Open [Ukraine cameras](https://dream-unity.github.io/November-1st/?feed=cctv&country=UA) or choose **Ukraine** in the camera directory's country filter. Keep **Live video** selected. [Ukraine radio](https://dream-unity.github.io/November-1st/?feed=radio&country=UA) opens the country-specific station directory. Camera counts describe listed sources, not guaranteed simultaneous availability.

## Camera coverage and evidence

The inventory is [config/cctv_sources.ukraine.json](../config/cctv_sources.ukraine.json). Each entry records its publisher, public source page, approximate location, verification date and evidence. The [official Bukovel webcam page](https://bukovel.com/en/cams) publishes all five source URLs directly. No private camera address, credential, signed media token or access-control bypass was used.

| Camera ID | Official view | Verification on 2026-09-17 UTC |
| --- | --- | --- |
| `ua-bukovel8` | Lift #5. Mountain station | Advancing HLS playlist; official-page browser decoded 1280×720 video and progressed to 5.97 seconds while playing |
| `ua-bukovel9` | Lift #12. Mountain station | Advancing HLS playlist; individual browser decoding not yet verified |
| `ua-bukovel28` | Lake of Youth | Advancing HLS playlist; individual browser decoding not yet verified |
| `ua-bukovel27` | Mavka Aquapark | Advancing HLS playlist; individual browser decoding not yet verified |
| `ua-bukovel26` | VODA club | Advancing HLS playlist; individual browser decoding not yet verified |

Between approximately 07:02 and 07:12 UTC, media sequences advanced from 18017 to 18324, 18034 to 18341, 18032 to 18339, 18030 to 18337 and 14542 to 14789 respectively. All five playlists contained current `EXT-X-PROGRAM-DATE-TIME` values and no `EXT-X-ENDLIST`. This establishes that the published playlists were advancing at the time checked; it does not independently certify every camera's pixels or future uptime.

Direct shell requests incurred approximately 20 seconds per request, while the publisher's rolling playlists retained roughly 10–12 seconds of segments. Segment probes consequently returned 404 after the referenced segments expired. The separate official-page browser test decoded Lift #5 successfully. Application-relay verification is recorded separately below; a shell timeout or expired segment is not treated as proof that a camera is permanently offline.

Map positions are rounded, owner-published resort scene locations. They are not surveyed camera positions, calibrated headings or verified lines of sight. Video remains the property of Bukovel and its camera provider.

## Live-only behavior

Every Ukraine registry entry requires `playbackKind: "live"` and `liveOnly: true`. The loader admits reviewed sources with provenance and validated coordinates; the initial HLS allowlist is restricted to these five exact owner-published URLs. Set `CCTV_UKRAINE_ENABLED=0` to disable this pack. Existing explicit catalogue overrides retain their behavior.

For a live-only HLS source, the server rejects a playlist containing `EXT-X-ENDLIST` or `EXT-X-PLAYLIST-TYPE:VOD` with HTTP 410 and `CCTV_BROADCAST_ENDED`. The check applies to media playlists as well as masters and later reloads. Referenced media remains subject to the existing registered-origin and camera-directory restrictions; this addition does not turn the media route into an arbitrary URL proxy.

The frame endpoint rejects live-only cameras with HTTP 409 and `CCTV_LIVE_VIDEO_REQUIRED`. It supplies no snapshot, Street View image or synthetic replacement. Globe frame requests also skip live-only sources. A failed camera must remain visibly unavailable instead of silently becoming an image or archived clip labelled live.

Playlist tags cannot independently prove that a publisher never transmits recorded material. Source review, current timestamps, playlist advancement and decoded-video observations provide complementary evidence. External broadcasts can still stop, change address or become unavailable.

## Reviewed sources not added

| Publisher or source | Observed reason for exclusion |
| --- | --- |
| [Truskavets official tourism webcams](https://truskavets.ua/webcamera-online/) | All three published YouTube cameras returned `UNPLAYABLE` and `isLiveNow=false`. Their existence on a tourism page did not make the ended broadcasts live. |
| [Eco-Halych bear sanctuary](https://eco-halych.webnode.com.ua/bears-online/) | Its published YouTube broadcast also returned `UNPLAYABLE` and `isLiveNow=false`; no replacement live broadcast was confirmed. |
| [SNIH](https://snih.info/uk), including its players on [Zakhar Berkut](https://zaharberkut.ua/webcams/) and [Krasiya](https://krasiya.com.ua/en/webcams/) | The operator explicitly prohibits reuse of its video streams without agreement. No protected or paid streams were extracted. |
| [Favar Carpathians, Skhidnytsia](https://hotelfavar.com/en/webcams/) | The owner publishes two scenic partner players, but both public HLS checks returned HTTP 502. Current live playback was not verified. |
| [Romantik Spa Hotel, Yaremche](https://romantikspahotels.ua/galereya/web-cams/) | Three active owner-published RTSP.ME player shells were reachable, but a loaded player shell does not establish current live video. Two other player IDs occurred only in commented-out markup. None was added as verified live footage. |
| [Legacy VODA webcam page](https://vodaclub.ua/ru/%D0%B2%D0%B5%D0%B1-%D0%BA%D0%B0%D0%BC%D0%B5%D1%80%D0%B0/) | Its obsolete Flash/RTMP player was not integrated; the current Bukovel VODA HLS source is included instead. |

The curated Ukraine scope is ordinary owner-published tourism, nature and public cultural views. There is no blanket ingestion of camera aggregators, exposed IP cameras, private surveillance, military positions, checkpoints, transport hubs, critical infrastructure or attack-monitoring feeds. New sources require current live evidence and publisher review before admission; unavailable cities remain unavailable rather than being populated with misleading substitutes.

## Radio

The previous global directory required both coordinates and a place within a 750-station worldwide popularity cap. The downloaded Ukraine sample contained 348 community records; only 43 passed the old geographic admission rules. The dedicated `/api/radio/stations?country=UA` query accepts usable HTTPS MP3/AAC stations without coordinates, deduplicates programme names and URLs, and has a separate 600-station ceiling. The global globe directory retains its existing geometry and limit.

[config/radio_sources.ukraine.json](../config/radio_sources.ukraine.json) supplies 20 reviewed broadcaster programmes as a fallback. Bounded transport checks received HTTP 200, audio/mpeg and 4,096 audio bytes with no finite Content-Length from 23 URLs; duplicate bitrate variants and an unverified owner page were excluded. This is transport evidence, not proof of audible identity for every station. The registry includes broadcaster source pages and per-entry evidence. A known finite sound-effect file is explicitly excluded from dynamic discovery as well as the curated inventory.

The dedicated directory has coalesced refreshes, a 30-second upstream budget, a 45-minute healthy cache and a seven-day stale limit. Outages expose a degraded state and retain curated or bounded stale results. Registry paths resolve from the immutable source archive, independently of the server's writable state directory. Curated station IDs are stable application identities; selecting them does not submit fabricated votes to Radio Browser.

Missing station coordinates remain `null`. Audio playback stays available; **Show on globe** explains that no location is available. Ukrainian text and apostrophe forms are searchable. The **Ukraine stations** shortcut and country deep link load the scoped directory even when no Ukrainian station survived the initial global popularity cap. The community directory can contain inaccurate labels or offline streams; runtime playback states and source links remain visible.

## Deployment verification

Pending production verification.

This record distinguishes registry validation, live playlist observations, official-page playback and application playback. It does not claim that every external feed is permanently available or that every possible future error has been eliminated.
