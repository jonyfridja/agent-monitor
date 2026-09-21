// Settings window. All data comes from the main process via the `am` bridge (see preload.ts).
const $ = (id) => document.getElementById(id);
const LABELS = { claude: 'Claude Code', codex: 'Codex' };
const COLORS = { working: 'var(--working)', approval: 'var(--approval)', turn: 'var(--turn)' };

function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
}

function since(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function describe(s) {
  if (s.status === 'working') return { text: 'working', color: COLORS.working };
  if (s.status === 'ended') return { text: 'ended', color: null };
  if (s.reason === 'approval') return { text: 'needs approval', color: COLORS.approval };
  if (s.reason === 'your-turn') return { text: 'your turn', color: COLORS.turn };
  return { text: 'idle', color: null };
}

let last = null;

function render(state) {
  last = state;
  const pill = $('server-pill');
  pill.textContent = state.running ? `Running · :${state.port}` : 'Stopped';
  pill.className = `pill ${state.running ? 'on' : 'off'}`;
  $('server-toggle').textContent = state.running ? 'Stop server' : 'Start server';

  $('tray-warn').hidden = !state.trayHidden;
  $('error').hidden = !state.error;
  $('error').textContent = state.error ?? '';

  $('qr').hidden = !state.qr;
  if (state.qr) $('qr').src = state.qr;
  $('url').textContent = state.phoneUrl ?? (state.running ? 'No network address found' : 'Start the server to get a URL');
  $('copy').disabled = !state.phoneUrl;

  $('agents').replaceChildren(
    ...Object.entries(state.agents).map(([id, a]) => {
      const box = el('input', { type: 'checkbox', checked: a.enabled });
      box.addEventListener('change', () => window.am.setAgent(id, box.checked));
      const status =
        a.hook === 'error' ? `Hook setup failed: ${a.error}` : a.enabled ? 'Hooks installed' : 'Not tracked';
      const kids = [box, el('span', { className: 'name', textContent: LABELS[id] ?? id }), el('span', { className: `state ${a.hook === 'error' ? 'error' : a.enabled ? 'installed' : ''}`, textContent: status })];
      if (a.hook === 'error' && a.enabled) {
        const retry = el('button', { textContent: 'Retry' });
        retry.addEventListener('click', () => window.am.reinstall(id));
        kids.push(retry);
      }
      return el('div', { className: 'agent' }, ...kids);
    }),
  );

  const live = state.sessions.filter((s) => s.status !== 'ended');
  $('session-count').textContent = live.length || '';
  $('sessions').replaceChildren(
    ...(live.length
      ? live.map((s) => {
          const d = describe(s);
          const dot = el('span', { className: 'dot' });
          if (d.color) dot.style.setProperty('--c', d.color);
          return el('li', {}, dot, el('span', { className: 'main', textContent: `${LABELS[s.agent]} · ${s.name || s.project}` }), el('span', { className: 'meta', textContent: `${d.text} · ${since(s.stateSince)}` }));
        })
      : [el('li', { className: 'empty', textContent: 'No active sessions' })]),
  );

  $('viewer-count').textContent = state.viewers.length || '';
  $('viewers').replaceChildren(
    ...(state.viewers.length
      ? state.viewers.map((v) => el('li', {}, el('span', { className: 'dot', style: 'background: var(--turn)' }), el('span', { className: 'main', textContent: v.ip }), el('span', { className: 'meta', textContent: `since ${since(v.since)} ago` })))
      : [el('li', { className: 'empty', textContent: 'No phones connected' })]),
  );

  $('transcripts').checked = state.shareTranscripts;
  $('login').checked = state.launchAtLogin;
  $('login-hint').textContent = state.packaged ? '' : '(takes effect in the packaged app)';
}

$('server-toggle').addEventListener('click', () => (last?.running ? window.am.stopServer() : window.am.startServer()));
$('copy').addEventListener('click', () => window.am.copyUrl());
$('transcripts').addEventListener('change', (e) => window.am.setShareTranscripts(e.target.checked));
$('login').addEventListener('change', (e) => window.am.setLaunchAtLogin(e.target.checked));
$('quit').addEventListener('click', () => window.am.quit());

window.am.onState(render);
setInterval(() => last && render(last), 15000); // refresh relative times
