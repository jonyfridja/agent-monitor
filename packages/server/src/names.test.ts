import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NameResolver, type NameSources } from './names.ts';

let dir: string;
let src: NameSources;
const write = (path: string, data: unknown) => writeFile(path, typeof data === 'string' ? data : JSON.stringify(data));

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'am-names-'));
  src = {
    claudeSessionsDir: join(dir, 'sessions'),
    claudeDesktopDir: join(dir, 'desktop'),
    codexIndex: join(dir, 'session_index.jsonl'),
    cursorChatsDir: join(dir, 'cursor-chats'),
  };
  await mkdir(src.claudeSessionsDir);
  await mkdir(join(src.claudeDesktopDir!, 'acct', 'ws'), { recursive: true });

  await write(join(src.claudeSessionsDir, '1.json'), { pid: 1, sessionId: 'user-named', name: 'My Feature', nameSource: 'user' });
  await write(join(src.claudeSessionsDir, '2.json'), { pid: 2, sessionId: 'derived-only', name: 'jonyfridja-81', nameSource: 'derived' });
  await write(join(src.claudeSessionsDir, '3.json'), { pid: 3, sessionId: 'both', name: 'File Name', nameSource: 'user' });
  await write(join(src.claudeDesktopDir!, 'acct', 'ws', 'local_x.json'), { cliSessionId: 'both', title: 'Desktop Title' });
  await write(join(src.claudeDesktopDir!, 'acct', 'ws', 'scheduled-tasks.json'), { cliSessionId: 'ignored', title: 'Not a session' });

  await write(join(dir, 'custom.jsonl'), [
    { type: 'ai-title', aiTitle: 'Auto title', sessionId: 'c' },
    { type: 'custom-title', customTitle: 'Renamed by user', sessionId: 'c' },
    { type: 'ai-title', aiTitle: 'Newer auto title', sessionId: 'c' },
  ].map((o) => JSON.stringify(o)).join('\n'));
  await write(join(dir, 'untitled.jsonl'), [{ type: 'user', message: { role: 'user', content: 'hi' } }].map((o) => JSON.stringify(o)).join('\n'));
  const filler = JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } });
  await write(join(dir, 'long.jsonl'), [JSON.stringify({ type: 'custom-title', customTitle: 'Original title' }), ...Array(700).fill(filler)].join('\n')); // ~700 KB: past the 512 KB tail
  await write(join(dir, 'ai.jsonl'), [{ type: 'user' }, { type: 'ai-title', aiTitle: 'Only  auto\ntitle' }].map((o) => JSON.stringify(o)).join('\n'));

  await mkdir(join(src.cursorChatsDir, 'ws', 'conv-1'), { recursive: true });
  await write(join(src.cursorChatsDir, 'ws', 'conv-1', 'meta.json'), { title: 'Cursor Chat', cwd: '/w/p' });
  await mkdir(join(src.cursorChatsDir, 'ws', 'blank'), { recursive: true });
  await write(join(src.cursorChatsDir, 'ws', 'blank', 'meta.json'), { title: '   ' });
  await write(join(src.cursorChatsDir, 'ws', 'not-a-chat.txt'), 'skip');

  await write(src.codexIndex, [
    { id: 'x1', thread_name: 'First name', updated_at: 'a' },
    { id: 'x2', thread_name: 'Other thread' },
    { id: 'x1', thread_name: 'Renamed thread', updated_at: 'b' },
    { id: 'x3', thread_name: '' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\nnot json\n');
});
after(() => rm(dir, { recursive: true, force: true }));

test("claude: the transcript's own title beats the session file name (a CLI started inside the desktop app inherits the host's name there)", async () => {
  // Real case: session file says "My Feature" (inherited), the transcript / terminal tab says "Renamed by user".
  assert.equal(await new NameResolver(src, 0).resolve('claude', 'user-named', join(dir, 'custom.jsonl')), 'Renamed by user');
});

test('claude: the session file name is the fallback when the transcript carries no title', async () => {
  const r = new NameResolver(src, 0);
  assert.equal(await r.resolve('claude', 'user-named'), 'My Feature');
  assert.equal(await r.resolve('claude', 'user-named', join(dir, 'untitled.jsonl')), 'My Feature');
});

test('claude: a title that fell out of the tail window is still found at the head of a long transcript', async () => {
  assert.equal(await new NameResolver(src, 0).resolve('claude', 'nobody', join(dir, 'long.jsonl')), 'Original title');
});

test('claude: the desktop app title beats the session file name', async () => {
  assert.equal(await new NameResolver(src, 0).resolve('claude', 'both'), 'Desktop Title');
});

test('claude: auto-generated (derived) names are not used; falls back to the transcript titles', async () => {
  const r = new NameResolver(src, 0);
  assert.equal(await r.resolve('claude', 'derived-only'), undefined);
  assert.equal(await r.resolve('claude', 'derived-only', join(dir, 'custom.jsonl')), 'Renamed by user'); // custom beats a newer ai title
  assert.equal(await r.resolve('claude', 'derived-only', join(dir, 'ai.jsonl')), 'Only auto title'); // whitespace collapsed
});

test('claude: unknown session or missing sources resolve to undefined, never throw', async () => {
  assert.equal(await new NameResolver(src, 0).resolve('claude', 'nope'), undefined);
  const missing = new NameResolver({ claudeSessionsDir: join(dir, 'gone'), codexIndex: join(dir, 'gone.jsonl'), cursorChatsDir: join(dir, 'gone-chats') }, 0);
  assert.equal(await missing.resolve('claude', 'x', join(dir, 'gone.jsonl')), undefined);
  assert.equal(await missing.resolve('codex', 'x'), undefined);
});

test('cursor: title from ~/.cursor/chats/<workspace>/<id>/meta.json; blank titles ignored', async () => {
  const r = new NameResolver(src, 0);
  assert.equal(await r.resolve('cursor', 'conv-1'), 'Cursor Chat');
  assert.equal(await r.resolve('cursor', 'blank'), undefined);
  assert.equal(await r.resolve('cursor', 'missing'), undefined);
});

test('codex: thread_name from the index; the latest line wins; blank names ignored', async () => {
  const r = new NameResolver(src, 0);
  assert.equal(await r.resolve('codex', 'x1'), 'Renamed thread');
  assert.equal(await r.resolve('codex', 'x2'), 'Other thread');
  assert.equal(await r.resolve('codex', 'x3'), undefined);
});

test('the index is cached within the ttl and re-read after it', async () => {
  const r = new NameResolver(src, 60_000);
  assert.equal(await r.resolve('codex', 'late'), undefined);
  await write(src.codexIndex, JSON.stringify({ id: 'late', thread_name: 'Appeared later' }) + '\n');
  assert.equal(await r.resolve('codex', 'late'), undefined); // still cached
  assert.equal(await new NameResolver(src, 0).resolve('codex', 'late'), 'Appeared later');
});
