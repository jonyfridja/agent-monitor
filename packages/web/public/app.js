// Phone client: renders sessions from the host's SSE stream and raises in-page alerts.
const $ = (id) => document.getElementById(id);

// Pairing token comes from the QR/URL once, then lives in localStorage.
const params = new URLSearchParams(location.search);
let token = params.get('t') || '';
try {
  if (token) localStorage.setItem('am.token', token);
  else token = localStorage.getItem('am.token') || '';
} catch {}

// ---- preferences (theme + alerts), kept on this phone in localStorage ----
const DEFAULT_PREFS = { theme: 'system', alerts: true, sound: true, vibrate: true, flash: true, levels: { urgent: true, attention: true, info: true } };
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('am.prefs') || 'null') || {};
    return { ...DEFAULT_PREFS, ...saved, levels: { ...DEFAULT_PREFS.levels, ...(saved.levels || {}) } };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_PREFS));
  }
}
function savePrefs() {
  try {
    localStorage.setItem('am.prefs', JSON.stringify(prefs));
  } catch {}
}
const prefs = loadPrefs();

const scheme = window.matchMedia?.('(prefers-color-scheme: light)');
function applyTheme() {
  const effective = prefs.theme === 'system' ? (scheme?.matches ? 'light' : 'dark') : prefs.theme;
  document.documentElement.dataset.theme = effective;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg);
}
const onSchemeChange = () => prefs.theme === 'system' && applyTheme();
if (scheme) scheme.addEventListener ? scheme.addEventListener('change', onSchemeChange) : scheme.addListener?.(onSchemeChange);
applyTheme();

const AGENT = { claude: 'Claude Code', codex: 'Codex' };
const sessions = new Map(); // "agent:id" -> Session
let skew = 0; // serverNow - localNow
const key = (agent, id) => `${agent}:${id}`;
const serverNow = () => Date.now() + skew;

// ---- unread: sessions that raised an alert you haven't looked at yet (kept on this phone) ----
// A session is unread from the moment it alerts until you open/tap it, or until the agent moves on (no longer waiting).
const unread = new Set(loadUnread());
let haveSnapshot = false; // don't prune stored unread state before we know which sessions exist
function loadUnread() {
  try {
    const saved = JSON.parse(localStorage.getItem('am.unread') || '[]');
    return Array.isArray(saved) ? saved.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}
function saveUnread() {
  try {
    localStorage.setItem('am.unread', JSON.stringify([...unread]));
  } catch {}
}
function markRead(k) {
  if (unread.delete(k)) {
    saveUnread();
    render();
  }
}
function pruneUnread() {
  if (!haveSnapshot) return;
  let changed = false;
  for (const k of unread) {
    if (sessions.get(k)?.status !== 'waiting') changed = unread.delete(k) || changed;
  }
  if (changed) saveUnread();
}

// ---- rendering ----
function view(s) {
  if (s.status === 'working') return { cls: 'working', label: 'Working', rank: 3 };
  if (s.status === 'ended') return { cls: 'ended', label: 'Ended', rank: 4 };
  if (s.reason === 'approval') return { cls: 'approval', label: 'Needs approval', rank: 0 };
  if (s.reason === 'your-turn') return { cls: 'turn', label: 'Your turn', rank: 1 };
  if (s.reason === 'stale') return { cls: 'idle', label: 'Idle (no activity)', rank: 2 };
  return { cls: 'idle', label: 'Idle', rank: 2 };
}

function ago(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function card(s) {
  const k = key(s.agent, s.id);
  const v = view(s);
  const isUnread = unread.has(k);
  const el = document.createElement('div');
  el.className = `card ${v.cls}${isUnread ? ' unread' : ''}${s.hasTranscript ? ' clickable' : ''}`;
  el.innerHTML = `
    <div class="row"><span class="agent"></span><span class="meta">${isUnread ? '<span class="new">New</span>' : ''}<span class="time" data-since="${s.stateSince}"></span></span></div>
    <div class="project"></div>
    <div class="pill"></div>`;
  // Title = the harness's own name for the session; the folder moves to the small label when we have one.
  el.querySelector('.agent').textContent = (AGENT[s.agent] ?? s.agent) + (s.name ? ` · ${s.project}` : '');
  el.querySelector('.project').textContent = s.name || s.project;
  el.querySelector('.pill').textContent = v.label;
  if (s.hasTranscript || isUnread) {
    el.addEventListener('click', () => {
      markRead(k);
      if (s.hasTranscript) {
        cameFromList = true;
        location.hash = `#/${s.agent}/${encodeURIComponent(s.id)}`;
      }
    });
  }
  return el;
}

function section(title, count, cls, action) {
  const h = document.createElement('div');
  h.className = `sec ${cls}`;
  const label = document.createElement('span');
  label.textContent = title;
  const n = document.createElement('b');
  n.textContent = count;
  label.append(' ', n);
  h.append(label);
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.addEventListener('click', action.run);
    h.append(btn);
  }
  return h;
}

function render() {
  pruneUnread();
  const list = [...sessions.values()].sort((a, b) => view(a).rank - view(b).rank || a.stateSince - b.stateSince);
  const fresh = list.filter((s) => unread.has(key(s.agent, s.id)));
  const rest = list.filter((s) => !unread.has(key(s.agent, s.id)));
  const wrap = (items) => {
    const g = document.createElement('div');
    g.className = 'grid';
    g.append(...items.map(card));
    return g;
  };
  const nodes = [];
  if (fresh.length) {
    nodes.push(
      section('Unread', fresh.length, 'unread', {
        label: 'Mark all read',
        run: () => {
          for (const s of fresh) unread.delete(key(s.agent, s.id));
          saveUnread();
          render();
        },
      }),
      wrap(fresh),
    );
    if (rest.length) nodes.push(section('Other sessions', rest.length, 'other'), wrap(rest));
  } else if (rest.length) {
    nodes.push(wrap(rest)); // nothing unread: a plain list, no headings
  }
  $('list').replaceChildren(...nodes);
  $('empty').hidden = list.length > 0;
  const needs = list.filter((s) => s.status === 'waiting' && s.reason !== 'stale' && s.reason !== 'idle').length;
  const working = list.filter((s) => s.status === 'working').length;
  $('summary').textContent = [needs && `${needs} need you`, working && `${working} working`].filter(Boolean).join(' · ');
  document.title = fresh.length ? `(${fresh.length}) agent-monitor` : 'agent-monitor';
  if (current) renderDetailHead();
  tick();
}

function tick() {
  for (const el of document.querySelectorAll('[data-since]')) {
    el.textContent = ago(serverNow() - Number(el.dataset.since));
  }
  if (current) renderDetailHead();
}
setInterval(tick, 1000);

// ---- alerts (work over plain http; need one tap per page load to unlock audio) ----
let audio = null;
function unlock() {
  if (audio) return;
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.();
  } catch {}
  syncMenu();
}
document.addEventListener('pointerdown', unlock); // any tap satisfies the browser's user-gesture rule

function beep(times, freq) {
  if (!audio) return;
  for (let i = 0; i < times; i++) {
    const t = audio.currentTime + i * 0.25;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}

/** Raise flash / sound / vibration for a notice. Returns false when the user's settings muted it. */
function alertUser(n, force = false) {
  if (!prefs.alerts) return false;
  if (!force && prefs.levels[n.level] === false) return false;

  if (prefs.flash) {
    const flash = $('flash');
    flash.style.background = n.level === 'urgent' ? 'var(--approval)' : n.level === 'attention' ? 'var(--turn)' : 'var(--muted)';
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
  }

  // A session's alert is shown by its highlighted card. Only notices with no card (custom ones, the test) need a toast.
  if (!n.sessionId || force) {
    const toast = document.createElement('div');
    toast.className = `toast ${n.level}`;
    toast.innerHTML = '<b></b><span></span>';
    toast.querySelector('b').textContent = n.title;
    toast.querySelector('span').textContent = n.body;
    $('toasts').append(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  const urgent = n.level === 'urgent';
  const attention = n.level === 'attention';
  if (prefs.sound) beep(urgent ? 3 : attention ? 2 : 1, urgent ? 880 : attention ? 660 : 520);
  if (prefs.vibrate) navigator.vibrate?.(urgent ? [200, 100, 200, 100, 200] : attention ? [150, 80, 150] : [80]);
  return true;
}

function handleNotice(n) {
  const alerted = alertUser(n);
  if (!alerted || !n.sessionId) return;
  // Older hosts don't say which agent raised it; session ids are UUIDs, so the id alone finds the card.
  const s = n.agent ? sessions.get(key(n.agent, n.sessionId)) : [...sessions.values()].find((x) => x.id === n.sessionId);
  if (!s) return;
  const k = key(s.agent, s.id);
  const viewing = current && current.agent === s.agent && current.id === s.id;
  if (viewing || s.status !== 'waiting') return; // already looking at it / it already moved on
  unread.add(k);
  saveUnread();
}

// ---- settings menu (behind the gear icon) ----
function syncMenu() {
  for (const r of document.querySelectorAll('input[name=theme]')) r.checked = r.value === prefs.theme;
  for (const el of document.querySelectorAll('[data-pref]')) el.checked = !!prefs[el.dataset.pref];
  for (const el of document.querySelectorAll('[data-level]')) el.checked = !!prefs.levels[el.dataset.level];
  $('alert-opts').disabled = !prefs.alerts;
  $('audio-status').textContent = !prefs.sound
    ? 'Sound is off.'
    : audio
      ? 'Sound is ready.'
      : 'Tap anywhere once to allow sound (browsers require it after each page load).';
}

function setMenu(open) {
  $('menu').hidden = !open;
  $('scrim').hidden = !open;
  $('gear').setAttribute('aria-expanded', String(open));
  if (open) syncMenu();
}
$('gear').addEventListener('click', () => setMenu($('menu').hidden));
$('scrim').addEventListener('click', () => setMenu(false));
addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));

$('menu').addEventListener('change', (e) => {
  const el = e.target;
  if (el.name === 'theme') prefs.theme = el.value;
  else if (el.dataset.pref) prefs[el.dataset.pref] = el.checked;
  else if (el.dataset.level) prefs.levels[el.dataset.level] = el.checked;
  savePrefs();
  applyTheme();
  syncMenu();
});

$('test-alert').addEventListener('click', () => {
  unlock();
  alertUser({ title: 'Test alert', body: 'This is how alerts look on this phone.', level: 'attention' }, true);
});

// ---- connection ----
const conn = $('conn');
function connect() {
  const es = new EventSource(`/api/stream${token ? `?t=${encodeURIComponent(token)}` : ''}`);
  es.onopen = () => conn.classList.add('on');
  es.onerror = () => conn.classList.remove('on'); // EventSource reconnects on its own
  es.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    skew = msg.now - Date.now();
    if (msg.type === 'snapshot') {
      sessions.clear();
      for (const s of msg.sessions) sessions.set(key(s.agent, s.id), s);
      haveSnapshot = true;
    } else if (msg.type === 'session') sessions.set(key(msg.session.agent, msg.session.id), msg.session);
    else if (msg.type === 'remove') sessions.delete(key(msg.agent, msg.id));
    else if (msg.type === 'notice') handleNotice(msg.notice);
    render();
  };
}
connect();

// ---- session detail: live, terminal-style transcript ----
let current = null; // { agent, id } while a session is open
let cameFromList = false;
let pollTimer = null;
let lastSig = '';
const expanded = new Set(); // tool results the user tapped open (matched by text; survives re-renders)

function renderDetailHead() {
  const s = sessions.get(key(current.agent, current.id));
  $('d-project').textContent = s ? s.name || s.project : 'Session ended';
  if (!s) {
    $('d-meta').textContent = AGENT[current.agent] ?? current.agent;
    $('d-pill').textContent = '';
    return;
  }
  const v = view(s);
  $('d-meta').textContent = `${AGENT[s.agent] ?? s.agent} · ${s.cwd}`;
  $('d-pill').textContent = `${v.label} · ${ago(serverNow() - s.stateSince)}`;
  $('d-pill').style.setProperty('--c', `var(--${{ working: 'working', approval: 'approval', turn: 'turn' }[v.cls] ?? 'idle'})`);
}

function noteTerm(text) {
  $('term-note').textContent = text ?? '';
  $('term-note').hidden = !text;
}

function renderTerm(items, first) {
  const term = $('term');
  const root = document.documentElement;
  const atBottom = innerHeight + scrollY >= root.scrollHeight - 80;
  term.replaceChildren(
    ...items.map((it) => {
      const div = document.createElement('div');
      div.className = `t ${it.kind}`;
      if (it.kind === 'tool') {
        const name = document.createElement('b');
        name.textContent = it.tool;
        const arg = document.createElement('span');
        arg.textContent = it.text ? `(${it.text})` : '';
        div.append(name, arg);
      } else {
        div.textContent = it.text;
      }
      if (it.kind === 'result') {
        if (expanded.has(it.text)) div.classList.add('open');
        div.addEventListener('click', () => {
          div.classList.toggle('open');
          div.classList.contains('open') ? expanded.add(it.text) : expanded.delete(it.text);
        });
      }
      return div;
    }),
  );
  noteTerm(items.length ? '' : 'No messages yet.');
  if (first || atBottom) scrollTo(0, root.scrollHeight);
}

async function pollTranscript(first) {
  if (!current || document.hidden) return;
  const { agent, id } = current;
  try {
    const res = await fetch(`/api/transcript?agent=${agent}&id=${encodeURIComponent(id)}${token ? `&t=${encodeURIComponent(token)}` : ''}`);
    if (!current || current.id !== id) return; // navigated away meanwhile
    if (res.status === 403) return void (noteTerm('Transcript viewing is turned off in the host app.'), $('term').replaceChildren());
    if (res.status === 404) return void (noteTerm('No transcript available for this session yet.'), $('term').replaceChildren());
    if (!res.ok) throw new Error(String(res.status));
    const { items, size } = await res.json();
    const sig = `${size}:${items.length}`;
    if (first || sig !== lastSig) {
      lastSig = sig;
      renderTerm(items, first);
    }
  } catch {
    noteTerm('Reconnecting…');
  }
}

function route() {
  const m = /^#\/(claude|codex)\/(.+)$/.exec(location.hash);
  clearInterval(pollTimer);
  if (!m) {
    current = null;
    $('detail').hidden = true;
    $('list').hidden = false;
    render();
    return;
  }
  current = { agent: m[1], id: decodeURIComponent(m[2]) };
  markRead(key(current.agent, current.id)); // opening a session counts as reading it
  lastSig = '';
  $('term').replaceChildren();
  noteTerm('Loading…');
  for (const id of ['list', 'empty']) $(id).hidden = true;
  $('detail').hidden = false;
  renderDetailHead();
  scrollTo(0, 0);
  void pollTranscript(true);
  pollTimer = setInterval(() => pollTranscript(false), 1500);
}

$('back').addEventListener('click', () => {
  if (cameFromList) history.back();
  else location.hash = '';
  cameFromList = false;
});
addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => !document.hidden && current && pollTranscript(false));
route();

$('fs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
