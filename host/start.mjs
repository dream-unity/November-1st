import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { createProductionHost } from './application.mjs';
import { readHostConfig } from './config.mjs';

const config = readHostConfig(process.env, 'persistent');
try {
  await access(path.join(config.distDir, 'index.html'));
} catch {
  console.error('Built application missing. Run npm run build before npm start.');
  process.exit(1);
}
const host = await createProductionHost({ config });
const server = createServer(host.handler);
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.listen(config.port, config.hostname, () => {
  console.log(`Dream Unity complete application listening on port ${server.address().port}`);
  console.log(`Mounted ${host.providerNames.length} upstream providers; runtime: persistent`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  await host.close();
  server.close(() => { clearTimeout(deadline); process.exit(0); });
  server.closeIdleConnections();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
