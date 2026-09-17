import { createRadioProxyMiddleware } from './radio/catalog.js';
import { defaultSourceRoot } from './common/source-root.js';
export { createRadioProxyMiddleware };
export { isPublicRadioAddress } from './radio/transport.js';
export {
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio/stations.js';
export function radioBrowserProxy({
  sourceRoot = defaultSourceRoot,
  ...options
} = {}) {
  const middleware = createRadioProxyMiddleware({ ...options, sourceRoot });
  const install = (server) => {
    server.middlewares.use('/api/radio', middleware);
  };
  return {
    name: 'radio-browser-proxy',
    configureServer: install,
    configurePreviewServer: install,
  };
}
