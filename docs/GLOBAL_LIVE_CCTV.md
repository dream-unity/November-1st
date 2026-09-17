# Global live CCTV and public webcams

The previous continuous-video repair integrated only Caltrans. Other regional camera packs supplied snapshots, so the live-video filter was effectively US-only.

This change adds **89 owner-published live broadcasts across 55 countries and territories**, in addition to the existing US Caltrans HLS streams. The combined live catalogue represents **56 country/territory codes** when Caltrans is available. These are public street, harbour, airport, landscape, wildlife and other explicitly published webcams; they are not access to private CCTV networks or universal coverage of every country.

## Playback and discovery

Open [CCTV cameras](https://dream-unity.github.io/November-1st/?feed=cctv), leave the media filter on **Live video**, and choose a country. Countries rotate in the result list so a large US inventory does not occupy every first-page slot. Country, city, media and search filters combine. The country counts mean **listed live sources**, not a promise that all publishers are online simultaneously.

International sources use the publisher's official YouTube player, preserving attribution and controls. Play starts muted; the provider controls can enable audio. Closing, changing cameras, pausing or hiding the viewer releases the embedded session. The original globe camera panel supports the same player. Protected embedded footage is not extracted into globe textures: projection and hover cards explain panel-only playback and do not fetch substitute images.

The selected camera receives a live-status check against its public watch page. Confirmed ended, finite or forbidden broadcasts are blocked. A server login/consent/bot barrier or unavailable metadata yields **unconfirmed** status, since a server's access failure does not prove the visitor's player cannot work. Only actual player events report playback. An ended player is destroyed so native Replay cannot silently run an archive. Provider failure leaves an attributed source link and retry controls; it never becomes a snapshot or finite loop labelled live.

## Evidence and maintenance

The source catalogue is [config/cctv_sources.global.json](../config/cctv_sources.global.json). Each entry has a stable camera ID, country code/name, publisher, source page, approximate map location, verification date and original verification evidence. All 89 accepted broadcasts reported live and embeddable in their original public player metadata on **2026-09-17 UTC**; research also reviewed publisher descriptions for contrary embedding restrictions. Metadata verification alone is not decoded-frame verification or a guarantee of future availability.

Source positions generally identify the named public scene or facility. They are not surveyed lens positions or calibrated headings. Live video IDs may change when a publisher restarts a broadcast. Update the registry only after verifying the replacement is the same public camera and remains permitted for embedding. The live-status check uses a bounded 2 MiB body, an 8-second deadline, a 60-second cache, per-ID request coalescing and bounded cache/in-flight cardinality. It never executes page scripts or extracts media URLs.

Run `node scripts/audit-global-cctv.mjs` for offline registry validation and coverage. Use `node --use-env-proxy scripts/audit-global-cctv.mjs --live` for an explicit current public-metadata audit. The result distinguishes live, ended, unavailable and unknown; network outages are not CI failures. No API key is needed for these official players. `CCTV_GLOBAL_ENABLED=0` disables this pack. Existing file/env catalogue overrides retain their documented behavior.

Excluded sources include snapshot-only “live” pages, expired/scheduled broadcasts, unsupported owner-only players, explicit no-embedding notices, disabled embeds and uncertain recorded compilations. In particular, technical embeddability was not enough where a publisher expressly prohibited embedding. Examples and primary evidence for Europe are in [the research record](global-cctv-sources-europe.md).

## International source inventory

| Country or territory | New live broadcasts |
| --- | ---: |
| Argentina | 1 |
| Armenia | 2 |
| Australia | 2 |
| Austria | 2 |
| Barbados | 1 |
| Belgium | 2 |
| Botswana | 2 |
| Brazil | 4 |
| Canada | 1 |
| Chile | 1 |
| Czechia | 2 |
| Denmark | 1 |
| Ecuador | 1 |
| Estonia | 1 |
| Finland | 6 |
| France | 2 |
| Germany | 1 |
| Hong Kong | 1 |
| Hungary | 1 |
| India | 1 |
| Indonesia | 2 |
| Ireland | 1 |
| Israel | 1 |
| Italy | 2 |
| Japan | 2 |
| Kazakhstan | 1 |
| Kenya | 1 |
| Kyrgyzstan | 1 |
| Latvia | 1 |
| Malaysia | 1 |
| Mexico | 1 |
| Namibia | 4 |
| Netherlands | 3 |
| New Zealand | 4 |
| Norway | 2 |
| Panama | 1 |
| Peru | 1 |
| Philippines | 1 |
| Poland | 1 |
| Romania | 1 |
| Saudi Arabia | 1 |
| Singapore | 2 |
| Slovakia | 1 |
| Slovenia | 1 |
| South Africa | 1 |
| South Korea | 1 |
| Spain | 2 |
| Sweden | 2 |
| Switzerland | 2 |
| Taiwan | 3 |
| Tanzania | 1 |
| Thailand | 2 |
| United Kingdom | 1 |
| Vietnam | 1 |
| Zimbabwe | 1 |

## Verification

The final implementation passed **4,463 tests**, with one existing Windows-specific test skipped on Linux: 4,406 unit/allocation checks across 344 files and 57 hosted integration tests. Formatting checked 933 runtime files; import/package boundaries and production build passed. Tests cover URL/registry validation, country filters, metadata access gates, stale callbacks, explicit provider errors, archive rejection (including a cached proof after an observed end), teardown, protected-pixel admission, HLS preservation and native hosted route dispatch.

Preview revision: `01161d3b3509cc2568a819487cba8fff85d88e81`. Deployed catalogue observation: **3,750 total cameras; 389 listed live (89 official international embeds + 300 Caltrans HLS); 56 country/territory codes**. Browser country/media/search filtering correctly narrowed Finland to six broadcasts, Japan to two, Kenya to one and the US to the selected C014 stream. Counts vary with upstream source availability.

The official players for Finland, Japan and Kenya reached their real API ready/buffering states, with the expected source IDs, correct referrer policy and visible 525×295-pixel frames. They did **not** decode moving video in this test browser before the bounded timeout. The same Japanese stream also stalled on its original YouTube watch page, reporting currentTime 0, readyState 0 and video dimensions 0×0 while the page identified the broadcaster and current viewers. This comparison shows a media-delivery limitation in the test environment; it does not certify international video decoding on the deployed application. No still images were substituted and no buffering state was reported as playing.

The test browser also cannot initialize WebGL; the independent directory remains usable through the existing recovery interface. Thus this release does not claim a complete hardware-accelerated globe walkthrough or permanent availability of every external camera. Preview runtime error/warning scan showed no server entries at the time checked.


### Public production verification

Deployed runtime revision: `9c8c2b50f29f0adea0cb413772d5712722523ca3`, deployment `dpl_2nqF8cXdXf65uBVAkpaXgHCm4cwk`, READY on 2026-09-17 UTC at [the public application](https://november-1st-sable.vercel.app/?feed=cctv). The [GitHub Pages entry](https://dream-unity.github.io/November-1st/?feed=cctv) redirected correctly and opened the international directory. The later documentation-only commit does not change this deployed runtime.

- `/api/health`: HTTP 200, correct runtime commit and all 21 original/provider middleware groups mounted.
- `/api/cctv/sources`: HTTP 200, 3,750 cameras, 389 listed live, 89 official international embeds and 56 live country/territory codes.
- Selected Finland/Japan live-status endpoints: HTTP 200 with honest `unknown` results when the hosting server could not confirm the public YouTube page. This does not prevent unconfirmed official-player playback. The Finnish player still buffered and timed out in the test browser on the public deployment; moving international video is therefore **not certified by this release's browser tests**.
- Caltrans C014 public HLS endpoint: HTTP 200 with a valid HLS master. Browser playback used MSE, decoded 640×480 video and advanced from 21 to 80 seconds; Pause stopped playback correctly. This public result also distinguishes the preview's protected-media failure from a direct-video regression.
- Production runtime error/warning scan returned no entries during the checked window. This is a bounded observation, not a permanent uptime guarantee.
- [CI run 35189824318](https://github.com/dream-unity/November-1st/actions/runs/35189824318): Node 24.14, Node 26 and Windows onboarding all succeeded. [Pages run 35189823410](https://github.com/dream-unity/November-1st/actions/runs/35189823410) succeeded.
