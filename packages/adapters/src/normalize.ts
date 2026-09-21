import type { AgentEvent, AgentEventKind, AgentId } from '@agent-monitor/protocol';

type Raw = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function kindOf(name: string, raw: Raw): AgentEventKind | null {
  switch (name) {
    case 'SessionStart':
      return 'session-start';
    case 'UserPromptSubmit':
      return 'prompt';
    case 'PreToolUse':
    case 'PostToolUse':
      return 'tool';
    case 'PermissionRequest':
      return 'approval';
    case 'Stop':
      return 'turn-end';
    case 'SessionEnd':
      return 'session-end';
    case 'Notification': {
      const type = str(raw.notification_type);
      if (type === 'permission_prompt') return 'approval';
      if (type === 'idle_prompt') return 'idle';
      return null;
    }
    default:
      // SubagentStop, PreCompact, … are not a state change of the user-facing session.
      return null;
  }
}

/**
 * Turn a raw hook payload (stdin JSON of a Claude Code / Codex hook) into an AgentEvent.
 * Returns null for payloads that are not a state change we track.
 */
export function normalize(agent: AgentId, raw: unknown, now: number = Date.now()): AgentEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Raw;
  const name = str(p.hook_event_name);
  const sessionId = str(p.session_id);
  if (!name || !sessionId) return null;
  const kind = kindOf(name, p);
  if (!kind) return null;
  return { agent, sessionId, cwd: str(p.cwd), kind, at: now, transcriptPath: str(p.transcript_path) };
}
