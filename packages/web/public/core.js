// Pure decisions for the phone client — no DOM, no storage, no clock — so they can be unit-tested in Node.
// app.js owns rendering and localStorage; everything it has to *decide* lives here.

export const key = (agent, id) => `${agent}:${id}`;

/** How a session is shown: colour class, label, and sort rank (lower = more urgent). */
export function view(s) {
  if (s.status === 'working') return { cls: 'working', label: 'Working', rank: 3 };
  if (s.status === 'ended') return { cls: 'ended', label: 'Ended', rank: 4 };
  if (s.reason === 'approval') return { cls: 'approval', label: 'Needs approval', rank: 0 };
  if (s.reason === 'your-turn') return { cls: 'turn', label: 'Your turn', rank: 1 };
  if (s.reason === 'stale') return { cls: 'idle', label: 'Idle (no activity)', rank: 2 };
  return { cls: 'idle', label: 'Idle', rank: 2 };
}

/** "12s", "3m 5s", "2h 10m". Never negative (clock skew). */
export function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

// ---- preferences ----
export const DEFAULT_PREFS = {
  theme: 'system',
  alerts: true,
  sound: true,
  vibrate: true,
  flash: true,
  keepAwake: true, // a phone used as a second monitor should not go to sleep
  levels: { urgent: true, attention: true, info: true },
};

/** Saved prefs (possibly old, partial or garbage) → a complete prefs object. New fields get their defaults. */
export function mergePrefs(saved) {
  const o = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  const levels = o.levels && typeof o.levels === 'object' && !Array.isArray(o.levels) ? o.levels : {};
  return { ...DEFAULT_PREFS, ...o, levels: { ...DEFAULT_PREFS.levels, ...levels } };
}

// ---- unread ----
/** Stored JSON → array of "agent:id" keys; anything malformed → []. */
export function parseUnread(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Drop unread entries whose session is gone or no longer waiting (the agent moved on — say you approved it on the Mac).
 * Mutates `unread`; returns whether anything changed. `sessions` is a Map keyed by `key()`.
 */
export function pruneUnread(unread, sessions) {
  let changed = false;
  for (const k of unread) {
    if (sessions.get(k)?.status !== 'waiting') changed = unread.delete(k) || changed;
  }
  return changed;
}

/** The session a notice is about. Older hosts send no `agent`; ids are UUIDs, so the id alone finds it. */
export function findSession(sessions, notice) {
  if (!notice.sessionId) return undefined;
  if (notice.agent) return sessions.get(key(notice.agent, notice.sessionId));
  return [...sessions.values()].find((s) => s.id === notice.sessionId);
}

/** A delivered alert marks its session unread — unless you're already looking at it, or it has moved on. */
export function shouldMarkUnread(session, current) {
  if (!session || session.status !== 'waiting') return false;
  return !(current && current.agent === session.agent && current.id === session.id);
}

// ---- lists ----
export const LIST_SORTS = [
  { id: 'status', label: 'Status' },
  { id: 'name', label: 'Name' },
  { id: 'created', label: 'Created' },
  { id: 'active', label: 'Recently active' },
];

export const LIST_AGENTS = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
];

/** Filter values match `view().cls`. Idle includes "Idle (no activity)". */
export const LIST_STATUSES = [
  { id: 'approval', label: 'Needs approval' },
  { id: 'turn', label: 'Your turn' },
  { id: 'working', label: 'Working' },
  { id: 'idle', label: 'Idle' },
  { id: 'ended', label: 'Ended' },
];

export const DEFAULT_LIST = { by: 'status', reverse: false, agent: '', status: '', archived: false };

/** Active chats, or only the ones this phone has archived. */
export const LIST_ARCHIVES = [
  { id: '', label: 'Active' },
  { id: 'archived', label: 'Archived' },
];

const SORT_DIR = {
  status: ['Urgent first', 'Least urgent'],
  name: ['A–Z', 'Z–A'],
  created: ['Newest', 'Oldest'],
  active: ['Latest', 'Earliest'],
};

/** Saved list controls (or garbage) → a complete query. Unknown ids become the defaults. */
export function listQuery(saved) {
  const o = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  return {
    by: LIST_SORTS.some((s) => s.id === o.by) ? o.by : DEFAULT_LIST.by,
    reverse: o.reverse === true,
    agent: LIST_AGENTS.some((a) => a.id === o.agent) ? o.agent : '',
    status: LIST_STATUSES.some((s) => s.id === o.status) ? o.status : '',
    archived: o.archived === true,
  };
}

export function sortDirLabel(by, reverse) {
  const pair = SORT_DIR[by] ?? SORT_DIR.status;
  return reverse ? pair[1] : pair[0];
}

const LIST_PARAMS = ['sort', 'rev', 'agent', 'status', 'archived'];

/** Query string for a list view. Defaults are omitted, so an untouched list stays a clean URL. */
export function listSearch(query) {
  const q = listQuery(query);
  const p = new URLSearchParams();
  if (q.by !== DEFAULT_LIST.by) p.set('sort', q.by);
  if (q.reverse) p.set('rev', '1');
  if (q.agent) p.set('agent', q.agent);
  if (q.status) p.set('status', q.status);
  if (q.archived) p.set('archived', '1');
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * `location.search` → list query, or null when the URL says nothing about the list
 * (so a saved choice on the phone can still apply). Unknown values are dropped.
 */
export function listFromSearch(search) {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (!LIST_PARAMS.some((k) => p.has(k))) return null;
  return listQuery({
    by: p.get('sort') || DEFAULT_LIST.by,
    reverse: p.get('rev') === '1',
    agent: p.get('agent') || '',
    status: p.get('status') || '',
    archived: p.get('archived') === '1',
  });
}

/**
 * Agent and status narrow the list. Archived chats stay out unless `archived` is set, then only those remain.
 * `archivedKeys` is a Set of `agent:id`.
 */
export function filterSessions(list, { agent = '', status = '', archived = false, archivedKeys } = {}) {
  const hidden = archivedKeys instanceof Set ? archivedKeys : new Set();
  return [...list].filter((s) => {
    if (agent && s.agent !== agent) return false;
    if (status && view(s).cls !== status) return false;
    const isArchived = hidden.has(key(s.agent, s.id));
    return archived ? isArchived : !isArchived;
  });
}

/** Drop archive marks whose session is gone. Mutates `archived`; returns whether anything changed. */
export function pruneArchived(archived, sessions) {
  let changed = false;
  for (const k of archived) {
    if (!sessions.has(k)) changed = archived.delete(k) || changed;
  }
  return changed;
}

/**
 * `by`: status (urgent first, then longest in that state), name, created (newest first), active (latest event first).
 * `reverse` flips that order. Default matches the original status sort. Does not mutate `list`.
 */
export function sortSessions(list, by = 'status', reverse = false) {
  const nameOf = (s) => s.name || s.project || '';
  const cmp = (a, b) => {
    if (by === 'name') return nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' });
    if (by === 'created') return b.startedAt - a.startedAt;
    if (by === 'active') return b.lastEventAt - a.lastEventAt;
    return view(a).rank - view(b).rank || a.stateSince - b.stateSince;
  };
  return [...list].sort((a, b) => {
    const n = cmp(a, b);
    return reverse ? -n : n;
  });
}

export function splitUnread(list, unread) {
  const fresh = [];
  const rest = [];
  for (const s of list) (unread.has(key(s.agent, s.id)) ? fresh : rest).push(s);
  return { fresh, rest };
}

/** Header summary + tab title. "Need you" = waiting on approval or your turn (not idle/stale). */
export function summarize(list, unreadCount) {
  const needs = list.filter((s) => s.status === 'waiting' && s.reason !== 'stale' && s.reason !== 'idle').length;
  const working = list.filter((s) => s.status === 'working').length;
  return {
    needs,
    working,
    text: [needs && `${needs} need you`, working && `${working} working`].filter(Boolean).join(' · '),
    title: unreadCount ? `(${unreadCount}) agent-monitor` : 'agent-monitor',
  };
}

// ---- alerts ----
/**
 * What to do for a notice, given the user's settings; `null` = muted, do nothing (and don't mark anything unread).
 * A session's alert is shown by its highlighted card, so only card-less notices (custom ones) and the settings-menu
 * test (`force`) get a toast. `force` also bypasses the per-level switch, but never the master Alerts switch.
 */
export function alertPlan(prefs, notice, force = false) {
  if (!prefs.alerts) return null;
  if (!force && prefs.levels[notice.level] === false) return null;
  const urgent = notice.level === 'urgent';
  const attention = notice.level === 'attention';
  return {
    flash: prefs.flash ? (urgent ? 'var(--approval)' : attention ? 'var(--turn)' : 'var(--muted)') : null,
    toast: !notice.sessionId || force,
    beep: prefs.sound ? { times: urgent ? 3 : attention ? 2 : 1, freq: urgent ? 880 : attention ? 660 : 520 } : null,
    vibrate: prefs.vibrate ? (urgent ? [200, 100, 200, 100, 200] : attention ? [150, 80, 150] : [80]) : null,
  };
}

// ---- keep the screen on ----
/**
 * The line under the "Keep screen on" switch. `mode` is how we are holding the screen: 'wakelock' (Screen Wake Lock
 * API — secure pages only), 'video' (a muted looping video, which mobile browsers treat as playback and don't sleep
 * through — works over plain http), 'failed' (neither worked), or 'none'. `playing` says whether the video runs yet
 * (browsers may need one tap first).
 */
export function keepAwakeStatus({ on, mode, playing }) {
  if (!on) return 'The phone may go to sleep.';
  if (mode === 'wakelock') return 'The screen stays on.';
  if (mode === 'video') {
    return playing
      ? 'The screen stays on (over plain http the browser has no Wake Lock, so a tiny hidden video is used).'
      : 'Tap anywhere once to start keeping the screen on.';
  }
  if (mode === 'failed') return "This browser can't keep the screen on. Turn on Android's Developer options → Stay awake while charging.";
  return 'Starting…';
}
