// Pure helpers for `pnpm stop`: decide which processes are agent-monitor's, from a `ps` listing.

/**
 * Only these are ever killed. Anchored to the *executable* at the start of the command line, so a shell or editor
 * whose command text merely mentions these paths (`bash -lc "… agent-monitor.app …"`) is never matched.
 */
export const PATTERNS = [
  // `pnpm host`: this repo's own Electron binary (main process and its Helper processes).
  { name: 'host app (dev)', re: /^\/\S*\/agent-monitor\/\S*\/electron\/dist\/Electron\.app\/Contents\// },
  // The built .app (main process and helpers), wherever it was copied to.
  { name: 'host app (packaged)', re: /^\/\S*\/agent-monitor\.app\/Contents\// },
];

/** An Electron *main* process: `…/Electron.app/Contents/MacOS/Electron`. */
const ELECTRON_MAIN = /Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/;

/** `ps -axo pid=,ppid=,command=` output → [{pid, ppid, command}]. */
export function parsePs(text) {
  const procs = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return procs;
}

/** The process itself and everything above it (pnpm, the shell, …) must never be killed by its own command. */
export function ancestors(procs, pid) {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const seen = new Set();
  for (let cur = pid; cur && !seen.has(cur); cur = parent.get(cur)) seen.add(cur);
  return seen;
}

export function findTargets(procs, selfPid) {
  const protectedPids = ancestors(procs, selfPid);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const targets = new Map();
  for (const p of procs) {
    if (protectedPids.has(p.pid)) continue;
    const hit = PATTERNS.find((x) => x.re.test(p.command));
    if (hit) targets.set(p.pid, { ...p, kind: hit.name });
  }
  // `electron .` from the app dir has a relative path in `ps`; its helpers don't. Take the parent of a matched helper.
  for (const t of [...targets.values()]) {
    const parent = byPid.get(t.ppid);
    if (parent && !protectedPids.has(parent.pid) && !targets.has(parent.pid) && ELECTRON_MAIN.test(parent.command)) {
      targets.set(parent.pid, { ...parent, kind: 'host app (dev)' });
    }
  }
  return [...targets.values()];
}

/**
 * Second, launcher-independent route: whatever listens on the port and answers like agent-monitor is ours, however it
 * was started (renamed .app, another checkout, a wrapper). Foreign listeners are reported, never targeted.
 *
 * @param portOwners [{ port, pid, command?, ours }] — `ours` is the result of probing that port's /api/state.
 */
export function planStop({ procs, selfPid, portOwners = [] }) {
  const targets = new Map(findTargets(procs, selfPid).map((t) => [t.pid, t]));
  const protectedPids = ancestors(procs, selfPid);
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const foreign = [];
  for (const o of portOwners) {
    if (targets.has(o.pid) || protectedPids.has(o.pid)) continue;
    if (o.ours) {
      const p = byPid.get(o.pid);
      targets.set(o.pid, { pid: o.pid, ppid: p?.ppid ?? 0, command: p?.command ?? o.command ?? '', kind: `agent-monitor on :${o.port} (found by port)` });
    } else if (!foreign.some((f) => f.pid === o.pid)) {
      foreign.push(o);
    }
  }
  return { targets: [...targets.values()], foreign };
}
