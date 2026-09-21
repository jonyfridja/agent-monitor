// `pnpm stop` — stop every agent-monitor process: the tray app (dev or packaged), its helpers, the headless server.
//   pnpm stop [--dry-run] [--port N]
// Two independent ways to recognise our processes, so a change of launcher can't hide one:
//   1. by executable path (dev Electron, the .app, `node …/cli.ts`)
//   2. by port: whatever listens on the port AND answers /api/state like agent-monitor
// Graceful first (SIGTERM), then SIGKILL for anything still alive after the grace period.
// Anything else holding the port is reported, never killed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeAgentMonitor } from '../packages/server/src/probe.ts';
import { parsePs, planStop } from './stop-lib.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const GRACE_MS = 3000;
const DEFAULT_PORT = 47821;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists, just not ours
  }
};

function ports() {
  const i = args.indexOf('--port');
  if (i !== -1 && Number(args[i + 1])) return [Number(args[i + 1])];
  let configured = DEFAULT_PORT;
  try {
    configured = JSON.parse(readFileSync(join(homedir(), '.agent-monitor', 'config.json'), 'utf8')).port ?? DEFAULT_PORT;
  } catch {
    /* no config yet */
  }
  return [...new Set([configured, DEFAULT_PORT])];
}

function listeners(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const owners = [];
    let cur = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('p')) owners.push((cur = { port, pid: Number(line.slice(1)) }));
      else if (line.startsWith('c') && cur) cur.command = line.slice(1);
    }
    return owners;
  } catch {
    return []; // nothing listening (lsof exits 1) or lsof unavailable
  }
}

async function portOwners(list) {
  const out = [];
  for (const port of list) {
    const owners = listeners(port);
    if (owners.length === 0) continue;
    const ours = await probeAgentMonitor(port);
    out.push(...owners.map((o) => ({ ...o, ours })));
  }
  return out;
}

const send = (pids, signal) => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
};

const checkPorts = ports();
const ps = execFileSync('ps', ['-wwaxo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const { targets, foreign } = planStop({ procs: parsePs(ps), selfPid: process.pid, portOwners: await portOwners(checkPorts) });

if (targets.length === 0) {
  console.log('No agent-monitor processes running.');
} else {
  for (const t of targets) console.log(`${dryRun ? 'would stop' : 'stopping'} ${String(t.pid).padStart(6)}  ${t.kind}`);
  if (!dryRun) {
    const pids = targets.map((t) => t.pid);
    send(pids, 'SIGTERM');
    const deadline = Date.now() + GRACE_MS;
    while (Date.now() < deadline && pids.some(alive)) await sleep(100);
    const stubborn = pids.filter(alive);
    if (stubborn.length) {
      console.log(`force-killing ${stubborn.length} that ignored SIGTERM: ${stubborn.join(', ')}`);
      send(stubborn, 'SIGKILL');
      await sleep(300);
    }
    const left = pids.filter(alive);
    console.log(left.length ? `Could not stop: ${left.join(', ')}` : `Stopped ${pids.length} process${pids.length === 1 ? '' : 'es'}.`);
    if (left.length) process.exitCode = 1;
  }
}

for (const o of foreign) console.log(`Note: port ${o.port} is held by pid ${o.pid} (${o.command ?? 'unknown'}) — it does not answer like agent-monitor, left alone.`);
if (!dryRun) {
  const still = checkPorts.flatMap((p) => listeners(p));
  if (still.length === 0) console.log(`Port${checkPorts.length > 1 ? 's' : ''} ${checkPorts.join(', ')} free.`);
}
