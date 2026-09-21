import { mkdir, readFile, rename, writeFile, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentId } from '@agent-monitor/protocol';
import {
  addOurHooks,
  hookCommand,
  installedPorts,
  removeOurHooks,
  type HookFile,
} from './hookConfig.ts';

export { normalize } from './normalize.ts';
export { MARKER, hookCommand, addOurHooks, removeOurHooks, installedPorts } from './hookConfig.ts';

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

async function readJson(path: string): Promise<HookFile> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as HookFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err; // unreadable/invalid JSON: refuse to overwrite the user's config
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function writeJsonAtomic(path: string, data: HookFile): Promise<void> {
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
      const file = await readJson(configPath);
      await writeJsonAtomic(configPath, addOurHooks(file, events, hookCommand(id, port)));
    },
    async uninstall() {
      if (!(await exists(configPath))) return;
      await writeJsonAtomic(configPath, removeOurHooks(await readJson(configPath)));
    },
    async state(port) {
      const ports = installedPorts(await readJson(configPath), events);
      if (ports.every((p) => p === null)) return 'not-installed';
      return ports.every((p) => p === port) ? 'installed' : 'wrong-port';
    },
  };
}

export function createAdapters(home: string = homedir()): Record<AgentId, AgentAdapter> {
  return {
    claude: makeAdapter('claude', join(home, '.claude', 'settings.json'), [...COMMON_EVENTS, 'Notification']),
    codex: makeAdapter('codex', join(home, '.codex', 'hooks.json'), COMMON_EVENTS),
  };
}
export { parseTranscript, summarizeToolInput } from './transcript.ts';
