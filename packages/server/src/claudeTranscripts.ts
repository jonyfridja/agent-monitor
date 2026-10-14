import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Claude Code session files are `<uuid>.jsonl` directly under a project directory. */
const SESSION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** How much of the file to scan for `"cwd"`. Early records are often queue ops without one. */
const CWD_SCAN_BYTES = 256 * 1024;

export interface ClaudeTranscriptFile {
  id: string;
  path: string;
  mtime: number;
}

/**
 * Claude Code (CLI and the desktop app) writes `~/.claude/projects/<slug>/<sessionId>.jsonl`.
 * Same tree, same hooks file. The id is the file name.
 */
export async function findClaudeTranscript(projectsDir: string, id: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const project of projects) {
    const path = join(projectsDir, project, `${id}.jsonl`);
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* not this project */
    }
  }
  return null;
}

/** Transcripts modified at or after `sinceMs` (epoch ms). Missing dir → empty. */
export async function listRecentClaudeTranscripts(projectsDir: string, sinceMs: number): Promise<ClaudeTranscriptFile[]> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return [];
  }
  const out: ClaudeTranscriptFile[] = [];
  for (const project of projects) {
    let names: string[];
    try {
      names = await readdir(join(projectsDir, project));
    } catch {
      continue;
    }
    for (const name of names) {
      const m = SESSION_FILE.exec(name);
      if (!m) continue;
      const path = join(projectsDir, project, name);
      try {
        const st = await stat(path);
        if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ id: m[1] ?? name, path, mtime: st.mtimeMs });
      } catch {
        /* not a file */
      }
    }
  }
  return out;
}

/** First `"cwd"` string in the head of a Claude jsonl. Desktop scratch sessions store the workspace here. */
export async function claudeCwd(path: string): Promise<string | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(CWD_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, CWD_SCAN_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const m = text.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!m) return;
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return;
  } finally {
    await fh?.close();
  }
}
