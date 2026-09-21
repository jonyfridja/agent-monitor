// Headless runner: `pnpm server`. The host app embeds the same server; this is for dev and remote boxes.
import { fileURLToPath } from 'node:url';
import { createAdapters } from '@agent-monitor/adapters';
import { AGENT_IDS } from '@agent-monitor/protocol';
import { loadConfig } from './config.ts';
import { probeAgentMonitor } from './probe.ts';
import { createMonitorServer, lanAddresses } from './server.ts';

const webDir = fileURLToPath(new URL('../../web/public', import.meta.url));
const config = await loadConfig();
const adapters = createAdapters();

const server = createMonitorServer({ port: config.port, token: config.token, webDir });
server.setEnabledAgents(AGENT_IDS.filter((a) => config.agents[a].enabled));
try {
  await server.start();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
  const ours = await probeAgentMonitor(config.port);
  console.error(
    ours
      ? `agent-monitor is already running on :${config.port} (the tray app, or another \`pnpm server\`).\n` +
          '  You only need one of them — the tray app already contains this server.\n' +
          '  To run the headless server instead, stop the other one first:  pnpm stop'
      : `Port ${config.port} is in use by another program (not agent-monitor).\n` +
          '  Free that port, or change "port" in ~/.agent-monitor/config.json.',
  );
  process.exit(1);
}

for (const id of AGENT_IDS) {
  if (!config.agents[id].enabled) continue;
  const state = await adapters[id].state(config.port);
  console.log(`${id}: hooks ${state}${state === 'installed' ? '' : ' (run with --install to add them)'}`);
  if (process.argv.includes('--install')) await adapters[id].install(config.port);
}

const [ip = 'localhost'] = lanAddresses();
console.log(`agent-monitor listening on :${config.port}`);
console.log(`phone: http://${ip}:${config.port}/?t=${config.token}`);

const shutdown = () => void server.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
