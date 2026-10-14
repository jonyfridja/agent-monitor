import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer, type MonitorServer } from './index.ts';

const PORT = 47320 + Math.floor(Math.random() * 50);
const base = `http://127.0.0.1:${PORT}`;
const RECENT = '11111111-1111-4111-8111-111111111111';
const OLD = '22222222-2222-4222-8222-222222222222';
const HOOKED = '33333333-3333-4333-8333-333333333333';

let dir: string;
let server: MonitorServer;

const user = (text: string, cwd: string) =>
  JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: text } }) + '\n';
const assistant = (text: string) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';
const title = (customTitle: string) => JSON.stringify({ type: 'custom-title', customTitle }) + '\n';

async function writeChat(id: string, cwd: string, text: string, customTitle?: string): Promise<void> {
  const slug = cwd.replace(/^\//, '').replaceAll('/', '-');
  const folder = join(dir, 'projects', slug);
  await mkdir(folder, { recursive: true });
  const head = JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }) + '\n';
  await writeFile(join(folder, `${id}.jsonl`), head + user(text, cwd) + assistant('hi back') + (customTitle ? title(customTitle) : ''));
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'am-claude-'));
  await writeChat(RECENT, '/work/claude-app', 'hello from the app', 'Installed unused skills');
  await writeChat(OLD, '/work/old', 'ancient');
  const then = new Date(Date.now() - 13 * 60 * 60 * 1000);
  await utimes(join(dir, 'projects', 'work-old', `${OLD}.jsonl`), then, then);
  server = createMonitorServer({
    port: PORT,
    transcriptRoots: [dir],
    claudeProjectsDir: join(dir, 'projects'),
    cursorProjectsDir: join(dir, 'no-cursor'),
    nameSources: {
      claudeSessionsDir: join(dir, 'claude-sessions'),
      codexIndex: join(dir, 'codex.jsonl'),
      cursorChatsDir: join(dir, 'chats'),
    },
  });
  await server.start();
});

after(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

test('a recent Claude transcript shows up with its conversation, even when no hook sent a path', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  const ids = state.sessions.map((s: { id: string }) => s.id);
  assert.ok(ids.includes(RECENT));
  assert.equal(ids.includes(OLD), false, 'chats older than 12h stay off the phone');
  const recent = state.sessions.find((s: { id: string }) => s.id === RECENT);
  assert.equal(recent.agent, 'claude');
  assert.equal(recent.hasTranscript, true);
  assert.equal(recent.project, 'claude-app');
  assert.doesNotMatch(JSON.stringify(state), /\.jsonl/);
  const body = await (await fetch(`${base}/api/transcript?agent=claude&id=${RECENT}`)).json();
  assert.deepEqual(body.items, [
    { kind: 'user', text: 'hello from the app' },
    { kind: 'assistant', text: 'hi back' },
  ]);
  let name = recent.name;
  for (let i = 0; i < 20 && name !== 'Installed unused skills'; i++) {
    await new Promise((r) => setTimeout(r, 25));
    const again = await (await fetch(`${base}/api/state`)).json();
    name = again.sessions.find((s: { id: string }) => s.id === RECENT)?.name;
  }
  assert.equal(name, 'Installed unused skills');
});

test('a Claude hook with no transcript path still opens the conversation file', async () => {
  await writeChat(HOOKED, '/work/cli', 'from the cli');
  const res = await fetch(`${base}/api/events?agent=claude`, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: HOOKED,
      cwd: '/work/cli',
    }),
  });
  assert.equal(res.status, 204);
  const body = await (await fetch(`${base}/api/transcript?agent=claude&id=${HOOKED}`)).json();
  assert.deepEqual(body.items[0], { kind: 'user', text: 'from the cli' });
});
