import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_IDS } from '@agent-monitor/protocol';
import { createMonitorServer, lanAddresses, type MonitorServer } from './index.ts';

/** The HTTP contract phones and hooks depend on: routing, static files, auth, limits and viewer tracking. */

const PORT = 47600 + Math.floor(Math.random() * 90);
const base = `http://127.0.0.1:${PORT}`;
const lan = lanAddresses()[0];
const lanBase = `http://${lan}:${PORT}`;
const TOKEN = 'secret-token';
let dir: string;
let server: MonitorServer;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'am-contract-'));
  await mkdir(join(dir, 'web'));
  await writeFile(join(dir, 'web', 'index.html'), '<h1>phone ui</h1>');
  await writeFile(join(dir, 'web', 'app.js'), 'export {}');
  await writeFile(join(dir, 'secret.txt'), 'TOP SECRET');
  server = createMonitorServer({ port: PORT, token: TOKEN, webDir: join(dir, 'web') });
  await server.start();
});
after(async () => {
  await server.stop();
  await rm(dir, { recursive: true, force: true });
});

const post = (path: string, body: unknown, base_ = base) =>
  fetch(`${base_}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('static: serves the phone UI with the right content types', async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(await index.text(), '<h1>phone ui</h1>');
  assert.match((await fetch(`${base}/app.js`)).headers.get('content-type') ?? '', /javascript/);
  assert.equal((await fetch(`${base}/missing.css`)).status, 404);
});

test('static: path traversal cannot escape the web directory', async () => {
  for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/./../secret.txt']) {
    const res = await fetch(`${base}${path}`);
    assert.ok([403, 404].includes(res.status), `${path} → ${res.status}`);
    assert.doesNotMatch(await res.text(), /TOP SECRET/);
  }
});

test('routing: unknown routes and wrong methods are 404, never a crash', async () => {
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  assert.equal((await post('/api/nope', {})).status, 404);
  assert.equal((await fetch(`${base}/api/events?agent=claude`)).status, 404, 'GET on the ingest route');
  assert.equal((await fetch(`${base}/api/state`, { method: 'DELETE' })).status, 404);
});

test('ingest: bad agent, bad json and oversize bodies are rejected and the server keeps working', async () => {
  assert.equal((await post('/api/events?agent=nope', {})).status, 400);
  assert.equal((await post('/api/events', {})).status, 400, 'agent is required');
  assert.equal((await post('/api/events?agent=claude', '{ not json')).status, 400);
  const huge = JSON.stringify({ hook_event_name: 'Stop', session_id: 'big', pad: 'x'.repeat(1_200_000) });
  await assert.rejects(post('/api/events?agent=claude', huge), 'a >1 MB body is cut off, not buffered');
  assert.equal((await fetch(`${base}/api/state`)).status, 200, 'still healthy afterwards');
});

test('ingest: events for unknown/irrelevant hook names are accepted (204) but change nothing', async () => {
  const before = ((await (await fetch(`${base}/api/state`)).json()) as { sessions: unknown[] }).sessions.length;
  assert.equal((await post('/api/events?agent=claude', { hook_event_name: 'SubagentStop', session_id: 'x' })).status, 204);
  assert.equal((await post('/api/events?agent=claude', { hook_event_name: 'Stop' })).status, 204, 'no session id');
  const after_ = ((await (await fetch(`${base}/api/state`)).json()) as { sessions: unknown[] }).sessions.length;
  assert.equal(after_, before);
});

test('notify: validates input, defaults the level, and broadcasts', async () => {
  assert.equal((await post('/api/notify', {})).status, 400);
  assert.equal((await post('/api/notify', { title: '' })).status, 400);
  assert.equal((await post('/api/notify', '{')).status, 400);
  const ok = await post('/api/notify', { title: 'Deploy done', body: 'green', level: 'nonsense' });
  assert.equal(ok.status, 200);
  const notice = (await ok.json()) as { title: string; level: string; body: string; id: string };
  assert.deepEqual([notice.title, notice.body, notice.level], ['Deploy done', 'green', 'info']);
  assert.ok(notice.id);
  assert.equal(((await (await post('/api/notify', { title: 't', level: 'urgent' })).json()) as { level: string }).level, 'urgent');
});

test('SSE: a new viewer gets a snapshot first, then live updates', async () => {
  const res = await fetch(`${base}/api/stream`);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
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
  await post('/api/events?agent=codex', { hook_event_name: 'UserPromptSubmit', session_id: 'sse-1', cwd: '/w/sse' });
  await new Promise((r) => setTimeout(r, 200));
  await reader.cancel();
  await pump.catch(() => {});
  const msgs = [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
  assert.equal(msgs[0].type, 'snapshot');
  assert.ok(msgs.some((m) => m.type === 'session' && m.session.id === 'sse-1' && m.session.status === 'working'));
  assert.ok(typeof msgs[0].now === 'number', 'server clock is sent for skew-free timers');
});

const skipLan = lan ? false : 'no LAN interface on this machine';

test('LAN: hook ingest and notify are loopback-only', { skip: skipLan }, async () => {
  assert.equal((await post('/api/events?agent=claude', { hook_event_name: 'Stop', session_id: 'lan' }, lanBase)).status, 403);
  assert.equal((await post('/api/notify', { title: 'spoof' }, lanBase)).status, 403);
});

test('LAN: every viewer route needs the token; the phone UI itself does not (it holds no data)', { skip: skipLan }, async () => {
  for (const path of ['/api/state', '/api/stream', '/api/transcript?agent=claude&id=x']) {
    assert.equal((await fetch(`${lanBase}${path}`)).status, 401, `${path} without token`);
    assert.equal((await fetch(`${lanBase}${path}${path.includes('?') ? '&' : '?'}t=wrong`)).status, 401, `${path} wrong token`);
  }
  assert.equal((await fetch(`${lanBase}/api/state?t=${TOKEN}`)).status, 200);
  assert.equal((await fetch(`${lanBase}/`)).status, 200);
});

test('LAN viewers are counted while connected and dropped when they leave; loopback viewers are not counted', { skip: skipLan }, async () => {
  const seen: number[] = [];
  const off = server.onViewersChange((v) => seen.push(v.length));
  const loop = await fetch(`${base}/api/stream`);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.viewers().length, 0, 'the host window / curl are not phones');
  const phone = new AbortController();
  const res = await fetch(`${lanBase}/api/stream?t=${TOKEN}`, { signal: phone.signal, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 9) test-phone' } });
  await res.body!.getReader().read(); // snapshot arrived: the connection is registered
  assert.equal(server.viewers().length, 1);
  assert.match(server.viewers()[0].userAgent, /test-phone/);
  phone.abort();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(server.viewers().length, 0);
  assert.deepEqual(seen.slice(0, 2), [1, 0], 'notified on connect and on disconnect');
  off();
  await loop.body!.cancel();
});

test('setEnabledAgents drops the disabled agent’s sessions from the store and the stream', async () => {
  await post('/api/events?agent=codex', { hook_event_name: 'UserPromptSubmit', session_id: 'to-drop', cwd: '/w/d' });
  const has = async () => ((await (await fetch(`${base}/api/state`)).json()) as { sessions: { id: string }[] }).sessions.some((s) => s.id === 'to-drop');
  assert.equal(await has(), true);
  server.setEnabledAgents(['claude']);
  assert.equal(await has(), false);
  server.setEnabledAgents(AGENT_IDS);
});

test('stop() closes open streams so the port is really released', async () => {
  const p = PORT + 100;
  const s = createMonitorServer({ port: p });
  await s.start();
  const res = await fetch(`http://127.0.0.1:${p}/api/stream`);
  const reader = res.body!.getReader();
  await reader.read();
  await s.stop(); // must not hang on the open SSE connection
  await assert.rejects(fetch(`http://127.0.0.1:${p}/api/state`), 'nothing listens any more');
  await reader.cancel().catch(() => {});
});
