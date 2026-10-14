// Phone client: renders sessions from the host's SSE stream and raises in-page alerts.
// Decisions (status views, unread rules, alert plans) live in core.js and are unit-tested; this file does DOM + storage.
import { alertPlan, ago, filterSessions, findSession, keepAwakeStatus, key, LIST_AGENTS, LIST_ARCHIVES, LIST_SORTS, LIST_STATUSES, listFromSearch, listQuery, listSearch, mergePrefs, parseUnread, pruneArchived, pruneUnread as prune, shouldMarkUnread, sortDirLabel, sortSessions, splitUnread, summarize, view } from './core.js';

const $ = (id) => document.getElementById(id);

// Auth is a cookie the server sets (password login, or a QR pairing link it swaps for one). Older versions kept the
// pairing token in localStorage: trade it in once, then forget it.
try {
  const old = localStorage.getItem('am.token');
  if (old) {
    localStorage.removeItem('am.token');
    location.replace(`/?t=${encodeURIComponent(old)}`);
  }
} catch {}

// ---- preferences (theme + alerts), kept on this phone in localStorage ----
function loadPrefs() {
  try {
    return mergePrefs(JSON.parse(localStorage.getItem('am.prefs') || 'null'));
  } catch {
    return mergePrefs(null);
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

const AGENT = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };
const sessions = new Map(); // "agent:id" -> Session
let skew = 0; // serverNow - localNow
const serverNow = () => Date.now() + skew;

// ---- unread: sessions that raised an alert you haven't looked at yet (kept on this phone) ----
// A session is unread from the moment it alerts until you open/tap it, or until the agent moves on (no longer waiting).
const unread = new Set(loadUnread());
const archived = new Set(loadArchived());
function loadArchived() {
  try {
    return parseUnread(localStorage.getItem('am.archived'));
  } catch {
    return [];
  }
}
function saveArchived() {
  try {
    localStorage.setItem('am.archived', JSON.stringify([...archived]));
  } catch {}
}
function toggleArchive(k) {
  if (archived.has(k)) archived.delete(k);
  else {
    archived.add(k);
    if (unread.delete(k)) saveUnread();
  }
  saveArchived();
  render();
}
let haveSnapshot = false; // don't prune stored unread state before we know which sessions exist
function loadUnread() {
  try {
    return parseUnread(localStorage.getItem('am.unread'));
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
  if (haveSnapshot && prune(unread, sessions)) saveUnread();
}
function pruneArchive() {
  if (haveSnapshot && pruneArchived(archived, sessions)) saveArchived();
}

// ---- rendering ----
function card(s) {
  const k = key(s.agent, s.id);
  const v = view(s);
  const isUnread = unread.has(k);
  const el = document.createElement('div');
  el.className = `card ${v.cls}${isUnread ? ' unread' : ''}${s.hasTranscript ? ' clickable' : ''}`;
  el.innerHTML = `
    <div class="row"><span class="agent"></span><span class="meta">${isUnread ? '<span class="new">New</span>' : ''}<span class="time" data-since="${s.stateSince}"></span></span></div>
    <div class="project"></div>
    <div class="foot"><div class="pill"></div></div>`;
  // Title = the harness's own name for the session; the folder moves to the small label when we have one.
  el.querySelector('.agent').textContent = (AGENT[s.agent] ?? s.agent) + (s.name ? ` · ${s.project}` : '');
  el.querySelector('.project').textContent = s.name || s.project;
  el.querySelector('.pill').textContent = v.label;
  const archiveBtn = document.createElement('button');
  archiveBtn.type = 'button';
  archiveBtn.className = 'archive';
  archiveBtn.textContent = archived.has(k) ? 'Unarchive' : 'Archive';
  archiveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleArchive(k);
  });
  el.querySelector('.foot').append(archiveBtn);
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
  pruneArchive();
  const all = [...sessions.values()];
  const active = all.filter((s) => !archived.has(key(s.agent, s.id)));
  const list = sortSessions(filterSessions(all, { ...listQ, archivedKeys: archived }), listQ.by, listQ.reverse);
  const { fresh, rest } = splitUnread(list, unread);
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
  const onList = !current;
  $('filter-btn').hidden = !onList || all.length === 0;
  $('filter-btn').classList.toggle('on', !!(listQ.agent || listQ.status || listQ.archived || listQ.reverse || listQ.by !== 'status'));
  if ($('filter-btn').hidden) closeFilters();
  $('empty').hidden = !onList || all.length > 0;
  $('nomatch').hidden = !onList || all.length === 0 || list.length > 0;
  $('nomatch').textContent = listQ.archived
    ? 'No archived chats.'
    : active.length === 0
      ? 'No active chats. Archived ones are in the filter menu.'
      : 'No sessions match these filters.';
  const summary = summarize(active, splitUnread(active, unread).fresh.length);
  $('summary').textContent = summary.text;
  document.title = summary.title;
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

// ---- keep the screen on ----
let awakeMode = 'none'; // 'wakelock' | 'video' | 'failed' | 'none'
let wakeSentinel = null;
let awakeVideo = null;
let awakeTimer = null;

function stopKeepAwake() {
  wakeSentinel?.release?.().catch?.(() => {});
  wakeSentinel = null;
  clearInterval(awakeTimer);
  awakeVideo?.pause();
  awakeVideo?.remove();
  awakeVideo = null;
  awakeMode = 'none';
}

async function acquireWakeLock() {
  try {
    wakeSentinel = await navigator.wakeLock.request('screen');
    wakeSentinel.addEventListener('release', () => (wakeSentinel = null)); // the browser drops it when the tab is hidden
    return true;
  } catch {
    return false; // insecure page, battery saver, …
  }
}

/** NoSleep-style fallback: a muted, looping video from a 2×2 canvas. Playing media keeps mobile browsers awake. */
function startAwakeVideo() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    if (!canvas.captureStream) return false;
    const ctx = canvas.getContext('2d');
    let n = 0;
    const draw = () => {
      ctx.fillStyle = n++ % 2 ? '#000000' : '#010101'; // a changing frame keeps the stream producing video
      ctx.fillRect(0, 0, 2, 2);
    };
    draw();
    awakeTimer = setInterval(draw, 1000);
    const v = document.createElement('video');
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.loop = true;
    v.srcObject = canvas.captureStream(1);
    Object.assign(v.style, { position: 'fixed', left: '0', top: '0', width: '1px', height: '1px', opacity: '0.01', pointerEvents: 'none' });
    document.body.append(v);
    awakeVideo = v;
    v.play().catch(() => {}); // may need a tap first; retried on the next pointerdown
    return true;
  } catch {
    return false;
  }
}

async function applyKeepAwake() {
  stopKeepAwake();
  if (prefs.keepAwake) {
    if (navigator.wakeLock?.request && (await acquireWakeLock())) awakeMode = 'wakelock';
    else awakeMode = startAwakeVideo() ? 'video' : 'failed';
  }
  syncMenu();
}
// A Wake Lock is released whenever the page is hidden, and can't be taken while hidden. When the page comes back, take
// it again — or upgrade from the video fallback if the API is available now.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !prefs.keepAwake) return;
  const lost = awakeMode === 'wakelock' && !wakeSentinel;
  const upgradable = awakeMode === 'video' && !!navigator.wakeLock?.request;
  if (lost || upgradable) void applyKeepAwake();
});

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
document.addEventListener('pointerdown', () => {
  unlock(); // any tap satisfies the browser's user-gesture rule
  if (awakeVideo?.paused) {
    awakeVideo.play().then(syncMenu, () => {});
  }
});

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

/** Carry out an alert plan (flash / toast / sound / vibration). Returns false when the user's settings muted it. */
function alertUser(n, force = false) {
  const plan = alertPlan(prefs, n, force);
  if (!plan) return false;

  if (plan.flash) {
    const flash = $('flash');
    flash.style.background = plan.flash;
    flash.classList.remove('go');
    void flash.offsetWidth;
    flash.classList.add('go');
  }
  if (plan.toast) {
    const toast = document.createElement('div');
    toast.className = `toast ${n.level}`;
    toast.innerHTML = '<b></b><span></span>';
    toast.querySelector('b').textContent = n.title;
    toast.querySelector('span').textContent = n.body;
    $('toasts').append(toast);
    setTimeout(() => toast.remove(), 6000);
  }
  if (plan.beep) beep(plan.beep.times, plan.beep.freq);
  if (plan.vibrate) navigator.vibrate?.(plan.vibrate);
  return true;
}

function handleNotice(n) {
  if (!alertUser(n)) return;
  const s = findSession(sessions, n);
  if (!s || !shouldMarkUnread(s, current)) return;
  unread.add(key(s.agent, s.id));
  saveUnread();
}

// ---- settings menu (behind the gear icon) ----
function syncMenu() {
  for (const r of document.querySelectorAll('input[name=theme]')) r.checked = r.value === prefs.theme;
  for (const el of document.querySelectorAll('[data-pref]')) el.checked = !!prefs[el.dataset.pref];
  for (const el of document.querySelectorAll('[data-level]')) el.checked = !!prefs.levels[el.dataset.level];
  $('alert-opts').disabled = !prefs.alerts;
  $('awake-status').textContent = keepAwakeStatus({ on: prefs.keepAwake, mode: awakeMode, playing: !!awakeVideo && !awakeVideo.paused });
  $('audio-status').textContent = !prefs.sound
    ? 'Sound is off.'
    : audio
      ? 'Sound is ready.'
      : 'Tap anywhere once to allow sound (browsers require it after each page load).';
}

function closeFilters() {
  $('filters').hidden = true;
  $('filter-btn').setAttribute('aria-expanded', 'false');
  if ($('menu').hidden) $('scrim').hidden = true;
}
function closePanels() {
  $('menu').hidden = true;
  $('gear').setAttribute('aria-expanded', 'false');
  closeFilters();
}
function setMenu(open) {
  if (!open) return closePanels();
  $('filters').hidden = true;
  $('filter-btn').setAttribute('aria-expanded', 'false');
  $('menu').hidden = false;
  $('scrim').hidden = false;
  $('gear').setAttribute('aria-expanded', 'true');
  syncMenu();
}
function setFiltersOpen(open) {
  if (!open) return closePanels();
  $('menu').hidden = true;
  $('gear').setAttribute('aria-expanded', 'false');
  $('filters').hidden = false;
  $('scrim').hidden = false;
  $('filter-btn').setAttribute('aria-expanded', 'true');
}
$('gear').addEventListener('click', () => setMenu($('menu').hidden));
$('filter-btn').addEventListener('click', () => setFiltersOpen($('filters').hidden));
$('scrim').addEventListener('click', closePanels);
addEventListener('keydown', (e) => e.key === 'Escape' && closePanels());

$('menu').addEventListener('change', (e) => {
  const el = e.target;
  if (el.name === 'theme') prefs.theme = el.value;
  else if (el.dataset.pref) prefs[el.dataset.pref] = el.checked;
  else if (el.dataset.level) prefs.levels[el.dataset.level] = el.checked;
  savePrefs();
  applyTheme();
  if (el.dataset.pref === 'keepAwake') void applyKeepAwake();
  syncMenu();
});

$('test-alert').addEventListener('click', () => {
  unlock();
  alertUser({ title: 'Test alert', body: 'This is how alerts look on this phone.', level: 'attention' }, true);
});

void applyKeepAwake(); // honours the saved choice on every page load

// ---- connection ----
const conn = $('conn');
let es = null;
function connect() {
  es?.close();
  es = new EventSource('/api/stream');
  es.onopen = () => conn.classList.add('on');
  es.onerror = () => {
    conn.classList.remove('on'); // EventSource reconnects on its own…
    void checkAuth(); // …unless we were logged out (password changed, cookie expired)
  };
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

// ---- login ----
let password = false;
let setupTimer = null;
function showLogin(mode) {
  es?.close();
  es = null;
  conn.classList.remove('on');
  clearInterval(pollTimer);
  setMenu(false);
  document.body.classList.add('locked');
  $('login').hidden = false;
  const pw = mode === 'password';
  $('login-text').textContent = {
    password: 'Enter the password you set on the Mac.',
    setup: 'No password has been set yet. Open agent-monitor on your Mac and choose one — this page continues by itself.',
    unpaired: 'This phone is not paired. Scan the QR code in the agent-monitor window on your Mac again.',
  }[mode];
  clearTimeout(setupTimer);
  if (mode === 'setup') setupTimer = setTimeout(() => void checkAuth(), 3000); // wait for the Mac
  for (const id of ['password-row', 'login-btn']) $(id).hidden = !pw;
  if (pw) {
    setPasswordVisible(false);
    $('password').focus();
  }
}
function setPasswordVisible(show) {
  $('password').type = show ? 'text' : 'password';
  $('pw-toggle').setAttribute('aria-pressed', String(show));
  $('pw-toggle').setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  $('eye').hidden = show;
  $('eye-off').hidden = !show;
}
$('pw-toggle').addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the field
$('pw-toggle').addEventListener('click', () => setPasswordVisible($('password').type === 'password'));
function hideLogin() {
  document.body.classList.remove('locked');
  $('login').hidden = true;
  $('account').hidden = !password;
}
/** Returns true when we may read data; otherwise swaps the screen for the login form. */
async function checkAuth() {
  try {
    const auth = await (await fetch('/api/auth')).json();
    password = auth.password;
    if (auth.authed) return true;
    showLogin(auth.setup ? 'setup' : auth.password ? 'password' : 'unpaired');
    return false;
  } catch {
    return true; // host unreachable: keep the reconnecting view rather than a login form
  }
}
$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-error').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    if (res.ok) {
      $('password').value = '';
      hideLogin();
      connect();
      route();
      return;
    }
    const body = await res.json().catch(() => ({}));
    $('login-error').textContent =
      res.status === 429 ? `Too many attempts. Try again in ${Math.ceil((body.retryAfter ?? 60) / 60)} min.` : res.status === 401 ? 'Wrong password.' : `Login failed (${res.status}).`;
  } catch {
    $('login-error').textContent = 'Cannot reach the Mac.';
  } finally {
    btn.disabled = false;
  }
});
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  showLogin('password');
});

void checkAuth().then((ok) => {
  if (!ok) return;
  hideLogin();
  connect();
});

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
    $('archive').hidden = true;
    return;
  }
  const v = view(s);
  $('d-meta').textContent = `${AGENT[s.agent] ?? s.agent} · ${s.cwd}`;
  $('d-pill').textContent = `${v.label} · ${ago(serverNow() - s.stateSince)}`;
  $('d-pill').style.setProperty('--c', `var(--${{ working: 'working', approval: 'approval', turn: 'turn' }[v.cls] ?? 'idle'})`);
  $('archive').hidden = false;
  $('archive').textContent = archived.has(key(current.agent, current.id)) ? 'Unarchive' : 'Archive';
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
    const res = await fetch(`/api/transcript?agent=${agent}&id=${encodeURIComponent(id)}`);
    if (!current || current.id !== id) return; // navigated away meanwhile
    if (res.status === 401) return void (await checkAuth());
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
  const m = /^#\/(claude|codex|cursor)\/(.+)$/.exec(location.hash);
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
  closePanels();
  for (const id of ['list', 'empty', 'filter-btn', 'nomatch']) $(id).hidden = true;
  $('detail').hidden = false;
  renderDetailHead();
  scrollTo(0, 0);
  void pollTranscript(true);
  pollTimer = setInterval(() => pollTranscript(false), 1500);
}

$('archive').addEventListener('click', () => current && toggleArchive(key(current.agent, current.id)));
$('back').addEventListener('click', () => {
  if (cameFromList) history.back();
  else location.hash = '';
  cameFromList = false;
});
function fillSelect(id, options, allLabel) {
  const el = $(id);
  const nodes = options.map((o) => new Option(o.label, o.id));
  el.replaceChildren(...(allLabel ? [new Option(allLabel, '')] : []), ...nodes);
}
function storedList() {
  try {
    return listQuery(JSON.parse(localStorage.getItem('am.list') || 'null'));
  } catch {
    return listQuery(null);
  }
}
function rememberList() {
  try {
    localStorage.setItem('am.list', JSON.stringify(listQ));
  } catch {}
}
/** The URL is the shareable copy. A phone with no query string still starts from its saved choice, then the URL catches up. */
function writeListUrl(push) {
  const next = location.pathname + listSearch(listQ) + location.hash;
  const now = location.pathname + location.search + location.hash;
  if (next !== now) history[push ? 'pushState' : 'replaceState'](null, '', next);
}
let listQ = listFromSearch(location.search) ?? storedList();
function syncListControls() {
  $('sort').value = listQ.by;
  $('filter-agent').value = listQ.agent;
  $('filter-status').value = listQ.status;
  $('filter-archive').value = listQ.archived ? 'archived' : '';
  $('sort-dir').textContent = sortDirLabel(listQ.by, listQ.reverse);
  $('sort-dir').setAttribute('aria-pressed', String(listQ.reverse));
  $('sort-dir').setAttribute('aria-label', `Sort direction: ${$('sort-dir').textContent}`);
}
function setList(next) {
  listQ = listQuery({ ...listQ, ...next });
  rememberList();
  writeListUrl(true);
  syncListControls();
  render();
}
fillSelect('sort', LIST_SORTS);
fillSelect('filter-agent', LIST_AGENTS, 'All agents');
fillSelect('filter-status', LIST_STATUSES, 'All statuses');
fillSelect('filter-archive', LIST_ARCHIVES);
rememberList();
writeListUrl(false);
syncListControls();
$('sort').addEventListener('change', () => setList({ by: $('sort').value }));
$('sort-dir').addEventListener('click', () => setList({ reverse: !listQ.reverse }));
for (const id of ['filter-agent', 'filter-status', 'filter-archive']) {
  $(id).addEventListener('change', () =>
    setList({
      agent: $('filter-agent').value,
      status: $('filter-status').value,
      archived: $('filter-archive').value === 'archived',
    }),
  );
}
addEventListener('popstate', () => {
  listQ = listFromSearch(location.search) ?? listQuery(null);
  rememberList();
  syncListControls();
  if (!current) render();
});

addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => !document.hidden && current && pollTranscript(false));
route();

$('fs').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});
