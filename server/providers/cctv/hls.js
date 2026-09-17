import { readCappedResponseBytes } from './media.js';

const PLAYLIST_MAX_BYTES = 512 * 1024;
const RESOURCE_MAX_BYTES = 16 * 1024 * 1024;

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
      throw new Error('Camera HLS resource is unavailable');
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
    const bytes = await readCappedResponseBytes(
      upstream,
      playlist ? PLAYLIST_MAX_BYTES : maxResourceBytes,
    );
    if (!bytes)
      throw Object.assign(
        new Error(
          'Camera HLS resource exceeds the host size limit; use a lower bitrate stream or persistent media host',
        ),
        { code: 'CCTV_HLS_RESOURCE_TOO_LARGE' },
      );
    const body = playlist
      ? rewriteCctvHlsPlaylist(bytes.toString('utf8'), {
          sourceUrl,
          playlistUrl: target,
          cameraId,
        })
      : bytes;
    const responseHeaders = {
      'Content-Type': playlist ? 'application/vnd.apple.mpegurl' : contentType,
      'Cache-Control': playlist ? 'no-store' : 'private, max-age=10',
    };
    if (!playlist) {
      for (const name of ['content-range', 'accept-ranges']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders[name] = value;
      }
    }
    return new Response(body, {
      status: upstream.status,
      headers: responseHeaders,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}
