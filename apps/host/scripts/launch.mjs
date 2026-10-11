// `pnpm host` — build, then start the tray app detached from this terminal (closing the terminal keeps it running).
//   pnpm host --foreground   attach to the terminal instead (logs inline, Ctrl-C quits) — for development
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron'; // in plain Node this is the path to the Electron binary

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const logDir = join(homedir(), '.agent-monitor');
const logPath = join(logDir, 'host.log');
const foreground = process.argv.includes('--foreground');

execFileSync(process.execPath, ['build.mjs'], { cwd: appDir, stdio: foreground ? 'inherit' : 'ignore' });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by some editors' terminals; it would start Electron as plain Node

if (foreground) {
  const child = spawn(electron, [appDir], { stdio: 'inherit', env });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  mkdirSync(logDir, { recursive: true });
  const log = openSync(logPath, 'a', 0o600);
  // detached = its own session: no SIGHUP when the terminal closes.
  const child = spawn(electron, [appDir], { detached: true, stdio: ['ignore', log, log], env });
  child.unref();
  // A second launch just shows the running app's window (single-instance lock) and exits; that is fine too.
  console.log('agent-monitor is starting in the menu bar. You can close this terminal.');
  console.log('  window: click the menu-bar icon → Open window (QR code, password, hooks)');
  console.log(`  log:    ${logPath}`);
  console.log('  quit:   menu-bar icon → Quit, or `pnpm stop`');
}
