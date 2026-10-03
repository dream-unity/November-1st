import { createCesiumLoader } from '../dream-unity/loadCesium.js';
import { installEarthBridge } from '../embed/bridge.js';
import { installEmbedMediaFocus } from '../embed/mediaFocus.js';

const status = document.getElementById('du-embed-status');
const origins = (
  import.meta.env.DU_EMBED_PARENT_ORIGINS || 'https://dreamunity.one'
).split(',');
const loadCesium = createCesiumLoader({
  source: `${import.meta.env.BASE_URL}cesium/Cesium.js`,
});
let bridge;
const documentLifetime = new AbortController();
async function initialize() {
  if (window.parent === window) {
    status.textContent =
      'This view belongs inside the Dream Unity prototype. Open the complete standalone application below.';
    return;
  }
  let commit = import.meta.env.DU_BUILD_COMMIT;
  try {
    const response = await fetch('/build-info.json', {
      cache: 'no-store',
      signal: AbortSignal.any([
        documentLifetime.signal,
        AbortSignal.timeout(2000),
      ]),
    });
    if (response.ok) commit = (await response.json()).commit;
  } catch {
    /* Development uses its explicitly compiled checkout identity. */
  }
  if (documentLifetime.signal.aborted) return;
  if (!/^[a-f0-9]{40}$/.test(commit || '')) {
    status.textContent =
      'Earth build identity could not be verified. Use the standalone view.';
    return;
  }
  bridge = installEarthBridge({
    buildCommit: commit,
    origins,
    mediaFactory: (options) =>
      installEmbedMediaFocus({ ...options, documentRef: document }),
    runtimeFactory: async (options) => {
      options.signal.throwIfAborted();
      status.textContent = 'Opening the complete Earth application…';
      if (import.meta.env.PROD) await loadCesium();
      options.signal.throwIfAborted();
      const { createEmbeddedRuntime } = await import('./embedRuntime.js');
      options.signal.throwIfAborted();
      return createEmbeddedRuntime(options);
    },
  });
}
window.addEventListener(
  'pagehide',
  () => {
    documentLifetime.abort('Earth document closed');
    void bridge?.destroy().catch(() => {});
  },
  { once: true },
);
void initialize().catch(() => {
  status.textContent =
    'Earth could not connect to the prototype. Use the standalone view.';
});
