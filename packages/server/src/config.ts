import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT, type AgentId } from '@agent-monitor/protocol';

export interface Config {
  port: number;
  /** Pairing secret for phones on the LAN; loopback callers (the host app, hooks) need none. */
  token: string;
  agents: Record<AgentId, { enabled: boolean }>;
  launchAtLogin: boolean;
  /** Let phones open a session's conversation log (prompts, code, command output). */
  shareTranscripts: boolean;
}

export const CONFIG_PATH = join(homedir(), '.agent-monitor', 'config.json');

export function defaultConfig(): Config {
  return {
    port: DEFAULT_PORT,
    token: randomBytes(9).toString('base64url'),
    agents: { claude: { enabled: true }, codex: { enabled: true } },
    launchAtLogin: false,
    shareTranscripts: true,
  };
}

/** Load config, filling any missing field from defaults so old files keep working. */
export async function loadConfig(path: string = CONFIG_PATH): Promise<Config> {
  const defaults = defaultConfig();
  let saved: Partial<Config> = {};
  try {
    saved = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const config: Config = {
    port: saved.port ?? defaults.port,
    token: saved.token ?? defaults.token,
    agents: {
      claude: { enabled: saved.agents?.claude?.enabled ?? true },
      codex: { enabled: saved.agents?.codex?.enabled ?? true },
    },
    launchAtLogin: saved.launchAtLogin ?? false,
    shareTranscripts: saved.shareTranscripts ?? true,
  };
  if (!saved.token) await saveConfig(config, path); // persist the generated token
  return config;
}

export async function saveConfig(config: Config, path: string = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
