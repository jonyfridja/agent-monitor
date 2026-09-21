import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { hookCommand } from '@agent-monitor/adapters';
import type { AgentId, Session } from '@agent-monitor/protocol';
import { createMonitorServer, type MonitorServer } from './index.ts';

/**
 * The whole point of the product in one test file: the exact command we write into an agent's hook config, run the way
 * the agent runs it (through a shell, payload on stdin), must land in the server as the right session state — and must
 * never fail, print, or stall the agent when the server is missing.
 */

const shells: Array<{ name: string; run: (command: string) => [string, string[]] }> =
  process.platform === 'win32'
    ? [] // Windows shells are added together with the Windows hook command (see Phase 1)
    : [{ name: 'sh', run: (command) => ['sh', ['-c', command]] }];

const hasCurl = spawnSync('curl', ['--version'], { stdio: 'ignore' }).status === 0;
const PORT = 47700 + Math.floor(Math.random() * 90);
let server: MonitorServer;

before(async () => {
  server = createMonitorServer({ port: PORT });
  await server.start();
});
after(() => server.stop());

const state = async (): Promise<Session[]> => ((await (await fetch(`http://127.0.0.1:${PORT}/api/state`)).json()) as { sessions: Session[] }).sessions;

/**
 * Run a hook the way an agent does. Async on purpose: the server under test lives in *this* process, and a blocking
 * spawnSync would freeze its event loop until curl's own timeout fired.
 */
function runHook(shell: (typeof shells)[number], agent: AgentId, port: number, payload: object) {
  const [cmd, args] = shell.run(hookCommand(agent, port));
  const started = Date.now();
  return new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const guard = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('close', (status) => {
      clearTimeout(guard);
      resolve({ status, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

for (const shell of shells) {
  test(`[${shell.name}] a real turn, hook by hook: working → approval → your turn → ended`, { skip: !hasCurl && 'curl not installed' }, async () => {
    const base = { session_id: `e2e-${shell.name}`, cwd: '/work/my-project', transcript_path: '/nonexistent.jsonl' };
    const step = async (event: string, extra: object, expected: Partial<Session>) => {
      const r = await runHook(shell, 'claude', PORT, { ...base, hook_event_name: event, ...extra });
      assert.equal(r.status, 0, `${event}: hook exited ${r.status} — ${r.stderr}`);
      assert.equal(r.stdout + r.stderr, '', `${event}: a hook must be silent`);
      assert.ok(r.ms < 800, `${event}: a healthy hook must not wait on its timeout (took ${r.ms}ms)`);
      const s = (await state()).find((x) => x.id === base.session_id);
      assert.ok(s, `${event}: session not found`);
      for (const [k, v] of Object.entries(expected)) assert.equal(s[k as keyof Session], v, `${event}: ${k}`);
    };
    await step('SessionStart', {}, { status: 'waiting', reason: 'idle', project: 'my-project', agent: 'claude' });
    await step('UserPromptSubmit', {}, { status: 'working' });
    await step('PreToolUse', { tool_name: 'Bash' }, { status: 'working' });
    await step('PermissionRequest', {}, { status: 'waiting', reason: 'approval' });
    await step('PostToolUse', { tool_name: 'Bash' }, { status: 'working' }); // approved: back to work
    await step('Stop', {}, { status: 'waiting', reason: 'your-turn' });
    await step('SessionEnd', {}, { status: 'ended' });
  });

  test(`[${shell.name}] the same command works for the Codex flavour`, { skip: !hasCurl && 'curl not installed' }, async () => {
    const r = await runHook(shell, 'codex', PORT, { hook_event_name: 'UserPromptSubmit', session_id: `e2e-codex-${shell.name}`, cwd: '/w/x' });
    assert.equal(r.status, 0);
    const s = (await state()).find((x) => x.id === `e2e-codex-${shell.name}`);
    assert.equal(s?.agent, 'codex');
    assert.equal(s?.status, 'working');
  });

  test(`[${shell.name}] server not running: the hook exits 0, prints nothing, and does not stall`, { skip: !hasCurl && 'curl not installed' }, async () => {
    const r = await runHook(shell, 'claude', 1, { hook_event_name: 'Stop', session_id: 'nobody-home', cwd: '/w' }); // port 1: nothing listens
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout + r.stderr, '');
    assert.ok(r.ms < 3000, `took ${r.ms}ms`);
  });

  test(`[${shell.name}] server hung (accepts, never answers): the hook gives up after ~1s, exit 0, silent`, { skip: !hasCurl && 'curl not installed' }, async () => {
    const hung: TcpServer = createTcpServer(() => {}); // accepts the connection and says nothing
    await new Promise<void>((r) => hung.listen(0, '127.0.0.1', () => r()));
    const port = (hung.address() as AddressInfo).port;
    try {
      const r = await runHook(shell, 'claude', port, { hook_event_name: 'Stop', session_id: 'hung', cwd: '/w' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout + r.stderr, '');
      assert.ok(r.ms >= 800 && r.ms < 4000, `expected ~1s timeout, took ${r.ms}ms`);
    } finally {
      hung.close();
    }
  });
}

test('the ingest endpoint rejects a hook payload for an agent we do not track, without breaking the hook', async () => {
  server.setEnabledAgents(['codex']);
  try {
    const r = await runHook(shells[0] ?? { name: 'none', run: () => ['true', []] }, 'claude', PORT, { hook_event_name: 'UserPromptSubmit', session_id: 'disabled-claude', cwd: '/w' });
    assert.equal(r.status, 0);
    assert.equal((await state()).some((s) => s.id === 'disabled-claude'), false);
  } finally {
    server.setEnabledAgents(['claude', 'codex']);
  }
});
