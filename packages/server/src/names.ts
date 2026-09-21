import { open, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentId } from '@agent-monitor/protocol';

/** Where each harness keeps the names it shows the user. */
export interface NameSources {
  /** `~/.claude/sessions/<pid>.json` — `{sessionId, name, nameSource}`. */
  claudeSessionsDir: string;
  /** Claude desktop app: `<account>/<workspace>/local_*.json` — `{cliSessionId, title}`. macOS only for now. */
  claudeDesktopDir?: string;
  /** `~/.codex/session_index.jsonl` — `{id, thread_name}` per line, later lines win. */
  codexIndex: string;
}

export function defaultNameSources(home: string = homedir()): NameSources {
  return {
    claudeSessionsDir: join(home, '.claude', 'sessions'),
    claudeDesktopDir:
      process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions') : undefined,
    codexIndex: join(home, '.codex', 'session_index.jsonl'),
  };
}

const MAX_NAME = 80;
const TITLE_TAIL_BYTES = 512_000;
const TITLE_HEAD_BYTES = 128_000;

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_NAME) : undefined;
};

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(path, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Titles {
  custom?: string;
  ai?: string;
}

function scanTitles(text: string, into: Titles): void {
  for (const line of text.split('\n')) {
    if (!line.includes('-title"')) continue;
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (d.type === 'custom-title') into.custom = clean(d.customTitle) ?? into.custom;
      else if (d.type === 'ai-title') into.ai = clean(d.aiTitle) ?? into.ai;
    } catch {
      /* partial line at a window edge */
    }
  }
}

/**
 * `customTitle` (set by /rename or `--name`) and `aiTitle` records in a Claude transcript — the title the CLI shows in
 * the terminal tab. The CLI re-appends them, so the tail has the latest; a very long session may have pushed them out
 * of it, in which case the head still holds the original.
 */
async function transcriptTitles(path: string): Promise<Titles> {
  const titles: Titles = {};
  let fh;
  try {
    fh = await open(path, 'r');
    const { size } = await fh.stat();
    const read = async (start: number, length: number) => {
      const buf = Buffer.alloc(length);
      await fh!.read(buf, 0, length, start);
      return buf.toString('utf8');
    };
    const tailStart = Math.max(0, size - TITLE_TAIL_BYTES);
    scanTitles(await read(tailStart, size - tailStart), titles);
    if (!titles.custom && !titles.ai && tailStart > 0) scanTitles(await read(0, Math.min(TITLE_HEAD_BYTES, tailStart)), titles);
  } catch {
    /* unreadable: no titles */
  } finally {
    await fh?.close();
  }
  return titles;
}

/**
 * Looks up the name the harness itself shows for a session, so the phone matches the app.
 * Directory-wide indexes are cached briefly: hooks fire on every tool call, the files change rarely.
 */
export class NameResolver {
  #src: NameSources;
  #ttl: number;
  #indexes = new Map<string, { at: number; map: Map<string, string> }>();

  constructor(src: NameSources, ttlMs = 5_000) {
    this.#src = src;
    this.#ttl = ttlMs;
  }

  async #index(key: string, build: () => Promise<Map<string, string>>): Promise<Map<string, string>> {
    const hit = this.#indexes.get(key);
    if (hit && Date.now() - hit.at < this.#ttl) return hit.map;
    const map = await build().catch(() => new Map<string, string>());
    this.#indexes.set(key, { at: Date.now(), map });
    return map;
  }

  async resolve(agent: AgentId, sessionId: string, transcriptPath?: string): Promise<string | undefined> {
    return agent === 'codex' ? this.#codex(sessionId) : this.#claude(sessionId, transcriptPath);
  }

  async #codex(id: string): Promise<string | undefined> {
    const names = await this.#index('codex', async () => {
      const map = new Map<string, string>();
      for (const line of (await readFile(this.#src.codexIndex, 'utf8')).split('\n')) {
        try {
          const d = JSON.parse(line) as { id?: string; thread_name?: string };
          const name = clean(d.thread_name);
          if (d.id && name) map.set(d.id, name);
        } catch {
          /* skip bad line */
        }
      }
      return map;
    });
    return names.get(id);
  }

  /**
   * What Claude shows in the terminal tab / app sidebar, in order of trust:
   *  1. the desktop app's sidebar title (only exists for desktop sessions);
   *  2. the transcript's own `customTitle`, then `aiTitle` — what a CLI session titles its terminal with;
   *  3. the session file's `name`, last: a CLI started from inside the desktop app inherits the *host's* name there
   *     ("Agent-monitor MVP" on a session whose terminal says "Clashes of the Victor project").
   * Auto-generated names ("jonyfridja-81", `nameSource: "derived"`) are never used: they say less than the folder.
   */
  async #claude(id: string, transcriptPath?: string): Promise<string | undefined> {
    const dir = this.#src.claudeDesktopDir;
    if (dir) {
      const titles = await this.#index('claude-desktop', async () => {
        const map = new Map<string, string>();
        for (const rel of await readdir(dir, { recursive: true })) {
          if (!basename(rel).startsWith('local_') || !rel.endsWith('.json')) continue;
          const d = await readJson(join(dir, rel));
          const title = clean(d?.title);
          if (typeof d?.cliSessionId === 'string' && title) map.set(d.cliSessionId, title);
        }
        return map;
      });
      if (titles.has(id)) return titles.get(id);
    }
    const fromTranscript = transcriptPath ? await transcriptTitles(transcriptPath) : {};
    if (fromTranscript.custom) return fromTranscript.custom;
    if (fromTranscript.ai) return fromTranscript.ai;
    const named = await this.#index('claude-sessions', async () => {
      const map = new Map<string, string>();
      for (const f of await readdir(this.#src.claudeSessionsDir)) {
        if (!f.endsWith('.json')) continue;
        const d = await readJson(join(this.#src.claudeSessionsDir, f));
        const name = clean(d?.name);
        if (typeof d?.sessionId === 'string' && name && d.nameSource !== 'derived') map.set(d.sessionId, name);
      }
      return map;
    });
    return named.get(id);
  }
}
