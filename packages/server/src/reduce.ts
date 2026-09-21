import {
  AGENT_LABELS,
  projectName,
  type AgentEvent,
  type Notice,
  type Reason,
  type Session,
  type Status,
} from '@agent-monitor/protocol';

export type NoticeDraft = Pick<Notice, 'title' | 'body' | 'level'>;

export interface Reduction {
  session: Session;
  notice?: NoticeDraft;
}

export const STALE_MS = 10 * 60_000;
export const ENDED_GRACE_MS = 30_000;

function nextState(ev: AgentEvent): { status: Status; reason?: Reason } {
  switch (ev.kind) {
    case 'session-start':
      return { status: 'waiting', reason: 'idle' };
    case 'prompt':
    case 'tool':
      return { status: 'working' };
    case 'approval':
      return { status: 'waiting', reason: 'approval' };
    case 'turn-end':
    case 'idle':
      return { status: 'waiting', reason: 'your-turn' };
    case 'session-end':
      return { status: 'ended' };
  }
}

function noticeFor(prev: Session | undefined, next: Session, ev: AgentEvent): NoticeDraft | undefined {
  const title = `${AGENT_LABELS[next.agent]} · ${next.name ?? next.project}`;
  if (ev.kind === 'approval' && prev?.reason !== 'approval') {
    return { title, body: 'Needs your approval', level: 'urgent' };
  }
  if (ev.kind === 'turn-end' && prev?.status === 'working') {
    return { title, body: 'Finished — your turn', level: 'attention' };
  }
  return undefined;
}

/** Fold one event into a session. Pure: no clock, no I/O. */
export function reduce(prev: Session | undefined, ev: AgentEvent): Reduction {
  const { status, reason } = nextState(ev);
  const cwd = ev.cwd || prev?.cwd || '';
  const changed = !prev || prev.status !== status || prev.reason !== reason;
  const session: Session = {
    id: ev.sessionId,
    agent: ev.agent,
    cwd,
    project: projectName(cwd),
    name: prev?.name,
    status,
    reason,
    startedAt: prev?.startedAt ?? ev.at,
    stateSince: changed ? ev.at : prev.stateSince,
    lastEventAt: ev.at,
    hasTranscript: Boolean(ev.transcriptPath ?? prev?.hasTranscript),
  };
  return { session, notice: noticeFor(prev, session, ev) };
}

/** Time-based housekeeping. Returns the new session, `'remove'`, or `undefined` for no change. */
export function sweep(
  session: Session,
  now: number,
  staleMs: number = STALE_MS,
): Session | 'remove' | undefined {
  if (session.status === 'ended' && now - session.stateSince > ENDED_GRACE_MS) return 'remove';
  // An Esc-interrupt or crash may not fire a hook; don't show "working" forever.
  if (session.status === 'working' && now - session.lastEventAt > staleMs) {
    return { ...session, status: 'waiting', reason: 'stale', stateSince: now };
  }
  return undefined;
}
