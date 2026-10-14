import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_PORT, type AgentId } from '@agent-monitor/protocol';
import { DEFAULT_PASSWORD, hashPassword } from './auth.ts';

export interface Config {
  port: number;
  /** Pairing secret for phones on the LAN; loopback callers (the host app, hooks) need none. */
  token: string;
  agents: Record<AgentId, { enabled: boolean }>;
  launchAtLogin: boolean;
  /** Let phones open a session's conversation log (prompts, code, command output). */
  shareTranscripts: boolean;
  /** scrypt hash of the phone password. A fresh install gets the hash of DEFAULT_PASSWORD. */
  passwordHash: string;
  /** Signs phones' login cookies. Rotating it (or the password) logs every phone out. */
  sessionSecret: string;
  /** HTTPS for phones. Self-signed in ~/.agent-monitor/tls unless `cert`/`key` point at your own (e.g. mkcert). */
  tls: { enabled: boolean; cert?: string; key?: string };
}

export const CONFIG_DIR = join(homedir(), '.agent-monitor');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** Everything but the password hash, which takes an async scrypt run (`loadConfig` adds it). */
export function defaultConfig(): Omit<Config, 'passwordHash'> {
  return {
    port: DEFAULT_PORT,
    token: randomBytes(9).toString('base64url'),
    agents: { claude: { enabled: true }, codex: { enabled: true }, cursor: { enabled: true } },
    launchAtLogin: false,
    shareTranscripts: true,
    sessionSecret: randomBytes(32).toString('base64url'),
    tls: { enabled: true },
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
      cursor: { enabled: saved.agents?.cursor?.enabled ?? true },
    },
    launchAtLogin: saved.launchAtLogin ?? false,
    shareTranscripts: saved.shareTranscripts ?? true,
    passwordHash: saved.passwordHash || (await hashPassword(DEFAULT_PASSWORD)),
    sessionSecret: saved.sessionSecret ?? defaults.sessionSecret,
    tls: {
      enabled: saved.tls?.enabled ?? true,
      ...(saved.tls?.cert ? { cert: saved.tls.cert } : {}),
      ...(saved.tls?.key ? { key: saved.tls.key } : {}),
    },
  };
  if (!saved.token || !saved.sessionSecret || !saved.passwordHash) await saveConfig(config, path); // persist generated secrets
  return config;
}

export async function saveConfig(config: Config, path: string = CONFIG_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, path);
}
