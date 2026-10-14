export type AgentId = 'claude' | 'codex' | 'cursor';

export const AGENT_IDS: readonly AgentId[] = ['claude', 'codex', 'cursor'];

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

export type Status = 'working' | 'waiting' | 'ended';

/** Why a session is in its current status; drives the label and sort order on the phone. */
export type Reason = 'approval' | 'your-turn' | 'idle' | 'stale';

export interface Session {
  id: string;
  agent: AgentId;
  cwd: string;
  project: string;
  /** The harness's own name for the session (app title / thread name), when it has one. */
  name?: string;
  status: Status;
  reason?: Reason;
  startedAt: number;
  /** When status/reason last changed. */
  stateSince: number;
  lastEventAt: number;
  /** The agent reported a transcript file the phone can open (path itself never leaves the host). */
  hasTranscript?: boolean;
}

/** Agent-agnostic event, produced by an adapter from a raw hook payload. */
export type AgentEventKind =
  | 'session-start'
  | 'prompt'
  | 'tool'
  | 'approval'
  | 'turn-end'
  | 'idle'
  | 'session-end';

export interface AgentEvent {
  agent: AgentId;
  sessionId: string;
  cwd?: string;
  kind: AgentEventKind;
  at: number;
  /** Server-side only: where the agent's conversation log lives. */
  transcriptPath?: string;
}

/** One rendered line-group of a session's conversation, agent-agnostic. */
export interface TranscriptItem {
  kind: 'user' | 'assistant' | 'tool' | 'result';
  text: string;
  /** Tool name for `kind: 'tool'`. */
  tool?: string;
}

export type NoticeLevel = 'info' | 'attention' | 'urgent';

export interface Notice {
  id: string;
  title: string;
  body: string;
  level: NoticeLevel;
  /** Set for notices raised by a session (approval / turn end); absent for custom `/api/notify` ones. */
  agent?: AgentId;
  sessionId?: string;
  at: number;
}

/** Messages pushed to viewers over SSE. `now` is the server clock, for skew-free timers. */
export type StreamMessage =
  | { type: 'snapshot'; now: number; sessions: Session[] }
  | { type: 'session'; now: number; session: Session }
  | { type: 'remove'; now: number; agent: AgentId; id: string }
  | { type: 'notice'; now: number; notice: Notice };

export interface Viewer {
  id: string;
  ip: string;
  userAgent: string;
  since: number;
}

export const DEFAULT_PORT = 47821;

export function projectName(cwd: string | undefined): string {
  if (!cwd) return 'unknown';
  const trimmed = cwd.replace(/\/+$/, '');
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return name || trimmed || 'unknown';
}
