import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './openai/hud-summary.js';
import { createDebugLogHandler } from './openai/debug-log.js';
import { createRealtimeTokenHandler } from './openai/realtime.js';
import { createRealtimeStatusHandler } from './openai/status.js';

/**
 * Vite plugin: OpenAI Realtime ephemeral client secret.
 *
 * Keeps OPENAI_API_KEY server-side while the browser connects to the
 * Realtime API over WebRTC with a short-lived secret.
 */
function openAiRealtimeProxy({
  sourceRoot = defaultSourceRoot,
  annotationGuidance,
  realtime = {},
} = {}) {
  function install(middlewares) {
    // Connect prefix mounts also match descendants and dot suffixes. None of
    // these endpoints have children; reject them before an upstream paid call.
    const exact = (handler) => (req, res, next) => {
      if (!['', '/'].includes((req.url || '/').split('?')[0])) return next();
      return handler(req, res, next);
    };
    middlewares.use(
      '/api/realtime/status',
      exact(createRealtimeStatusHandler(realtime)),
    );
    middlewares.use('/api/openai/hud-summary', exact(handleHudSummary));

    middlewares.use(
      '/api/realtime/debug-log',
      exact(createDebugLogHandler({ sourceRoot })),
    );

    middlewares.use(
      '/api/realtime/token',
      exact(createRealtimeTokenHandler({ ...realtime, annotationGuidance })),
    );
  }

  return {
    name: 'openai-realtime-proxy',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

export { openAiRealtimeProxy };
