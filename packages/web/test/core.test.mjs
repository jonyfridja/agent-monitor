import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PREFS,
  ago,
  alertPlan,
  findSession,
  keepAwakeStatus,
  key,
  mergePrefs,
  parseUnread,
  pruneArchived,
  pruneUnread,
  shouldMarkUnread,
  filterSessions,
  listFromSearch,
  listQuery,
  listSearch,
  sortDirLabel,
  sortSessions,
  splitUnread,
  summarize,
  view,
} from '../public/core.js';

const session = (over = {}) => ({ id: 's1', agent: 'claude', status: 'waiting', reason: 'your-turn', stateSince: 100, project: 'p', ...over });
const map = (...list) => new Map(list.map((s) => [key(s.agent, s.id), s]));

test('view: every state has a label and a rank; approval is the most urgent, ended the least', () => {
  const ranks = {
    approval: view(session({ reason: 'approval' })),
    turn: view(session()),
    idle: view(session({ reason: 'idle' })),
    stale: view(session({ reason: 'stale' })),
    working: view(session({ status: 'working', reason: undefined })),
    ended: view(session({ status: 'ended' })),
  };
  assert.deepEqual(Object.values(ranks).map((v) => v.rank), [0, 1, 2, 2, 3, 4]);
  assert.equal(ranks.approval.label, 'Needs approval');
  assert.equal(ranks.stale.label, 'Idle (no activity)');
  assert.equal(ranks.working.cls, 'working');
});

test('ago: seconds, minutes, hours; never negative under clock skew', () => {
  assert.equal(ago(0), '0s');
  assert.equal(ago(59_999), '59s');
  assert.equal(ago(65_000), '1m 5s');
  assert.equal(ago(3_600_000 + 10 * 60_000), '1h 10m');
  assert.equal(ago(-5000), '0s');
});

test('mergePrefs: fills defaults for old/partial/garbage saved values and keeps what the user chose', () => {
  assert.deepEqual(mergePrefs(null), DEFAULT_PREFS);
  assert.deepEqual(mergePrefs('garbage'), DEFAULT_PREFS);
  assert.deepEqual(mergePrefs([1, 2]), DEFAULT_PREFS);
  const merged = mergePrefs({ theme: 'dark', levels: { attention: false } }); // saved before "sound"/"info" existed
  assert.equal(merged.theme, 'dark');
  assert.equal(merged.sound, true);
  assert.deepEqual(merged.levels, { urgent: true, attention: false, info: true });
  assert.notEqual(mergePrefs(null).levels, DEFAULT_PREFS.levels, 'must not hand out the shared defaults object');
});

test('parseUnread: only well-formed string keys survive', () => {
  assert.deepEqual(parseUnread('["claude:a","codex:b"]'), ['claude:a', 'codex:b']);
  assert.deepEqual(parseUnread('["ok", 5, null, {"x":1}]'), ['ok']);
  for (const bad of [null, undefined, '', '{', '{"a":1}', '42']) assert.deepEqual(parseUnread(bad), [], String(bad));
});

test('pruneUnread: keeps sessions that are still waiting; drops ones that resumed, ended or vanished', () => {
  const sessions = map(
    session({ id: 'waiting' }),
    session({ id: 'resumed', status: 'working', reason: undefined }),
    session({ id: 'ended', status: 'ended' }),
  );
  const unread = new Set(['claude:waiting', 'claude:resumed', 'claude:ended', 'claude:gone']);
  assert.equal(pruneUnread(unread, sessions), true);
  assert.deepEqual([...unread], ['claude:waiting']);
  assert.equal(pruneUnread(unread, sessions), false, 'nothing left to prune');
});

test('findSession: by agent+id, or by id alone for older hosts; none for custom notices', () => {
  const sessions = map(session({ id: 'x', agent: 'codex' }), session({ id: 'y' }));
  assert.equal(findSession(sessions, { agent: 'codex', sessionId: 'x' })?.id, 'x');
  assert.equal(findSession(sessions, { agent: 'claude', sessionId: 'x' }), undefined, 'wrong agent is not a match');
  assert.equal(findSession(sessions, { sessionId: 'y' })?.id, 'y', 'old host: no agent field');
  assert.equal(findSession(sessions, { title: 'custom, no session' }), undefined);
});

test('shouldMarkUnread: only a waiting session you are not already looking at', () => {
  assert.equal(shouldMarkUnread(session(), null), true);
  assert.equal(shouldMarkUnread(session(), { agent: 'codex', id: 's1' }), true, 'same id, different agent');
  assert.equal(shouldMarkUnread(session(), { agent: 'claude', id: 's1' }), false, 'viewing it right now');
  assert.equal(shouldMarkUnread(session({ status: 'working' }), null), false, 'already moved on');
  assert.equal(shouldMarkUnread(undefined, null), false);
});

test('sortSessions: most urgent first, then longest-waiting; does not mutate its input', () => {
  const input = [
    session({ id: 'w', status: 'working', reason: undefined, stateSince: 1 }),
    session({ id: 'late-turn', stateSince: 300 }),
    session({ id: 'approval', reason: 'approval', stateSince: 500 }),
    session({ id: 'early-turn', stateSince: 100 }),
  ];
  const snapshot = input.map((s) => s.id);
  assert.deepEqual(sortSessions(input).map((s) => s.id), ['approval', 'early-turn', 'late-turn', 'w']);
  assert.deepEqual(input.map((s) => s.id), snapshot);
});

test('listQuery: keeps known choices and drops garbage', () => {
  const base = { by: 'status', reverse: false, agent: '', status: '', archived: false };
  assert.deepEqual(listQuery(null), base);
  assert.deepEqual(listQuery({ by: 'nope', agent: 'vim', status: 'asleep', reverse: 'yes', archived: 'yes' }), base);
  assert.deepEqual(listQuery({ by: 'active', reverse: true, agent: 'cursor', status: 'idle', archived: true }), { by: 'active', reverse: true, agent: 'cursor', status: 'idle', archived: true });
});

test('list URL: defaults stay clean, choices round-trip, a pairing token is not a filter', () => {
  const chosen = { by: 'name', reverse: true, agent: 'cursor', status: 'idle', archived: true };
  assert.equal(listSearch(listQuery(null)), '');
  assert.equal(listSearch(chosen), '?sort=name&rev=1&agent=cursor&status=idle&archived=1');
  assert.deepEqual(listFromSearch(listSearch(chosen)), chosen);
  assert.equal(listFromSearch(''), null);
  assert.equal(listFromSearch('?t=pair-token'), null);
  assert.deepEqual(listFromSearch('?sort=nope&agent=vim&status=asleep&rev=0'), { by: 'status', reverse: false, agent: '', status: '', archived: false });
});

test('sort and filter: name, created, recently active, agent, and status', () => {
  const rows = [
    session({ id: 'b', agent: 'cursor', name: 'Bravo', project: 'z', startedAt: 20, lastEventAt: 50, stateSince: 50, reason: 'idle' }),
    session({ id: 'a', agent: 'claude', name: 'alpha', project: 'a', startedAt: 30, lastEventAt: 10, stateSince: 10 }),
    session({ id: 'c', agent: 'codex', project: 'Charlie', startedAt: 10, lastEventAt: 40, stateSince: 40, status: 'working', reason: undefined }),
    session({ id: 'd', agent: 'claude', project: 'delta', startedAt: 5, lastEventAt: 5, stateSince: 5, reason: 'stale' }),
  ];
  assert.deepEqual(sortSessions(rows, 'name').map((s) => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortSessions(rows, 'name', true).map((s) => s.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(sortSessions(rows, 'created').map((s) => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(sortSessions(rows, 'created', true).map((s) => s.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(sortSessions(rows, 'active').map((s) => s.id), ['b', 'c', 'a', 'd']);
  assert.equal(sortDirLabel('status', false), 'Urgent first');
  assert.equal(sortDirLabel('active', true), 'Earliest');
  assert.deepEqual(filterSessions(rows, { agent: 'claude' }).map((s) => s.id), ['a', 'd']);
  assert.deepEqual(filterSessions(rows, { status: 'idle' }).map((s) => s.id), ['b', 'd']);
  assert.deepEqual(filterSessions(rows, { agent: 'cursor', status: 'working' }).map((s) => s.id), []);
  const archivedKeys = new Set(['cursor:b', 'claude:gone']);
  assert.deepEqual(filterSessions(rows, { archivedKeys }).map((s) => s.id), ['a', 'c', 'd']);
  assert.deepEqual(filterSessions(rows, { archived: true, archivedKeys }).map((s) => s.id), ['b']);
  assert.deepEqual(filterSessions(rows, { archived: true, agent: 'claude', archivedKeys }).map((s) => s.id), []);
  const kept = new Set(['cursor:b', 'claude:gone']);
  assert.equal(pruneArchived(kept, map(session({ id: 'b', agent: 'cursor' }))), true);
  assert.deepEqual([...kept], ['cursor:b']);
  assert.deepEqual(sortSessions(rows).map((s) => s.id), sortSessions(rows, 'status', false).map((s) => s.id));
});

test('splitUnread: partitions by key, preserving order', () => {
  const list = [session({ id: 'a' }), session({ id: 'b', agent: 'codex' }), session({ id: 'c' })];
  const { fresh, rest } = splitUnread(list, new Set(['codex:b', 'claude:c']));
  assert.deepEqual(fresh.map((s) => s.id), ['b', 'c']);
  assert.deepEqual(rest.map((s) => s.id), ['a']);
});

test('summarize: counts sessions that need you (not idle/stale) and working ones; unread drives the tab title', () => {
  const list = [
    session({ id: '1', reason: 'approval' }),
    session({ id: '2' }),
    session({ id: '3', reason: 'idle' }),
    session({ id: '4', reason: 'stale' }),
    session({ id: '5', status: 'working', reason: undefined }),
  ];
  const s = summarize(list, 2);
  assert.equal(s.needs, 2);
  assert.equal(s.working, 1);
  assert.equal(s.text, '2 need you · 1 working');
  assert.equal(s.title, '(2) agent-monitor');
  assert.equal(summarize([], 0).text, '');
  assert.equal(summarize([], 0).title, 'agent-monitor');
});

test('alertPlan: master switch and per-level switch mute; force bypasses only the level', () => {
  const urgent = { level: 'urgent', sessionId: 's1' };
  assert.equal(alertPlan({ ...DEFAULT_PREFS, alerts: false }, urgent), null);
  assert.equal(alertPlan({ ...DEFAULT_PREFS, alerts: false }, urgent, true), null, 'force never beats the master switch');
  const noApproval = mergePrefs({ levels: { urgent: false } });
  assert.equal(alertPlan(noApproval, urgent), null);
  assert.notEqual(alertPlan(noApproval, urgent, true), null, 'the test button ignores the level switch');
  assert.notEqual(alertPlan(DEFAULT_PREFS, urgent), null);
});

test('alertPlan: louder for approval than for your turn than for custom; each channel obeys its own switch', () => {
  const p = (level, prefs = DEFAULT_PREFS) => alertPlan(prefs, { level, sessionId: 's' });
  assert.deepEqual([p('urgent').beep.times, p('attention').beep.times, p('info').beep.times], [3, 2, 1]);
  assert.ok(p('urgent').vibrate.length > p('attention').vibrate.length);
  assert.equal(p('urgent').flash, 'var(--approval)');
  assert.equal(p('attention').flash, 'var(--turn)');
  const silent = mergePrefs({ sound: false, vibrate: false, flash: false });
  assert.deepEqual(p('urgent', silent), { flash: null, toast: false, beep: null, vibrate: null });
});

test('alertPlan: a session alert gets no toast (its card is the notification); custom notices and the test do', () => {
  assert.equal(alertPlan(DEFAULT_PREFS, { level: 'attention', sessionId: 's1' }).toast, false);
  assert.equal(alertPlan(DEFAULT_PREFS, { level: 'info', title: 'Deploy done' }).toast, true);
  assert.equal(alertPlan(DEFAULT_PREFS, { level: 'attention', sessionId: 's1' }, true).toast, true);
});

test('keepAwake is on by default and survives merging with old saved prefs', () => {
  assert.equal(DEFAULT_PREFS.keepAwake, true);
  assert.equal(mergePrefs({ theme: 'dark' }).keepAwake, true, 'prefs saved before the option existed');
  assert.equal(mergePrefs({ keepAwake: false }).keepAwake, false, 'an explicit choice is kept');
});

test('keepAwakeStatus: tells the user what is happening, including when a tap is still needed or nothing works', () => {
  assert.match(keepAwakeStatus({ on: false, mode: 'none', playing: false }), /may go to sleep/);
  assert.match(keepAwakeStatus({ on: true, mode: 'wakelock', playing: false }), /stays on/);
  assert.match(keepAwakeStatus({ on: true, mode: 'video', playing: true }), /plain http/);
  assert.match(keepAwakeStatus({ on: true, mode: 'video', playing: false }), /Tap anywhere/);
  assert.match(keepAwakeStatus({ on: true, mode: 'failed', playing: false }), /Stay awake while charging/);
  assert.match(keepAwakeStatus({ on: true, mode: 'none', playing: false }), /Starting/);
});
