import connect from 'connect';
import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { readHostConfig, capabilityReport } from './config.mjs';
import { hostSecurity, json } from './security.mjs';
import { staticApplication } from './static.mjs';
import { aisBridge } from './ais-bridge.mjs';

/** Connect itself does not catch rejected promises from async handlers. */
function asyncAware(app) {
  const originalUse = app.use.bind(app);
  app.use = (...args) => originalUse(...args.map((argument) => {
    if (typeof argument !== 'function' || argument.length === 4) return argument;
    return (req, res, next) => {
      try { Promise.resolve(argument(req, res, next)).catch(next); }
      catch (error) { next(error); }
    };
  }));
  return app;
}

async function productionProviders(config) {
  // Existing provider caches bind to cwd. Resolve this before the dynamic
  // import, while catalogue source roots continue to use import.meta.url.
  await mkdir(config.stateDir, { recursive: true });
  process.chdir(config.stateDir);
  const { localProviderPlugins } = await import('../server/providers/local.js');
  return localProviderPlugins().filter((plugin) =>
    plugin.name !== 'gev-key-setup' &&
    !(config.mode === 'serverless' && plugin.name === 'ais-live-proxy'),
  );
}

/**
 * The complete upstream provider stack, hosted without a Vite development
 * server. Vercel and the persistent Node entry share exactly this application.
 * providerPlugins exists for isolated, deterministic integration tests.
 */
export async function createProductionHost({
  mode,
  config = readHostConfig(process.env, mode),
  env = process.env,
  serveStatic = true,
  providerPlugins,
  fetchImpl,
} = {}) {
  const app = asyncAware(connect());
  const lifecycle = new EventEmitter();
  const plugins = providerPlugins ?? await productionProviders(config);
  const providerNames = plugins.map((plugin) => plugin.name);
  let disposed = false;
  app.use(hostSecurity(config, env));
  const exactGet = (handler) => (req, res, next) => {
    if (!['/', ''].includes((req.url || '/').split('?')[0])) return next();
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
    handler(req, res);
  };
  app.use('/api/health', exactGet((req, res) => json(res, 200, {
    status: 'ok', service: 'dream-unity-gods-eye', runtime: config.mode,
    commit: config.commit, providersMounted: providerNames,
    note: 'Host ready; provider mounting does not establish upstream availability.',
  })));
  app.use('/api/capabilities', exactGet((req, res) => json(res, 200, capabilityReport(config, env))));
  if (config.mode === 'serverless') app.use('/api/ais-live', aisBridge(config, fetchImpl));
  const server = { middlewares: app, httpServer: lifecycle };
  for (const plugin of plugins) {
    if (plugin.name === 'gev-key-setup') throw new Error('Local credential editor cannot be mounted in production');
    if (config.mode === 'serverless' && plugin.name === 'ais-live-proxy') throw new Error('Persistent AIS ingestion cannot run inside a serverless function');
    if (typeof plugin.configurePreviewServer !== 'function') throw new Error(`Provider lacks a production middleware hook: ${plugin.name}`);
    const postHook = await plugin.configurePreviewServer(server);
    if (typeof postHook === 'function') await postHook();
  }
  // A missing provider route must never receive the HTML application shell.
  app.use('/api', (req, res) => json(res, 404, { error: 'API route not found' }));
  if (serveStatic) app.use(staticApplication(config.distDir));
  app.use((req, res) => json(res, 404, { error: 'Not found' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) { res.destroy(); return; }
    // Do not echo upstream URLs, secrets, filesystem paths or stack traces.
    console.error('[production-host] Request failed:', error?.name || 'Error');
    json(res, 500, { error: 'Request could not be completed' });
  });
  return {
    handler: app,
    config,
    providerNames,
    async close() {
      if (disposed) return;
      disposed = true;
      lifecycle.emit('close');
      await Promise.allSettled(plugins.map((plugin) => plugin.closeBundle?.()));
    },
  };
}
