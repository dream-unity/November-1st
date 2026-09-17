import { readCappedResponseBytes } from './media.js';

const PLAYLIST_MAX_BYTES = 512 * 1024;
const RESOURCE_MAX_BYTES = 16 * 1024 * 1024;

function resourceTooLarge() {
  return Object.assign(
    new Error(
      'Camera HLS resource exceeds the host size limit; use a lower bitrate stream or persistent media host',
    ),
    { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' },
  );
}

/** Playlist fragments retain their range; native players may also probe an open range. */
function requestedByteRange(headers, maxBytes) {
  const value = new Headers(headers).get('range');
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]))
    throw new Error('Camera HLS byte range is invalid');
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last)) ||
    (first === null && last === 0) ||
    (first !== null && last !== null && last < first)
  )
    throw new Error('Camera HLS byte range is invalid');
  if (first !== null && last !== null && last - first + 1 > maxBytes)
    throw resourceTooLarge();
  return { first, last };
}

function rangeExtent(range, length, returnedLast) {
  if (range.first === null) {
    return length === null
      ? null
      : {
          first: Math.max(0, length - range.last),
          last: length - 1,
        };
  }
  return {
    first: range.first,
    last:
      range.last === null
        ? length === null
          ? returnedLast
          : length - 1
        : length === null
          ? range.last
          : Math.min(range.last, length - 1),
  };
}

/** HLS resources stay inside the registered stream's origin and directory. */
export function resolveCctvHlsResource(
  sourceUrl,
  value = sourceUrl,
  baseUrl = sourceUrl,
) {
  const source = new URL(sourceUrl);
  const target = new URL(value, baseUrl);
  const directory = source.pathname.slice(
    0,
    source.pathname.lastIndexOf('/') + 1,
  );
  if (
    !['https:', 'http:'].includes(source.protocol) ||
    target.origin !== source.origin ||
    target.username ||
    target.password ||
    !target.pathname.startsWith(directory) ||
    /[\\\u0000-\u001f]/.test(String(value)) ||
    /%(?:2f|5c|2e|25)/i.test(target.pathname)
  )
    throw new Error(
      'Camera HLS resource is outside its registered stream directory',
    );
  target.hash = '';
  return target;
}

/** Rewrite all playlist URI forms, including variant, map and encryption key references. */
export function rewriteCctvHlsPlaylist(
  text,
  { sourceUrl, playlistUrl, cameraId },
) {
  if (
    !text
      .replace(/^\uFEFF/, '')
      .trimStart()
      .startsWith('#EXTM3U')
  )
    throw new Error('Camera returned an invalid HLS playlist');
  const proxy = (value) => {
    const target = resolveCctvHlsResource(sourceUrl, value, playlistUrl);
    return `/api/cctv/media/${encodeURIComponent(cameraId)}?resource=${encodeURIComponent(target.toString())}`;
  };
  const lines = [];
  let outputBytes = 0;
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    const rewritten = !value
      ? line
      : !value.startsWith('#')
        ? proxy(value)
        : line.replace(
            /\bURI="([^"]+)"/g,
            (_match, uri) => `URI="${proxy(uri)}"`,
          );
    outputBytes += Buffer.byteLength(rewritten) + 1;
    if (outputBytes > PLAYLIST_MAX_BYTES)
      throw Object.assign(
        new Error('Rewritten camera playlist exceeds its size limit'),
        { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' },
      );
    lines.push(rewritten);
  }
  return lines.join('\n');
}

/** Fetch one bounded playlist, segment or key with safe redirects and a full-body deadline. */
export async function fetchCctvHlsResource({
  sourceUrl,
  resource,
  cameraId,
  headers = {},
  signal,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  maxResourceBytes = process.env.VERCEL ? 4 * 1024 * 1024 : RESOURCE_MAX_BYTES,
}) {
  let target = resolveCctvHlsResource(sourceUrl, resource || sourceUrl);
  const range = requestedByteRange(headers, maxResourceBytes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    let upstream;
    for (let hop = 0; hop <= 2; hop++) {
      upstream = await fetchImpl(target.toString(), {
        headers,
        signal: controller.signal,
        redirect: 'manual',
      });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get('location');
      await upstream.body?.cancel().catch(() => {});
      if (!location || hop === 2) throw new Error('Camera HLS redirect failed');
      target = resolveCctvHlsResource(sourceUrl, location, target);
    }
    if (!upstream?.ok) {
      await upstream?.body?.cancel().catch(() => {});
      // Preserve the provider's HTTP status so an expired live segment (404)
      // and provider throttling (429) are not misreported as relay failures.
      return new Response(null, {
        status: upstream?.status || 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    const contentType = (
      upstream.headers.get('content-type') || ''
    ).toLowerCase();
    const playlist =
      contentType.includes('mpegurl') || /\.m3u8$/i.test(target.pathname);
    if (
      !playlist &&
      !/^(?:video\/|audio\/|application\/(?:octet-stream|mp4|binary))/.test(
        contentType,
      )
    ) {
      await upstream.body?.cancel().catch(() => {});
      throw new Error('Camera returned an unsupported HLS resource');
    }
    let bytes = await readCappedResponseBytes(
      upstream,
      playlist ? PLAYLIST_MAX_BYTES : maxResourceBytes,
    );
    if (!bytes) throw resourceTooLarge();
    let status = upstream.status;
    let contentRange = upstream.headers.get('content-range');
    if (!playlist && range) {
      if (upstream.status === 200) {
        // Some camera CDNs ignore Range. Serve the exact fragment when its
        // whole resource fits our cap; never feed the decoder unrelated bytes.
        const extent = rangeExtent(range, bytes.length);
        if (extent.first > extent.last)
          throw new Error(
            'Camera HLS resource does not contain its requested byte range',
          );
        contentRange = `bytes ${extent.first}-${extent.last}/${bytes.length}`;
        bytes = bytes.subarray(extent.first, extent.last + 1);
        status = 206;
      } else {
        const returned = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(
          contentRange || '',
        );
        const length =
          !returned || returned[3] === '*' ? null : Number(returned[3]);
        const extent = rangeExtent(range, length, Number(returned?.[2]));
        if (
          upstream.status !== 206 ||
          !returned ||
          !extent ||
          !Number.isSafeInteger(Number(returned[1])) ||
          !Number.isSafeInteger(Number(returned[2])) ||
          (length !== null && !Number.isSafeInteger(length)) ||
          Number(returned[1]) !== extent.first ||
          Number(returned[2]) !== extent.last ||
          bytes.length !== extent.last - extent.first + 1
        )
          throw new Error(
            'Camera HLS response does not match its requested byte range',
          );
      }
    }
    const body = playlist
      ? rewriteCctvHlsPlaylist(bytes.toString('utf8'), {
          sourceUrl,
          playlistUrl: target,
          cameraId,
        })
      : bytes;
    const responseHeaders = {
      'Content-Type': playlist ? 'application/vnd.apple.mpegurl' : contentType,
      // Live providers may reuse key or segment URLs. An old response must
      // never freeze the playlist or decrypt new fragments with an old key.
      'Cache-Control': 'no-store',
    };
    if (!playlist) {
      if (contentRange) responseHeaders['Content-Range'] = contentRange;
      const acceptRanges = upstream.headers.get('accept-ranges');
      if (acceptRanges || range)
        responseHeaders['Accept-Ranges'] = acceptRanges || 'bytes';
    }
    return new Response(body, {
      status,
      headers: responseHeaders,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
