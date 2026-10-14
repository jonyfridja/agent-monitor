import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentId, Notice, Session, StreamMessage } from '@agent-monitor/protocol';
import { reduce, sweep, type NoticeDraft } from './reduce.ts';

export type Listener = (msg: StreamMessage) => void;

/** In-memory session state; every mutation is broadcast as a StreamMessage. */
export class SessionStore {
  #sessions = new Map<string, Session>();
  /** agent:id → transcript file. Kept out of Session so it is never broadcast to phones. */
  #transcripts = new Map<string, string>();
  #listeners = new Set<Listener>();
  #staleMs?: number;

  constructor(opts: { staleMs?: number } = {}) {
    this.#staleMs = opts.staleMs;
  }

  subscribe(fn: Listener): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(msg: StreamMessage): void {
    for (const fn of this.#listeners) fn(msg);
  }

  snapshot(): Session[] {
    return [...this.#sessions.values()];
  }

  apply(ev: AgentEvent): Session {
    const key = `${ev.agent}:${ev.sessionId}`;
    const { session, notice } = reduce(this.#sessions.get(key), ev);
    this.#sessions.set(key, session);
    if (ev.transcriptPath) this.#transcripts.set(key, ev.transcriptPath);
    this.#emit({ type: 'session', now: Date.now(), session });
    if (notice) this.notify(notice, { agent: session.agent, id: session.id });
    return session;
  }

  /** Attach (or clear) the harness's name for a session; broadcasts only when it actually changed. */
  setName(agent: AgentId, id: string, name: string | undefined): void {
    const key = `${agent}:${id}`;
    const session = this.#sessions.get(key);
    if (!session || session.name === name) return;
    const next = { ...session, name };
    this.#sessions.set(key, next);
    this.#emit({ type: 'session', now: Date.now(), session: next });
  }

  transcriptPath(agent: AgentId, id: string): string | undefined {
    return this.#transcripts.get(`${agent}:${id}`);
  }

  /** Remember a transcript file without changing status. Used when a hook omitted the path. */
  setTranscript(agent: AgentId, id: string, path: string): void {
    const key = `${agent}:${id}`;
    const session = this.#sessions.get(key);
    if (!session || this.#transcripts.get(key) === path) return;
    this.#transcripts.set(key, path);
    if (session.hasTranscript) return;
    const next = { ...session, hasTranscript: true };
    this.#sessions.set(key, next);
    this.#emit({ type: 'session', now: Date.now(), session: next });
  }

  notify(draft: NoticeDraft, session?: { agent: AgentId; id: string }): Notice {
    const notice: Notice = { id: randomUUID(), at: Date.now(), agent: session?.agent, sessionId: session?.id, ...draft };
    this.#emit({ type: 'notice', now: notice.at, notice });
    return notice;
  }

  tick(now: number = Date.now()): void {
    for (const [key, session] of this.#sessions) {
      const result = sweep(session, now, this.#staleMs);
      if (result === 'remove') {
        this.#sessions.delete(key);
        this.#transcripts.delete(key);
        this.#emit({ type: 'remove', now, agent: session.agent, id: session.id });
      } else if (result) {
        this.#sessions.set(key, result);
        this.#emit({ type: 'session', now, session: result });
      }
    }
  }

  /** Drop every session for an agent (used when the user disables it in the host app). */
  clearAgent(agent: AgentId): void {
    for (const [key, session] of this.#sessions) {
      if (session.agent !== agent) continue;
      this.#sessions.delete(key);
      this.#transcripts.delete(key);
      this.#emit({ type: 'remove', now: Date.now(), agent: session.agent, id: session.id });
    }
  }
}
