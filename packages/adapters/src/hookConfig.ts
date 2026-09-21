import type { AgentId } from '@agent-monitor/protocol';

/** Every command we install contains this token, so we can find and remove exactly our own entries. */
export const MARKER = 'AGENT_MONITOR=1';

interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
export interface HookFile {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

/** Never blocks or fails the agent: 1s cap, output discarded, always exits 0. */
export function hookCommand(agent: AgentId, port: number): string {
  return (
    `${MARKER} curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- ` +
    `'http://127.0.0.1:${port}/api/events?agent=${agent}' >/dev/null 2>&1 || true`
  );
}

const isOurs = (h: HookEntry): boolean => typeof h.command === 'string' && h.command.includes(MARKER);

/** Remove our entries (only ours), pruning groups and events that end up empty. */
export function removeOurHooks(file: HookFile): HookFile {
  if (!file.hooks) return file;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(file.hooks)) {
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const entries = group.hooks ?? [];
      if (!entries.some(isOurs)) {
        kept.push(group); // untouched: keep byte-for-byte semantics
        continue;
      }
      const rest = entries.filter((h) => !isOurs(h));
      if (rest.length > 0) kept.push({ ...group, hooks: rest });
    }
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _old, ...rest } = file;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

/** Idempotent: strips our previous entries, then appends one fresh group per event. */
export function addOurHooks(file: HookFile, events: readonly string[], command: string): HookFile {
  const clean = removeOurHooks(file);
  const hooks: Record<string, HookGroup[]> = { ...(clean.hooks ?? {}) };
  for (const event of events) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command }] }];
  }
  return { ...clean, hooks };
}

/** Which port our hooks currently point at, per event — for install-state reporting. */
export function installedPorts(file: HookFile, events: readonly string[]): (number | null)[] {
  return events.map((event) => {
    for (const g of file.hooks?.[event] ?? []) {
      for (const h of g.hooks ?? []) {
        if (isOurs(h)) return Number(/127\.0\.0\.1:(\d+)\//.exec(h.command ?? '')?.[1]) || null;
      }
    }
    return null;
  });
}
