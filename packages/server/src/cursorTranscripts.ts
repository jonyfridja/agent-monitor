import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** How far back to surface a Cursor chat the hooks never pointed at. */
export const RECENT_CURSOR_TRANSCRIPT_MS = 12 * 60 * 60 * 1000;

export interface CursorTranscriptFile {
  id: string;
  path: string;
  mtime: number;
}

/**
 * Cursor writes `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`.
 * Hook payloads often omit `transcript_path` (null on session start), so the id is the lookup key.
 */
export async function findCursorTranscript(projectsDir: string, id: string): Promise<string | null> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return null;
  }
  for (const project of projects) {
    const path = join(projectsDir, project, 'agent-transcripts', id, `${id}.jsonl`);
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* not this project */
    }
  }
  return null;
}

/** Transcripts modified at or after `sinceMs` (epoch ms). Missing dir → empty. */
export async function listRecentCursorTranscripts(projectsDir: string, sinceMs: number): Promise<CursorTranscriptFile[]> {
  let projects: string[];
  try {
    projects = await readdir(projectsDir);
  } catch {
    return [];
  }
  const out: CursorTranscriptFile[] = [];
  for (const project of projects) {
    let ids: string[];
    try {
      ids = await readdir(join(projectsDir, project, 'agent-transcripts'));
    } catch {
      continue;
    }
    for (const id of ids) {
      const path = join(projectsDir, project, 'agent-transcripts', id, `${id}.jsonl`);
      try {
        const st = await stat(path);
        if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ id, path, mtime: st.mtimeMs });
      } catch {
        /* no jsonl for this directory */
      }
    }
  }
  return out;
}

/** `~/.cursor/chats/<workspace>/<id>/meta.json` → cwd. One walk, used to label discovered chats. */
export async function cursorCwds(chatsDir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let buckets: string[];
  try {
    buckets = await readdir(chatsDir);
  } catch {
    return map;
  }
  for (const bucket of buckets) {
    let convos: string[];
    try {
      convos = await readdir(join(chatsDir, bucket));
    } catch {
      continue;
    }
    for (const id of convos) {
      try {
        const meta = JSON.parse(await readFile(join(chatsDir, bucket, id, 'meta.json'), 'utf8')) as { cwd?: unknown };
        if (typeof meta.cwd === 'string' && meta.cwd) map.set(id, meta.cwd);
      } catch {
        /* not a chat directory */
      }
    }
  }
  return map;
}
