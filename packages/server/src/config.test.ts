import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT } from '@agent-monitor/protocol';
import { verifyPassword } from './auth.ts';
import { defaultConfig, loadConfig, saveConfig } from './config.ts';

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'am-config-'));
});
after(() => rm(dir, { recursive: true, force: true }));

test('first run: defaults, a generated pairing token, and the file is written for next time', async () => {
  const path = join(dir, 'first.json');
  const c = await loadConfig(path);
  assert.equal(c.port, DEFAULT_PORT);
  assert.ok(c.token.length >= 10, 'token is long enough to be a secret');
  assert.deepEqual(c.agents, { claude: { enabled: true }, codex: { enabled: true } });
  assert.equal(c.shareTranscripts, true);
  assert.equal((await loadConfig(path)).token, c.token, 'the token is stable across launches');
});

test('the config file is private to the user (0600): it holds the pairing token', { skip: process.platform === 'win32' }, async () => {
  const path = join(dir, 'perm.json');
  await loadConfig(path);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test('an old config missing newer fields loads with defaults and keeps the user’s choices and token', async () => {
  const path = join(dir, 'old.json');
  await writeFile(path, JSON.stringify({ port: 5555, token: 'keep-me', agents: { claude: { enabled: false } } })); // v0: no codex, no shareTranscripts, no launchAtLogin
  const c = await loadConfig(path);
  assert.equal(c.port, 5555);
  assert.equal(c.token, 'keep-me');
  assert.equal(c.agents.claude.enabled, false, 'an explicit choice survives');
  assert.equal(c.agents.codex.enabled, true, 'a missing agent defaults to on');
  assert.equal(c.shareTranscripts, true);
  assert.equal(c.launchAtLogin, false);
  assert.equal(await verifyPassword('123456', c.passwordHash), true, 'the default password until the user changes it');
  assert.deepEqual(c.tls, { enabled: true }, 'https on by default');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.token, 'keep-me', 'the token survives the upgrade');
  assert.equal(saved.sessionSecret, c.sessionSecret, 'a generated session secret is persisted');
  assert.equal(saved.passwordHash, c.passwordHash, 'so is the default password hash — never the password itself');
  assert.doesNotMatch(JSON.stringify(saved), /123456/);
});

test('save → load round-trips every field', async () => {
  const path = join(dir, 'roundtrip.json');
  const c = {
    ...defaultConfig(),
    port: 6000,
    launchAtLogin: true,
    shareTranscripts: false,
    agents: { claude: { enabled: false }, codex: { enabled: true } },
    passwordHash: 'scrypt$1$2$3$salt$hash',
    tls: { enabled: true, cert: '/c.pem', key: '/k.pem' },
  };
  await saveConfig(c, path);
  assert.deepEqual(await loadConfig(path), c);
});

test('a corrupt config is reported, not silently replaced (it would discard the token and settings)', async () => {
  const path = join(dir, 'corrupt.json');
  await writeFile(path, '{ "port": 5');
  await assert.rejects(loadConfig(path));
  assert.equal(await readFile(path, 'utf8'), '{ "port": 5', 'left untouched');
});

test('defaultConfig generates a different token each time', () => {
  assert.notEqual(defaultConfig().token, defaultConfig().token);
});
