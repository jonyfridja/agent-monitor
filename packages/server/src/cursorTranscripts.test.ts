import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer, type MonitorServer } from './index.ts';

const PORT = 47610 + Math.floor(Math.random() * 80);
const base = `http://127.0.0.1:${PORT}`;

let dir: string;
let server: MonitorServer;

const line = (role: string, text: string) =>
  JSON.stringify({ role, message: { content: [{ type: 'text', text }] } }) + '\n';

async function writeChat(id: string, cwd: string, text: string): Promise<string> {
  const path = join(dir, 'projects', 'slug', 'agent-transcripts', id, `${id}.jsonl`);
  await mkdir(join(dir, 'projects', 'slug', 'agent-transcripts', id), { recursive: true });
  await mkdir(join(dir, 'chats', 'ws', id), { recursive: true });
  await writeFile(path, line('user', text) + line('assistant', 'reply'));
  await writeFile(join(dir, 'chats', 'ws', id, 'meta.json'), JSON.stringify({ title: `Title ${id}`, cwd }));
  return path;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'am-cursor-'));
  await writeChat('recent', '/work/app', 'hello from the agent');
  const old = await writeChat('old', '/work/old', 'ancient');
  const then = new Date(Date.now() - 13 * 60 * 60 * 1000);
  await utimes(old, then, then);
  server = createMonitorServer({
    port: PORT,
    transcriptRoots: [dir],
    cursorProjectsDir: join(dir, 'projects'),
    claudeProjectsDir: join(dir, 'no-claude'),
    nameSources: {
      claudeSessionsDir: join(dir, 'claude'),
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

test('a recent Cursor transcript shows up with its conversation, even when no hook sent a path', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  const ids = state.sessions.map((s: { id: string }) => s.id);
  assert.ok(ids.includes('recent'));
  assert.equal(ids.includes('old'), false, 'chats older than 12h stay off the phone');
  const recent = state.sessions.find((s: { id: string }) => s.id === 'recent');
  assert.equal(recent.agent, 'cursor');
  assert.equal(recent.hasTranscript, true);
  assert.equal(recent.project, 'app');
  assert.doesNotMatch(JSON.stringify(state), /\.jsonl/);
  const body = await (await fetch(`${base}/api/transcript?agent=cursor&id=recent`)).json();
  assert.deepEqual(body.items, [
    { kind: 'user', text: 'hello from the agent' },
    { kind: 'assistant', text: 'reply' },
  ]);
});

test('a Cursor hook with a null transcript path still opens the conversation file', async () => {
  await writeChat('hooked', '/work/cli', 'from the cli');
  const res = await fetch(`${base}/api/events?agent=cursor`, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'sessionStart',
      conversation_id: 'hooked',
      cursor_version: '3.24.12',
      workspace_roots: ['/work/cli'],
      transcript_path: null,
    }),
  });
  assert.equal(res.status, 204);
  const body = await (await fetch(`${base}/api/transcript?agent=cursor&id=hooked`)).json();
  assert.equal(body.items[0].text, 'from the cli');
});

test('Cursor replaying the Claude hook command does not add a second Claude card', async () => {
  const res = await fetch(`${base}/api/events?agent=claude`, {
    method: 'POST',
    body: JSON.stringify({
      hook_event_name: 'sessionStart',
      conversation_id: 'same-chat',
      session_id: 'same-chat',
      cursor_version: '3.24.12',
      workspace_roots: ['/work/cli'],
    }),
  });
  assert.equal(res.status, 204);
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(
    state.sessions.some((s: { agent: string; id: string }) => s.agent === 'claude' && s.id === 'same-chat'),
    false,
  );
});
