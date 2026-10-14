import { mkdir, readFile, rename, writeFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentId } from '@agent-monitor/protocol';
import {
  addCursorHooks,
  addOurHooks,
  hookCommand,
  installedCursorPorts,
  installedPorts,
  removeCursorHooks,
  removeOurHooks,
  type CursorHookFile,
  type HookFile,
} from './hookConfig.ts';

export { normalize } from './normalize.ts';
export {
  MARKER,
  hookCommand,
  addOurHooks,
  removeOurHooks,
  installedPorts,
  addCursorHooks,
  removeCursorHooks,
  installedCursorPorts,
} from './hookConfig.ts';

export type InstallState = 'installed' | 'not-installed' | 'wrong-port';

export interface AgentAdapter {
  id: AgentId;
  configPath: string;
  events: readonly string[];
  install(port: number): Promise<void>;
  uninstall(): Promise<void>;
  state(port: number): Promise<InstallState>;
}

const COMMON_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
] as const;

/**
 * Observational Cursor events only. `preToolUse`, `beforeShellExecution`, `beforeReadFile`, and
 * `subagentStart` are permission hooks: exit 0 with no JSON blocks the tool.
 */
const CURSOR_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'stop', 'sessionEnd'] as const;

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {} as T;
    throw err; // unreadable/invalid JSON: refuse to overwrite the user's config
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function writeJsonAtomic(path: string, data: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const backup = `${path}.agent-monitor.bak`;
  if ((await exists(path)) && !(await exists(backup))) await copyFile(path, backup);
  const tmp = `${path}.agent-monitor.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await rename(tmp, path);
}

function makeAdapter(id: AgentId, configPath: string, events: readonly string[]): AgentAdapter {
  return {
    id,
    configPath,
    events,
    async install(port) {
      const file = await readJson<HookFile>(configPath);
      await writeJsonAtomic(configPath, addOurHooks(file, events, hookCommand(id, port)));
    },
    async uninstall() {
      if (!(await exists(configPath))) return;
      await writeJsonAtomic(configPath, removeOurHooks(await readJson<HookFile>(configPath)));
    },
    async state(port) {
      const ports = installedPorts(await readJson<HookFile>(configPath), events);
      if (ports.every((p) => p === null)) return 'not-installed';
      return ports.every((p) => p === port) ? 'installed' : 'wrong-port';
    },
  };
}

function makeCursorAdapter(configPath: string): AgentAdapter {
  return {
    id: 'cursor',
    configPath,
    events: CURSOR_EVENTS,
    async install(port) {
      const file = await readJson<CursorHookFile>(configPath);
      await writeJsonAtomic(configPath, addCursorHooks(file, CURSOR_EVENTS, hookCommand('cursor', port)));
    },
    async uninstall() {
      if (!(await exists(configPath))) return;
      await writeJsonAtomic(configPath, removeCursorHooks(await readJson<CursorHookFile>(configPath)));
    },
    async state(port) {
      const ports = installedCursorPorts(await readJson<CursorHookFile>(configPath), CURSOR_EVENTS);
      if (ports.every((p) => p === null)) return 'not-installed';
      return ports.every((p) => p === port) ? 'installed' : 'wrong-port';
    },
  };
}

export function createAdapters(home: string = homedir()): Record<AgentId, AgentAdapter> {
  return {
    claude: makeAdapter('claude', join(home, '.claude', 'settings.json'), [...COMMON_EVENTS, 'Notification']),
    codex: makeAdapter('codex', join(home, '.codex', 'hooks.json'), COMMON_EVENTS),
    cursor: makeCursorAdapter(join(home, '.cursor', 'hooks.json')),
  };
}
export { parseTranscript, summarizeToolInput } from './transcript.ts';
