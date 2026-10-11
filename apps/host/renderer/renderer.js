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
let onboarding = false; // true from setting the first password until the hooks step is dismissed

// ---- password strength: checked here in the window only ----
const COMMON = ['password', 'qwerty', '123456', '12345678', 'letmein', 'iloveyou', 'admin', 'welcome', 'agentmonitor', 'agent-monitor'];
function passwordRules(pw, repeat) {
  const lower = pw.toLowerCase();
  return [
    { ok: pw.length >= 10, text: 'At least 10 characters' },
    { ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw), text: 'Upper- and lowercase letters' },
    { ok: /\d/.test(pw), text: 'At least one number' },
    { ok: /[^A-Za-z0-9]/.test(pw), text: 'At least one symbol (e.g. ! - _ #)' },
    { ok: !!pw && !COMMON.some((c) => lower.includes(c)) && !/(.)\1\1/.test(pw), text: 'Not a common word or repeated characters' },
    { ok: !!pw && pw === repeat, text: 'Both entries match' },
  ];
}

/** Live checklist under a password form; the submit button unlocks only when every rule passes. */
function wirePasswordForm(form, first, second, list, errorEl, onDone) {
  const submit = form.querySelector('button[type=submit]');
  const update = () => {
    const rules = passwordRules(first.value, second.value);
    list.hidden = !first.value && list.id === 'pw-rules';
    list.replaceChildren(...rules.map((r) => el('li', { className: r.ok ? 'ok' : '', textContent: `${r.ok ? '✓' : '•'} ${r.text}` })));
    submit.disabled = !rules.every((r) => r.ok);
  };
  first.addEventListener('input', update);
  second.addEventListener('input', update);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!passwordRules(first.value, second.value).every((r) => r.ok)) return;
    submit.disabled = true;
    const error = await window.am.setPassword(first.value);
    errorEl.hidden = !error;
    errorEl.textContent = error ?? '';
    if (!error) {
      first.value = second.value = '';
      onDone?.();
    }
    update();
  });
  update();
}

function agentRow(id, a, withToggle) {
  const status = {
    installed: 'Hooks installed',
    'not-installed': 'No hooks',
    'wrong-port': 'Hooks point at another port',
    error: `Can't read config: ${a.error}`,
  }[a.hook];
  const kids = [];
  if (withToggle) {
    const box = el('input', { type: 'checkbox', checked: a.enabled, title: 'Show this agent’s sessions' });
    box.addEventListener('change', () => window.am.setAgent(id, box.checked));
    kids.push(box);
  }
  kids.push(el('span', { className: 'name', textContent: LABELS[id] ?? id }), el('span', { className: `state ${a.hook === 'installed' ? 'installed' : a.hook === 'not-installed' ? '' : 'error'}`, textContent: status }));
  if (a.hook !== 'installed') {
    const install = el('button', { textContent: a.hook === 'wrong-port' ? 'Fix hooks' : 'Install hooks' });
    install.addEventListener('click', () => window.am.installHooks(id));
    kids.push(install);
  }
  if (a.hook === 'installed' || a.hook === 'wrong-port') {
    const remove = el('button', { textContent: 'Uninstall' });
    remove.addEventListener('click', () => window.am.uninstallHooks(id));
    kids.push(remove);
  }
  return el('div', { className: 'agent' }, ...kids);
}

function render(state) {
  last = state;
  const setup = state.needsPassword || onboarding;
  $('setup').hidden = !setup;
  $('main').hidden = setup;
  $('setup-pw').hidden = !state.needsPassword;
  $('setup-hooks').hidden = state.needsPassword;
  $('setup-agents').replaceChildren(...Object.entries(state.agents).map(([id, a]) => agentRow(id, a, false)));

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

  $('agents').replaceChildren(...Object.entries(state.agents).map(([id, a]) => agentRow(id, a, true)));

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

  $('pw-status').textContent = 'Phones log in with your password. Changing it signs every phone out.';
  $('tls-status').textContent = state.https
    ? `HTTPS is on. The certificate is self-made, so the phone warns once — accept it. SHA-256: ${state.certFingerprint ?? ''}`
    : 'HTTPS is off: traffic on your Wi-Fi is unencrypted.';

  $('transcripts').checked = state.shareTranscripts;
  $('login').checked = state.launchAtLogin;
  $('login-hint').textContent = state.packaged ? '' : '(takes effect in the packaged app)';
}

$('server-toggle').addEventListener('click', () => (last?.running ? window.am.stopServer() : window.am.startServer()));
$('copy').addEventListener('click', () => window.am.copyUrl());
wirePasswordForm($('pw-form'), $('pw'), $('pw2'), $('pw-rules'), $('pw-error'));
wirePasswordForm($('setup-pw'), $('setup-pw1'), $('setup-pw2'), $('setup-rules'), $('setup-error'), () => {
  onboarding = true; // move on to the hooks step
  if (last) render({ ...last, needsPassword: false });
});
$('setup-done').addEventListener('click', () => {
  onboarding = false;
  if (last) render(last);
});
$('transcripts').addEventListener('change', (e) => window.am.setShareTranscripts(e.target.checked));
$('login').addEventListener('change', (e) => window.am.setLaunchAtLogin(e.target.checked));
$('quit').addEventListener('click', () => window.am.quit());

window.am.onState(render);
setInterval(() => last && render(last), 15000); // refresh relative times
