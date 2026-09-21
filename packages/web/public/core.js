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
export function sortSessions(list) {
  return [...list].sort((a, b) => view(a).rank - view(b).rank || a.stateSince - b.stateSince);
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
