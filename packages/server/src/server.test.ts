import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorServer, lanAddresses, type MonitorServer } from './index.ts';

const PORT = 47800 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
let dir: string;
let root: string;
let server: MonitorServer;

const line = (o: object) => JSON.stringify(o) + '\n';
const hook = (agent: string, body: object) =>
  fetch(`${base}/api/events?agent=${agent}`, { method: 'POST', body: JSON.stringify(body) });
const transcript = (q: string) => fetch(`${base}/api/transcript?${q}`);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'am-srv-'));
  root = join(dir, 'agent-home');
  await mkdir(join(root, 'projects'), { recursive: true });
  await writeFile(
    join(root, 'projects', 's1.jsonl'),
    line({ type: 'user', message: { role: 'user', content: 'hello there' } }) +
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi!' }] } }),
  );
  await writeFile(join(dir, 'outside.jsonl'), line({ type: 'user', message: { role: 'user', content: 'SECRET' } }));
  await symlink(join(dir, 'outside.jsonl'), join(root, 'projects', 'escape.jsonl'));
  await writeFile(join(root, 'projects', 'notes.txt'), 'plain text');

  await mkdir(join(dir, 'claude-sessions'));
  await writeFile(join(dir, 'claude-sessions', '9.json'), JSON.stringify({ pid: 9, sessionId: 'named', name: 'Harness Name', nameSource: 'user' }));
  await writeFile(join(dir, 'codex-index.jsonl'), JSON.stringify({ id: 'cx', thread_name: 'Codex Thread' }) + '\n');
  server = createMonitorServer({
    port: PORT,
    token: 'tok',
    transcriptRoots: [root],
    nameSources: {
      claudeSessionsDir: join(dir, 'claude-sessions'),
      codexIndex: join(dir, 'codex-index.jsonl'),
      cursorChatsDir: join(dir, 'cursor-chats'),
    },
  });
  await server.start();
  const ev = (id: string, path: string) => ({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd: '/w/p', transcript_path: path });
  await hook('claude', ev('s1', join(root, 'projects', 's1.jsonl')));
  await hook('claude', ev('outside', join(dir, 'outside.jsonl')));
  await hook('claude', ev('escape', join(root, 'projects', 'escape.jsonl')));
  await hook('claude', ev('txt', join(root, 'projects', 'notes.txt')));
  await hook('claude', { hook_event_name: 'UserPromptSubmit', session_id: 'nopath', cwd: '/w/p' });
});
after(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

test('sessions advertise hasTranscript but never expose the file path', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  const s1 = state.sessions.find((s: { id: string }) => s.id === 's1');
  assert.equal(s1.hasTranscript, true);
  assert.equal(state.sessions.find((s: { id: string }) => s.id === 'nopath').hasTranscript, false);
  assert.doesNotMatch(JSON.stringify(state), /agent-home|\.jsonl/);
});

test('returns parsed items for a session whose transcript is under an allowed root', async () => {
  const res = await transcript('agent=claude&id=s1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.items, [
    { kind: 'user', text: 'hello there' },
    { kind: 'assistant', text: 'hi!' },
  ]);
});

test('refuses paths outside the agent dirs, symlink escapes and non-jsonl files', async () => {
  for (const id of ['outside', 'escape', 'txt', 'nopath', 'unknown']) {
    const res = await transcript(`agent=claude&id=${id}`);
    assert.equal(res.status, 404, id);
    assert.doesNotMatch(await res.text(), /SECRET/);
  }
});

test('a client cannot pick the file: a path parameter is ignored', async () => {
  const res = await transcript(`agent=claude&id=nopath&path=${encodeURIComponent(join(dir, 'outside.jsonl'))}`);
  assert.equal(res.status, 404);
});

test('bad requests', async () => {
  assert.equal((await transcript('agent=nope&id=s1')).status, 400);
  assert.equal((await transcript('agent=claude')).status, 400);
});

test('LAN callers need the token; loopback does not', { skip: lanAddresses().length === 0 }, async () => {
  const lan = `http://${lanAddresses()[0]}:${PORT}/api/transcript?agent=claude&id=s1`;
  assert.equal((await fetch(lan)).status, 401);
  assert.equal((await fetch(`${lan}&t=wrong`)).status, 401);
  assert.equal((await fetch(`${lan}&t=tok`)).status, 200);
});

test('can be switched off at runtime', async () => {
  server.setShareTranscripts(false);
  assert.equal((await transcript('agent=claude&id=s1')).status, 403);
  server.setShareTranscripts(true);
  assert.equal((await transcript('agent=claude&id=s1')).status, 200);
});

test('sessions carry the harness name once resolved, and the phone stream is told', async () => {
  const stream = fetch(`${base}/api/stream`);
  const seen: string[] = [];
  const reader = (await stream).body!.getReader();
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      for (const m of dec.decode(value).matchAll(/"name":"([^"]+)"/g)) seen.push(m[1]);
    }
  })();
  await hook('claude', { hook_event_name: 'SessionStart', session_id: 'named', cwd: '/w/p' });
  await hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: 'cx', cwd: '/w/q' });
  await hook('claude', { hook_event_name: 'SessionStart', session_id: 'unnamed', cwd: '/w/r' });
  await new Promise((r) => setTimeout(r, 300));
  const state = await (await fetch(`${base}/api/state`)).json();
  const by = (id: string) => state.sessions.find((s: { id: string }) => s.id === id);
  assert.equal(by('named').name, 'Harness Name');
  assert.equal(by('cx').name, 'Codex Thread');
  assert.equal(by('unnamed').name, undefined);
  assert.equal(by('unnamed').project, 'r'); // fallback stays available
  assert.ok(seen.includes('Harness Name'), 'streamed to viewers');
  await reader.cancel();
  await pump.catch(() => {});
});

test('a session alert names its agent and session, so the phone can highlight the right card', async () => {
  const res = await fetch(`${base}/api/stream`);
  const reader = res.body!.getReader();
  let text = '';
  const pump = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += dec.decode(value);
    }
  })();
  await hook('codex', { hook_event_name: 'UserPromptSubmit', session_id: 'alert-me', cwd: '/w/n' });
  await hook('codex', { hook_event_name: 'Stop', session_id: 'alert-me', cwd: '/w/n' });
  await fetch(`${base}/api/notify`, { method: 'POST', body: JSON.stringify({ title: 'custom' }) });
  await new Promise((r) => setTimeout(r, 200));
  await reader.cancel();
  await pump.catch(() => {});
  const notices = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1])).filter((m) => m.type === 'notice').map((m) => m.notice);
  const fromSession = notices.find((n) => n.sessionId === 'alert-me');
  assert.equal(fromSession?.agent, 'codex');
  assert.equal(fromSession?.level, 'attention');
  const custom = notices.find((n) => n.title === 'custom');
  assert.equal(custom?.agent, undefined); // no card to highlight: the phone shows this one as a toast
  assert.equal(custom?.sessionId, undefined);
});
