import { createCctvCatalog } from './cctv/catalog.js';
import { createCctvEmbedStatus } from './cctv/embedStatus.js';
import { loadAustraliaPublisherCameras } from './cctv/australiaSources.js';
import {
  normalizeFeedType,
  isVideoFeedType,
  toFiniteNumber,
} from './cctv/normalize.js';
import {
  buildSyntheticCctvSvg,
  proxyMediaResponse,
  fetchCctvImageFromUpstream,
  fetchTxdotSnapshot,
  fetchCctvMediaUpstream,
  fetchBoundedCctvVideoUpstream,
  watchDownstreamClose,
} from './cctv/media.js';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_MAX_SOURCES_CEILING,
} from './cctv/constants.js';
import {
  sanitizeCctvRangeHeader,
  sanitizeCctvHlsRangeHeader,
} from './cctv/range.js';
import { fetchCctvHlsResource } from './cctv/hls.js';
import { googleServerApiKey } from './places/google-key.js';
export { CCTV_FRAME_FETCH_TIMEOUT_MS, fetchCctvImageFromUpstream };
/**
 * Vite plugin: CCTV camera proxy with source registry, frame/media serving,
 * fallback chain (upstream -> Street View -> synthetic SVG), and health tracking.
 *
 * Endpoints:
 *   GET /api/cctv/sources        — list all registered camera sources
 *   GET /api/cctv/health         — per-camera health/status report
 *   GET /api/cctv/stream/:id     — stream info (feedType, URLs) for a camera
 *   GET /api/cctv/media/:id      — proxy live video/image media from upstream
 *   GET /api/cctv/frame/:id      — single frame with fallback chain
 *
 * @returns {import('vite').Plugin}
 */
export function cctvProxy({ sourceRoot = process.cwd() } = {}) {
  const getCctvSources = createCctvCatalog({ sourceRoot });
  const getEmbedStatus = createCctvEmbedStatus();
  /** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
  const health = new Map();
  /** Cap on health map entries to prevent unbounded growth. Sized to the
   * CCTV_MAX_SOURCES ceiling so health/status observability is never evicted
   * for any catalog the proxy can actually serve. */
  const HEALTH_MAX_ENTRIES = CCTV_MAX_SOURCES_CEILING;

  /** Update the health entry for a camera, evicting the oldest entry if at capacity. */
  const setHealth = (cameraId, patch) => {
    // Evict oldest entries if the health map grows beyond the cap
    if (!health.has(cameraId) && health.size >= HEALTH_MAX_ENTRIES) {
      const oldest = health.keys().next().value;
      health.delete(oldest);
    }
    const prev = health.get(cameraId) || {};
    health.set(cameraId, {
      id: cameraId,
      status: patch.status || prev.status || 'unknown',
      sourceKind: patch.sourceKind || prev.sourceKind || 'unknown',
      label: patch.label || prev.label || '',
      message: patch.message || prev.message || '',
      updatedAt: Date.now(),
    });
  };

  /** Snapshot all camera health entries as an array. */
  const listHealth = () => Array.from(health.values());

  /** Build a JSON payload describing stream info (feedType, URLs) for a camera. */
  const buildStreamPayload = (source, cameraId) => {
    const feedType = normalizeFeedType(source?.feedType || 'image');
    return {
      id: cameraId,
      feedType,
      playbackKind:
        source?.playbackKind || (feedType === 'image' ? 'snapshot' : 'video'),
      mediaUrl: isVideoFeedType(feedType)
        ? `/api/cctv/media/${encodeURIComponent(cameraId)}`
        : null,
      frameUrl:
        feedType === 'embed' || source?.liveOnly === true
          ? null
          : `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
      embedUrl: source?.embedUrl || '',
      sourcePage: source?.sourcePage || '',
      country: source?.country || '',
      countryName: source?.countryName || '',
      verifiedAt: source?.verifiedAt || '',
      liveOnly: source?.liveOnly === true,
      provider: source?.provider || '',
      sourceKind:
        source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
    };
  };

  /**
   * Fetch a Google Street View static image as a fallback frame. Server-side
   * call, never reaches the browser — prefers GOOGLE_MAPS_SERVER_API_KEY
   * (#33: a key scoped to Street View Static/Places, restricted by server IP
   * rather than HTTP referrer) and falls back to the browser-exposed
   * GOOGLE_MAPS_API_KEY for setups that haven't split the two yet.
   */
  const streetViewFallback = async ({ lat, lon, heading, fov, pitch }) => {
    const streetViewKey = googleServerApiKey();
    if (!streetViewKey || !Number.isFinite(lat) || !Number.isFinite(lon))
      return null;
    try {
      const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
      sv.searchParams.set('size', '960x540');
      sv.searchParams.set('location', `${lat},${lon}`);
      sv.searchParams.set(
        'heading',
        String(Number.isFinite(heading) ? heading : 0),
      );
      sv.searchParams.set(
        'fov',
        String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80),
      );
      sv.searchParams.set(
        'pitch',
        String(Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0),
      );
      sv.searchParams.set('source', 'outdoor');
      sv.searchParams.set('return_error_code', 'true');
      sv.searchParams.set('key', streetViewKey);

      const svResp = await fetch(sv.toString(), {
        headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
        signal: AbortSignal.timeout(CCTV_FRAME_FETCH_TIMEOUT_MS),
      });
      const svType = svResp.headers.get('content-type') || '';
      if (!svResp.ok || !svType.startsWith('image/')) return null;

      return {
        ok: true,
        body: Buffer.from(await svResp.arrayBuffer()),
        contentType: svType,
      };
    } catch {
      return null;
    }
  };

  const installMiddleware = (server) => {
    server.middlewares.use('/api/cctv', async (req, res) => {
      try {
        if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            Allow: 'GET, HEAD',
          });
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        let decodedPath;
        try {
          decodedPath = decodeURIComponent(url.pathname);
        } catch {
          res.writeHead(400, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ error: 'Invalid camera path' }));
          return;
        }
        const sources = await getCctvSources();
        const sourceById = new Map(
          sources.map((source) => [source.id, source]),
        );

        if (url.pathname === '/sources') {
          const body = {
            publisherSources:
              String(process.env.CCTV_AUSTRALIA_ENABLED || '1').trim() === '0'
                ? []
                : loadAustraliaPublisherCameras({ sourceRoot }),
            sources: sources.map((source) => ({
              id: source.id,
              name: source.name,
              city: source.city,
              metroArea: source.metroArea,
              locality: source.locality,
              region: source.region,
              state: source.state,
              cityId: source.cityId,
              country: source.country,
              countryName: source.countryName,
              embedUrl: source.embedUrl,
              sourcePage: source.sourcePage,
              verifiedAt: source.verifiedAt,
              liveOnly: source.liveOnly === true,
              locationAccuracy: source.locationAccuracy,
              provider: source.provider,
              lat: source.lat,
              lon: source.lon,
              headingDeg: source.headingDeg,
              headingConfidence: source.headingConfidence || '',
              pitchDeg: source.pitchDeg,
              fovDeg: source.fovDeg,
              rangeM: source.rangeM,
              mountHeightM: source.mountHeightM,
              groundElevationM: source.groundElevationM,
              feedType: normalizeFeedType(source.feedType),
              playbackKind:
                source.playbackKind ||
                (normalizeFeedType(source.feedType) === 'image'
                  ? 'snapshot'
                  : 'video'),
              sourceKind:
                source.sourceKind || (source.url ? 'configured' : 'fallback'),
              poseSource: source.poseSource,
              license: source.license,
              credit: source.credit || '',
              code: source.code || '',
              groundHeights: source.groundHeights || null,
            })),
          };
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(body));
          return;
        }

        if (url.pathname === '/health') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ cameras: listHealth() }));
          return;
        }

        if (url.pathname.startsWith('/embed-status/')) {
          const cameraId = decodedPath.slice('/embed-status/'.length).trim();
          const source = sourceById.get(cameraId);
          const statusCode = !source
            ? 404
            : source.feedType !== 'embed'
              ? 409
              : 200;
          const payload =
            statusCode === 200
              ? await getEmbedStatus(source)
              : {
                  error: !source
                    ? 'Camera is not in the current catalogue'
                    : 'Camera does not use an official embedded player',
                };
          res.writeHead(statusCode, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload));
          return;
        }

        if (url.pathname.startsWith('/stream/')) {
          const cameraId =
            decodedPath.slice('/stream/'.length).trim() || 'camera';
          const source = sourceById.get(cameraId);
          if (!source) {
            res.writeHead(404, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: 'Camera is not in the current catalogue',
              }),
            );
            return;
          }
          const payload = buildStreamPayload(source, cameraId);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload));
          return;
        }

        if (url.pathname.startsWith('/media/')) {
          const cameraId =
            decodedPath.slice('/media/'.length).trim() || 'camera';
          const source = sourceById.get(cameraId);
          const mediaUrl = source?.url || '';
          const feedType = normalizeFeedType(source?.feedType || 'image');

          if (feedType === 'embed') {
            res.writeHead(409, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                code: 'CCTV_OFFICIAL_PLAYER_REQUIRED',
                error: 'Watch this camera through its official embedded player',
                embedUrl: source.embedUrl,
              }),
            );
            return;
          }

          if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'fallback',
              label: source?.provider || 'No upstream URL',
              message: 'No stream URL configured',
            });
            res.writeHead(404, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: 'No media URL configured for this camera',
              }),
            );
            return;
          }

          // Bound before the request goes out: most of the wait is before any
          // header arrives, and a viewer who leaves during it must take the
          // upstream request with them.
          const downstream = watchDownstreamClose(res);
          try {
            const upstreamHeaders = {
              'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
            };
            // Never forward the client's own string: a Range this proxy does
            // not accept is dropped and the request proceeds without one.
            // HLS fragments must remain whole, and native players also probe
            // them using open/suffix ranges. Its bounded reader enforces size.
            const requestRange =
              feedType === 'hls'
                ? sanitizeCctvHlsRangeHeader(req.headers?.range)
                : sanitizeCctvRangeHeader(
                    req.headers?.range,
                    process.env.VERCEL ? 4 * 1024 * 1024 : undefined,
                  );
            if (requestRange) upstreamHeaders.Range = requestRange;
            const upstream =
              feedType === 'hls'
                ? await fetchCctvHlsResource({
                    sourceUrl: mediaUrl,
                    resource: url.searchParams.get('resource'),
                    cameraId,
                    requireLive: source.liveOnly === true,
                    headers: upstreamHeaders,
                    signal: downstream.signal,
                  })
                : await (
                    process.env.VERCEL && isVideoFeedType(feedType)
                      ? fetchBoundedCctvVideoUpstream
                      : fetchCctvMediaUpstream
                  )(mediaUrl, {
                    headers: upstreamHeaders,
                    signal: downstream.signal,
                  });
            if (downstream.closed) {
              // The headers arrived for a viewer who is no longer there.
              try {
                await upstream.body?.cancel();
              } catch {
                /* already closed */
              }
              return;
            }
            const contentType = upstream.headers.get('content-type') || '';
            if (!upstream.ok) {
              try {
                await upstream.body?.cancel();
              } catch {
                /* already closed */
              }
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: `Upstream HTTP ${upstream.status}`,
              });
              res.writeHead(upstream.status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              });
              res.end(
                JSON.stringify({
                  error: `Upstream returned ${upstream.status}`,
                }),
              );
              return;
            }

            if (
              isVideoFeedType(feedType) &&
              feedType !== 'hls' &&
              !(
                contentType.startsWith('video/') ||
                contentType.includes('mpegurl')
              )
            ) {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: `Unexpected media type ${contentType || 'unknown'}`,
              });
            } else {
              const live = source.playbackKind === 'live';
              const clip = source.playbackKind === 'clip';
              setHealth(cameraId, {
                status: 'ok',
                sourceKind: isVideoFeedType(feedType)
                  ? live
                    ? 'live'
                    : clip
                      ? 'clip'
                      : 'video'
                  : 'snapshot',
                label: source?.provider || 'Configured source',
                message: isVideoFeedType(feedType)
                  ? live
                    ? 'Live stream data received'
                    : clip
                      ? 'Video clip data received'
                      : 'Video data received; live status unknown'
                  : 'Snapshot feed connected',
              });
            }

            await proxyMediaResponse(res, upstream, {
              sourceHeader: isVideoFeedType(feedType)
                ? source.playbackKind === 'live'
                  ? 'live-media'
                  : 'video-media'
                : 'upstream-image',
            });
            return;
          } catch (error) {
            if (downstream.closed) {
              // The viewer left mid-request. That is not a camera fault and
              // there is nobody to answer.
              return;
            }
            const timedOut =
              error?.name === 'AbortError' || error?.name === 'TimeoutError';
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'upstream',
              label: source?.provider || 'Configured source',
              message: error?.message || 'Media fetch failed',
            });
            const tooLarge =
              error?.code === 'CCTV_HLS_RESOURCE_TOO_LARGE' ||
              error?.code === 'CCTV_VIDEO_RESOURCE_TOO_LARGE';
            const ended = error?.code === 'CCTV_BROADCAST_ENDED';
            res.writeHead(ended ? 410 : tooLarge ? 503 : timedOut ? 504 : 502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                ...(tooLarge || ended ? { code: error.code } : {}),
                error:
                  tooLarge || ended
                    ? error.message
                    : timedOut
                      ? 'Upstream media timeout'
                      : 'Media proxy failed',
              }),
            );
            return;
          }
        }

        if (!url.pathname.startsWith('/frame/')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        const cameraId = decodedPath.slice('/frame/'.length).trim() || 'camera';
        const source = sourceById.get(cameraId);
        if (url.searchParams.get('strict') === '1' && !source) {
          res.writeHead(404, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({ error: 'Camera is not in the current catalogue' }),
          );
          return;
        }
        if (source?.feedType === 'embed') {
          res.writeHead(409, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              code: 'CCTV_OFFICIAL_PLAYER_REQUIRED',
              error:
                'Watch this camera through its official embedded player; no snapshot substitute is provided',
              embedUrl: source.embedUrl,
            }),
          );
          return;
        }
        if (source?.liveOnly === true) {
          res.writeHead(409, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({
              code: 'CCTV_LIVE_VIDEO_REQUIRED',
              error:
                'This camera is live video only; no snapshot or synthetic substitute is provided',
            }),
          );
          return;
        }
        const label = url.searchParams.get('label') || source?.name || cameraId;
        const city = url.searchParams.get('city') || source?.city || '';
        const lat = Number(url.searchParams.get('lat') || source?.lat);
        const lon = Number(url.searchParams.get('lon') || source?.lon);
        const heading = Number(
          url.searchParams.get('heading') || source?.headingDeg,
        );
        const fov = Number(url.searchParams.get('fov') || source?.fovDeg);
        const pitch = Number(url.searchParams.get('pitch') || source?.pitchDeg);

        // Only use server-registered upstream URLs — never accept client-supplied URLs
        // (prevents SSRF via ?upstream= query parameter)
        const upstreamCandidate =
          source?.snapshotUrl ||
          (!isVideoFeedType(normalizeFeedType(source?.feedType))
            ? source?.url
            : '');

        const upstreamImage =
          source?.sourceKind === 'txdot-its'
            ? await fetchTxdotSnapshot(upstreamCandidate)
            : await fetchCctvImageFromUpstream(upstreamCandidate);
        if (upstreamImage?.ok) {
          setHealth(cameraId, {
            status: 'ok',
            sourceKind: 'snapshot',
            label: source?.provider || 'Configured source',
            message: 'Upstream snapshot active',
          });
          res.writeHead(200, {
            'Content-Type': upstreamImage.contentType,
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'upstream-image',
          });
          res.end(upstreamImage.body);
          return;
        }

        // Feed monitors opt out of all non-live substitutes. A successful SVG
        // decode or a Street View photograph is not proof of a working camera.
        if (url.searchParams.get('strict') === '1') {
          setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'unavailable',
            label: source?.provider || 'Camera source',
            message: 'Camera snapshot is currently unavailable',
          });
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'unavailable',
            'Retry-After': '30',
          });
          res.end(
            JSON.stringify({
              code: 'CCTV_SNAPSHOT_UNAVAILABLE',
              error:
                'Camera snapshot is currently unavailable. Retry or choose another camera.',
            }),
          );
          return;
        }

        const sv = await streetViewFallback({
          lat,
          lon,
          heading,
          fov,
          pitch,
        });
        if (sv?.ok) {
          setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'streetview',
            label: 'Google Street View',
            message: 'Fallback Street View frame',
          });
          res.writeHead(200, {
            'Content-Type': sv.contentType,
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'streetview',
          });
          res.end(sv.body);
          return;
        }

        const svg = buildSyntheticCctvSvg({
          cameraId,
          label,
          city,
          status: source?.url
            ? 'UPSTREAM UNAVAILABLE'
            : 'NO UPSTREAM CONFIGURED',
        });

        setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'synthetic',
          label: source?.provider || 'Synthetic fallback',
          message: source?.url
            ? 'Upstream unavailable'
            : 'No source configured',
        });

        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store',
          'X-CCTV-Source': 'synthetic',
        });
        res.end(svg);
      } catch (error) {
        console.error('[CCTV Proxy]', error?.message || String(error));
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CCTV proxy error' }));
      }
    });
  };
  return {
    name: 'cctv-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
