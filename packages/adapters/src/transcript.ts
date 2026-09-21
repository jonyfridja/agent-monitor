import type { AgentId, TranscriptItem } from '@agent-monitor/protocol';

// Transcript files are the agents' own, unversioned formats — parse defensively and skip what we don't know.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

const ANSI = new RegExp(String.raw`\[[0-9;?]*[ -/]*[@-~]`, 'g');
const MAX = { message: 4000, tool: 300, result: 800 };

function clip(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text : '';
  const clean = s.replace(ANSI, '').replace(/\r/g, '').replace(/^\n+/, '').trimEnd();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/** One-line description of a tool call: the command, file, or pattern — whatever a human would look at. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') {
    // Codex `exec` tools wrap a command in a JS snippet: pull out `cmd: "..."` when present.
    const cmd = /cmd:\s*("(?:[^"\\]|\\.)*")/.exec(input)?.[1];
    if (cmd) {
      try {
        return clip(JSON.parse(cmd), MAX.tool);
      } catch {
        /* fall through to the raw snippet */
      }
    }
    return clip(input.split('\n')[0], MAX.tool);
  }
  if (input && typeof input === 'object') {
    const o = input as Rec;
    for (const key of ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description']) {
      const v = o[key];
      if (typeof v === 'string' && v) return clip(v.split('\n')[0], MAX.tool);
      if (Array.isArray(v) && v.length) return clip(v.join(' '), MAX.tool);
    }
    return clip(JSON.stringify(o), MAX.tool);
  }
  return '';
}

/** Tool output arrives as a string or as a list of `{text}` blocks. */
function outputText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((b: Rec) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n');
  return '';
}

/** Codex wraps command output as `Script completed … Output:` + `{"output": "...", "exit_code": N}`; show just the output. */
function codexOutputText(v: unknown): string {
  const blocks = Array.isArray(v) ? v.map((b: Rec) => (typeof b === 'string' ? b : b?.text ?? '')) : [outputText(v)];
  const parts: string[] = [];
  for (const text of blocks as string[]) {
    if (/^Script (completed|failed)\b[^]*\bOutput:\s*$/.test(text)) continue; // header only
    if (text.startsWith('{')) {
      try {
        const o = JSON.parse(text) as Rec;
        if (typeof o.output === 'string') {
          parts.push(o.exit_code ? `${o.output}\n[exit ${o.exit_code}]` : o.output);
          continue;
        }
      } catch {
        /* not an envelope */
      }
    }
    parts.push(text);
  }
  return parts.join('\n');
}

const INJECTED = /^<(local-command|command-|system-reminder|user-prompt-submit-hook)/;

function claudeItems(d: Rec): TranscriptItem[] {
  if (d.isSidechain || d.isMeta || !d.message) return [];
  const content = d.message.content;
  const out: TranscriptItem[] = [];
  if (d.type === 'user') {
    if (typeof content === 'string') {
      if (!INJECTED.test(content)) out.push({ kind: 'user', text: clip(content, MAX.message) });
    } else if (Array.isArray(content)) {
      for (const b of content as Rec[]) {
        if (b.type === 'tool_result') out.push({ kind: 'result', text: clip(outputText(b.content), MAX.result) });
        else if (b.type === 'text' && !INJECTED.test(b.text ?? '')) out.push({ kind: 'user', text: clip(b.text, MAX.message) });
      }
    }
  } else if (d.type === 'assistant' && Array.isArray(content)) {
    for (const b of content as Rec[]) {
      if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'assistant', text: clip(b.text, MAX.message) });
      else if (b.type === 'tool_use') out.push({ kind: 'tool', tool: String(b.name ?? 'tool'), text: summarizeToolInput(b.input) });
    }
  }
  return out;
}

function codexItems(d: Rec): TranscriptItem[] {
  const p: Rec = d.payload ?? {};
  // Real user prompts come from event_msg; the response_item "user" messages are injected context.
  if (d.type === 'event_msg') {
    return p.type === 'user_message' && p.message ? [{ kind: 'user', text: clip(p.message, MAX.message) }] : [];
  }
  if (d.type !== 'response_item') return [];
  switch (p.type) {
    case 'message': {
      if (p.role !== 'assistant' || !Array.isArray(p.content)) return [];
      const text = (p.content as Rec[]).filter((b) => b.type === 'output_text').map((b) => b.text).join('\n');
      return text.trim() ? [{ kind: 'assistant', text: clip(text, MAX.message) }] : [];
    }
    case 'custom_tool_call':
      return [{ kind: 'tool', tool: String(p.name ?? 'tool'), text: summarizeToolInput(p.input) }];
    case 'function_call': {
      let args: unknown = p.arguments;
      try {
        args = JSON.parse(p.arguments);
      } catch {
        /* keep the raw string */
      }
      return [{ kind: 'tool', tool: String(p.name ?? 'tool'), text: summarizeToolInput(args) }];
    }
    case 'local_shell_call':
      return [{ kind: 'tool', tool: 'shell', text: summarizeToolInput(p.action?.command ?? p.action) }];
    case 'custom_tool_call_output':
    case 'function_call_output':
      return [{ kind: 'result', text: clip(codexOutputText(p.output), MAX.result) }];
    default:
      return []; // reasoning, developer messages, token counts, …
  }
}

/** Turn raw JSONL lines of a Claude Code / Codex transcript into display items (unparseable lines are skipped). */
export function parseTranscript(agent: AgentId, lines: readonly string[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: Rec;
    try {
      d = JSON.parse(line);
    } catch {
      continue; // partial first line of a tail read, or a corrupt record
    }
    items.push(...(agent === 'claude' ? claudeItems(d) : codexItems(d)));
  }
  return items;
}
