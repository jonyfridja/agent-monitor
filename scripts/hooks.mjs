// `pnpm hooks` — see, add or remove agent-monitor's hooks in the agents' config files. Nothing else edits them.
//   pnpm hooks                          status for every agent
//   pnpm hooks install [claude|codex|cursor]   add our entries (all agents if none named); a one-time .agent-monitor.bak is made
//   pnpm hooks uninstall [claude|codex|cursor] remove our entries, and only ours
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAdapters, hookCommand } from '../packages/adapters/src/index.ts';

const AGENTS = ['claude', 'codex', 'cursor'];
const [action = 'status', ...names] = process.argv.slice(2);
const DEFAULT_PORT = 47821;

/** Read-only: the port the host listens on (a custom one lives in config.json). */
function port() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.agent-monitor', 'config.json'), 'utf8')).port ?? DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

if (!['status', 'install', 'uninstall'].includes(action) || names.some((n) => !AGENTS.includes(n))) {
  console.error('usage: pnpm hooks [status | install | uninstall] [claude | codex | cursor]');
  process.exit(2);
}

const adapters = createAdapters();
const p = port();
let failed = false;
for (const id of names.length ? names : AGENTS) {
  const a = adapters[id];
  try {
    if (action === 'install') await a.install(p);
    if (action === 'uninstall') await a.uninstall();
    const state = await a.state(p);
    console.log(`${id.padEnd(6)} ${state.padEnd(13)} ${a.configPath}`);
    if (action === 'install') console.log(`       events: ${a.events.join(', ')}\n       command: ${hookCommand(id, p)}`);
  } catch (err) {
    failed = true;
    console.error(`${id.padEnd(6)} error         ${a.configPath}: ${err.message} (file left untouched)`);
  }
}
if (action !== 'status' && !failed) console.log('\nRestart running agent sessions: they read hooks when a session starts.');
process.exit(failed ? 1 : 0);
