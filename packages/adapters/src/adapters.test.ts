import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters, normalize } from './index.ts';
import { addOurHooks, hookCommand, removeOurHooks, type HookFile } from './hookConfig.ts';

const boost = { hooks: [{ type: 'command', command: '/Users/me/.claude/hooks/boost-sync.sh' }] };
const userFile = (): HookFile => ({
  model: 'opus',
  hooks: {
    Stop: [boost],
    PreToolUse: [{ matcher: 'Bash|Read', hooks: [{ type: 'command', command: 'boost-hook.sh' }] }],
  },
});

test('add keeps every existing hook and other top-level keys', () => {
  const out = addOurHooks(userFile(), ['Stop', 'SessionStart'], hookCommand('claude', 1234));
  assert.equal(out.model, 'opus');
  assert.deepEqual(out.hooks!.Stop![0], boost);
  assert.equal(out.hooks!.Stop!.length, 2);
  assert.equal(out.hooks!.SessionStart!.length, 1);
  assert.equal(out.hooks!.PreToolUse!.length, 1);
});

test('add is idempotent and re-points the port', () => {
  const once = addOurHooks(userFile(), ['Stop'], hookCommand('claude', 1111));
  const twice = addOurHooks(once, ['Stop'], hookCommand('claude', 2222));
  assert.equal(twice.hooks!.Stop!.length, 2);
  assert.match(JSON.stringify(twice), /127\.0\.0\.1:2222/);
  assert.doesNotMatch(JSON.stringify(twice), /127\.0\.0\.1:1111/);
});

test('remove restores the original file exactly', () => {
  const original = userFile();
  const roundTrip = removeOurHooks(addOurHooks(original, ['Stop', 'SessionStart', 'PreToolUse'], hookCommand('codex', 9)));
  assert.deepEqual(roundTrip, original);
});

test('remove on a file with no hooks is a no-op', () => {
  assert.deepEqual(removeOurHooks({ model: 'x' }), { model: 'x' });
});

test('hook command never fails the agent and has a 1s cap', () => {
  const cmd = hookCommand('claude', 47821);
  assert.match(cmd, /-m 1 /);
  assert.match(cmd, /\|\| true$/);
  assert.match(cmd, /agent=claude/);
});

test('adapter install/state/uninstall against a temp home, preserving foreign hooks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'am-home-'));
  await mkdir(join(home, '.codex'), { recursive: true });
  const path = join(home, '.codex', 'hooks.json');
  await writeFile(path, JSON.stringify({ hooks: { Stop: [boost] } }));
  const { codex } = createAdapters(home);

  assert.equal(await codex.state(5000), 'not-installed');
  await codex.install(5000);
  assert.equal(await codex.state(5000), 'installed');
  assert.equal(await codex.state(6000), 'wrong-port');
  await codex.uninstall();
  assert.equal(await codex.state(5000), 'not-installed');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { hooks: { Stop: [boost] } });
  // First write made a one-time backup of the pristine file.
  assert.deepEqual(JSON.parse(await readFile(`${path}.agent-monitor.bak`, 'utf8')), { hooks: { Stop: [boost] } });
});

test('install refuses to overwrite an unparseable config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'am-home-'));
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), '{ not json');
  await assert.rejects(createAdapters(home).claude.install(1));
  assert.equal(await readFile(join(home, '.claude', 'settings.json'), 'utf8'), '{ not json');
});

test('normalize maps hook payloads and drops irrelevant ones', () => {
  const base = { session_id: 's', cwd: '/a/b' };
  const k = (p: object) => normalize('claude', { ...base, ...p }, 1)?.kind;
  assert.equal(k({ hook_event_name: 'UserPromptSubmit' }), 'prompt');
  assert.equal(k({ hook_event_name: 'PostToolUse' }), 'tool');
  assert.equal(k({ hook_event_name: 'PermissionRequest' }), 'approval');
  assert.equal(k({ hook_event_name: 'Stop' }), 'turn-end');
  assert.equal(k({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), 'approval');
  assert.equal(k({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 'idle');
  assert.equal(k({ hook_event_name: 'Notification', notification_type: 'auth_success' }), undefined);
  assert.equal(k({ hook_event_name: 'SubagentStop' }), undefined);
  assert.equal(normalize('claude', { hook_event_name: 'Stop' }), null);
  assert.equal(normalize('codex', 'garbage'), null);
});
