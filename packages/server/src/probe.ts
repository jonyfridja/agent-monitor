/** agent-monitor's `/api/state` shape: `{ now: number, sessions: [...] }`. Nothing else on the LAN answers like this. */
export function looksLikeAgentMonitor(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const s = state as { now?: unknown; sessions?: unknown };
  return typeof s.now === 'number' && Array.isArray(s.sessions);
}

/**
 * Is whatever listens on `port` an agent-monitor server? Independent of how it was launched (tray app, .app, headless,
 * renamed copy) — used by `pnpm stop` to find it and by the server CLI to explain EADDRINUSE.
 */
export async function probeAgentMonitor(port: number, timeoutMs = 1000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && looksLikeAgentMonitor(await res.json());
  } catch {
    return false; // refused, timed out, or not JSON
  }
}
