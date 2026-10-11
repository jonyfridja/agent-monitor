import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, type HostState } from './controller.ts';

const PORT = 47900 + Math.floor(Math.random() * 90);
const boost = { hooks: [{ type: 'command', command: '/x/boost-sync.sh' }] };
let home: string;
let configPath: string;

const opts = () => ({ webDir: '/nonexistent', home, configPath, port: PORT });
const post = (agent: string, body: object) =>
  fetch(`http://127.0.0.1:${PORT}/api/events?agent=${agent}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const nextChange = (c: Controller) => new Promise<HostState>((res) => c.once('change', res));
const readHooks = async (rel: string) => JSON.parse(await readFile(join(home, rel), 'utf8'));

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'am-host-'));
  configPath = join(home, 'am-config.json');
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [boost] } }));
});
after(() => rm(home, { recursive: true, force: true }));

test('host lifecycle: hooks only on request, events, disable, persistence, stop/start, port conflict', async () => {
  const c = new Controller(opts());
  await c.init();

  // Launching never touches the agents' config files.
  let s = c.state();
  assert.equal(s.running, true);
  assert.equal(s.agents.claude.hook, 'not-installed');
  assert.equal(s.agents.codex.hook, 'not-installed');
  await assert.rejects(readFile(join(home, '.claude', 'settings.json')), 'no file created');
  assert.deepEqual(await readHooks('.codex/hooks.json'), { hooks: { Stop: [boost] } });
  assert.ok(s.phoneUrl === null || s.phoneUrl === `https://${s.phoneUrl.split('/')[2]}/`, 'https, no token in the URL');
  assert.equal(s.https, true);
  assert.match(s.certFingerprint ?? '', /^[0-9A-F:]+$/);
  assert.equal(s.needsPassword, true, 'fresh install: the user must choose a password');

  // The user installs hooks explicitly; their own hooks survive.
  await c.installHooks('claude');
  await c.installHooks('codex');
  s = c.state();
  assert.equal(s.agents.claude.hook, 'installed');
  assert.equal(s.agents.codex.hook, 'installed');
  assert.match(JSON.stringify(await readHooks('.codex/hooks.json')), /boost-sync\.sh/);

  // A hook event shows up in state.
  const changed = nextChange(c);
  assert.equal((await post('claude', { hook_event_name: 'UserPromptSubmit', session_id: 'a', cwd: '/w/proj' })).status, 204);
  s = await changed;
  assert.deepEqual(s.sessions.map((x) => [x.agent, x.project, x.status]), [['claude', 'proj', 'working']]);

  // Disabling an agent hides it (sessions dropped, events ignored) but leaves its hook file alone.
  await c.setAgentEnabled('claude', false);
  s = c.state();
  assert.equal(s.agents.claude.hook, 'installed');
  assert.equal(s.sessions.length, 0);
  await post('claude', { hook_event_name: 'UserPromptSubmit', session_id: 'b', cwd: '/w/x' });
  assert.equal(c.state().sessions.length, 0);
  await c.setAgentEnabled('codex', false);

  // Uninstall removes only our entries.
  await c.uninstallHooks('codex');
  assert.equal(c.state().agents.codex.hook, 'not-installed');
  assert.deepEqual(await readHooks('.codex/hooks.json'), { hooks: { Stop: [boost] } });

  // A second host on the same port reports the conflict instead of crashing.
  const rival = new Controller(opts());
  await rival.init();
  assert.equal(rival.state().running, false);
  assert.match(rival.state().error ?? '', /already in use/);
  await rival.shutdown();

  // Stop frees the port; start brings it back with a fresh store.
  await c.stopServer();
  assert.equal(c.state().running, false);
  await assert.rejects(post('claude', {}));
  await c.startServer();
  assert.equal(c.state().running, true);
  await c.shutdown();

  // Transcript sharing toggles at runtime and persists.
  assert.equal(c.state().shareTranscripts, true);
  await c.setShareTranscripts(false);
  assert.equal(c.state().shareTranscripts, false);

  // Changing the password: too short is refused; the new one is stored only as a hash.
  await assert.rejects(c.setPassword('12345'), /at least 6/);
  await assert.rejects(c.setPassword('123456'), /placeholder/);
  assert.equal(c.state().needsPassword, true);
  await c.setPassword('long-enough-pw');
  assert.equal(c.state().needsPassword, false);
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.match(saved.passwordHash, /^scrypt\$/);
  assert.doesNotMatch(JSON.stringify(saved), /long-enough-pw/);

  // Settings persist across launches.
  const reborn = new Controller(opts());
  await reborn.init();
  s = reborn.state();
  assert.equal(s.agents.claude.enabled, false);
  assert.equal(s.agents.codex.enabled, false);
  assert.equal(s.shareTranscripts, false);
  assert.equal(s.needsPassword, false, 'the chosen password persists');
  assert.equal(s.agents.claude.hook, 'installed', 'hook state is read from the files');
  await reborn.uninstallHooks('claude');
  await reborn.shutdown();
});

test('a broken agent config is reported, not overwritten', async () => {
  const bad = await mkdtemp(join(tmpdir(), 'am-bad-'));
  await mkdir(join(bad, '.claude'), { recursive: true });
  await writeFile(join(bad, '.claude', 'settings.json'), '{ nope');
  const c = new Controller({ webDir: '/x', home: bad, configPath: join(bad, 'cfg.json'), port: PORT + 100 });
  await c.init();
  assert.equal(c.state().agents.claude.hook, 'error');
  await c.installHooks('claude');
  assert.equal(c.state().agents.claude.hook, 'error');
  assert.equal(await readFile(join(bad, '.claude', 'settings.json'), 'utf8'), '{ nope');
  await c.shutdown();
  await rm(bad, { recursive: true, force: true });
});
