import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentEvent, AgentEventKind } from '@agent-monitor/protocol';
import { ENDED_GRACE_MS, reduce, STALE_MS, sweep } from './reduce.ts';

const ev = (kind: AgentEventKind, at: number, extra: Partial<AgentEvent> = {}): AgentEvent => ({
  agent: 'claude',
  sessionId: 's1',
  cwd: '/Users/me/code/proj',
  kind,
  at,
  ...extra,
});

test('session-start creates a waiting/idle session with the project name', () => {
  const { session, notice } = reduce(undefined, ev('session-start', 100));
  assert.equal(session.status, 'waiting');
  assert.equal(session.reason, 'idle');
  assert.equal(session.project, 'proj');
  assert.equal(session.startedAt, 100);
  assert.equal(notice, undefined);
});

test('prompt and tool events mean working; stateSince only moves on a real change', () => {
  const a = reduce(undefined, ev('prompt', 100)).session;
  const b = reduce(a, ev('tool', 200)).session;
  assert.equal(b.status, 'working');
  assert.equal(b.stateSince, 100);
  assert.equal(b.lastEventAt, 200);
});

test('turn-end after working → waiting/your-turn with an attention notice', () => {
  const working = reduce(undefined, ev('prompt', 100)).session;
  const { session, notice } = reduce(working, ev('turn-end', 300));
  assert.equal(session.status, 'waiting');
  assert.equal(session.reason, 'your-turn');
  assert.equal(session.stateSince, 300);
  assert.equal(notice?.level, 'attention');
  assert.match(notice!.title, /Claude Code · proj/);
});

test('turn-end when already waiting does not re-notify', () => {
  const waiting = reduce(undefined, ev('turn-end', 100)).session;
  assert.equal(reduce(waiting, ev('turn-end', 200)).notice, undefined);
});

test('approval is urgent once; approving (tool) flips back to working', () => {
  const working = reduce(undefined, ev('tool', 100)).session;
  const asked = reduce(working, ev('approval', 200));
  assert.equal(asked.session.reason, 'approval');
  assert.equal(asked.notice?.level, 'urgent');
  assert.equal(reduce(asked.session, ev('approval', 210)).notice, undefined);
  assert.equal(reduce(asked.session, ev('tool', 300)).session.status, 'working');
});

test('session-end marks ended and keeps the last known cwd', () => {
  const s = reduce(undefined, ev('prompt', 100)).session;
  const ended = reduce(s, ev('session-end', 200, { cwd: undefined })).session;
  assert.equal(ended.status, 'ended');
  assert.equal(ended.project, 'proj');
});

test('events for a different agent id do not collide', () => {
  const codex = reduce(undefined, ev('prompt', 100, { agent: 'codex' })).session;
  assert.equal(codex.agent, 'codex');
});

test('sweep: stale working session becomes waiting/stale', () => {
  const s = reduce(undefined, ev('prompt', 0)).session;
  assert.equal(sweep(s, STALE_MS - 1), undefined);
  const stale = sweep(s, STALE_MS + 1);
  assert.ok(stale && stale !== 'remove');
  assert.equal(stale.reason, 'stale');
});

test('sweep: ended sessions are removed after the grace period', () => {
  const s = reduce(undefined, ev('session-end', 0)).session;
  assert.equal(sweep(s, ENDED_GRACE_MS - 1), undefined);
  assert.equal(sweep(s, ENDED_GRACE_MS + 1), 'remove');
});

test('sweep leaves waiting sessions alone however old', () => {
  const s = reduce(undefined, ev('turn-end', 0)).session;
  assert.equal(sweep(s, 10 * STALE_MS), undefined);
});

test('the harness name is kept across events and used in notices instead of the folder name', () => {
  const start = reduce(undefined, ev('prompt', 100)).session;
  const named = { ...start, name: 'Agent-monitor MVP' };
  const { session, notice } = reduce(named, ev('turn-end', 200));
  assert.equal(session.name, 'Agent-monitor MVP');
  assert.equal(notice?.title, 'Claude Code · Agent-monitor MVP');
  // No name known: the folder name is the fallback.
  assert.match(reduce(start, ev('turn-end', 200)).notice!.title, /· proj$/);
});
