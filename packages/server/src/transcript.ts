import { open, realpath } from 'node:fs/promises';
import { sep } from 'node:path';
import { parseTranscript } from '@agent-monitor/adapters';
import type { AgentId, TranscriptItem } from '@agent-monitor/protocol';

export const TAIL_BYTES = 1_000_000;
export const TAIL_ITEMS = 80;

/**
 * The transcript path comes from a hook payload, so treat it as untrusted: it must be a `.jsonl` file that
 * really lives (after symlink resolution) under one of the agents' own directories.
 */
export async function resolveTranscript(path: string, roots: readonly string[]): Promise<string | null> {
  if (!path.endsWith('.jsonl')) return null;
  try {
    const real = await realpath(path);
    for (const root of roots) {
      const realRoot = await realpath(root).catch(() => null);
      if (realRoot && real.startsWith(realRoot + sep)) return real;
    }
  } catch {
    /* missing file */
  }
  return null;
}

/** Parse the last ~1 MB of a transcript: cheap enough to poll, and always shows the latest activity. */
export async function readTranscript(
  agent: AgentId,
  path: string,
  { maxBytes = TAIL_BYTES, limit = TAIL_ITEMS } = {},
): Promise<{ items: TranscriptItem[]; size: number }> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // began mid-line
    return { items: parseTranscript(agent, lines).slice(-limit), size };
  } finally {
    await fh.close();
  }
}
