import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, summarizeToolInput } from './transcript.ts';

const j = (o: object) => JSON.stringify(o);

test('claude: prompts, tool calls, results and replies; thinking/meta/sidechain/injected are skipped', () => {
  const items = parseTranscript('claude', [
    j({ type: 'queue-operation' }),
    j({ type: 'user', message: { role: 'user', content: 'run the tests' } }),
    j({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise' } }),
    j({ type: 'user', message: { role: 'user', content: '<system-reminder>hidden</system-reminder>' } }),
    j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] } }),
    j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }, { type: 'tool_use', name: 'Bash', input: { command: 'pnpm test', description: 'x' } }] } }),
    j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok [32mpass[0m' }] } }),
    j({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent' }] } }),
    j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
    'not json at all',
  ]);
  assert.deepEqual(items, [
    { kind: 'user', text: 'run the tests' },
    { kind: 'assistant', text: 'On it.' },
    { kind: 'tool', tool: 'Bash', text: 'pnpm test' },
    { kind: 'result', text: 'ok pass' },
    { kind: 'assistant', text: 'done' },
  ]);
});

test('claude: tool_result content may be a list of text blocks', () => {
  const [r] = parseTranscript('claude', [
    j({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] } }),
  ]);
  assert.deepEqual(r, { kind: 'result', text: 'a\nb' });
});

test('codex: user_message, assistant message, tool call + output; developer/reasoning/agent_message skipped', () => {
  const items = parseTranscript('codex', [
    j({ type: 'session_meta', payload: {} }),
    j({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'secret rules' }] } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>' }] } }),
    j({ type: 'event_msg', payload: { type: 'user_message', message: 'fix the bug' } }),
    j({ type: 'response_item', payload: { type: 'reasoning' } }),
    j({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking.' }] } }),
    j({ type: 'event_msg', payload: { type: 'agent_message', message: 'Looking.' } }),
    j({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(await tools.exec_command({cmd:"rg --files -g \'*.ts\'", yield_time_ms: 1}))' } }),
    j({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: 'a.ts' }] } }),
    j({ type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: j({ command: ['ls', '-la'] }) } }),
  ]);
  assert.deepEqual(items, [
    { kind: 'user', text: 'fix the bug' },
    { kind: 'assistant', text: 'Looking.' },
    { kind: 'tool', tool: 'exec', text: "rg --files -g '*.ts'" },
    { kind: 'result', text: 'Script completed\na.ts' },
    { kind: 'tool', tool: 'shell', text: 'ls -la' },
  ]);
});

test('cursor: user text, assistant text, and tool calls; turn markers skipped', () => {
  const items = parseTranscript('cursor', [
    j({ role: 'user', message: { content: [{ type: 'text', text: 'add cursor support' }] } }),
    j({ role: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Shell', input: { command: 'pnpm test' } }] } }),
    j({ type: 'turn_ended', status: 'success' }),
    j({ role: 'assistant', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    'not json',
  ]);
  assert.deepEqual(items, [
    { kind: 'user', text: 'add cursor support' },
    { kind: 'assistant', text: 'Looking.' },
    { kind: 'tool', tool: 'Shell', text: 'pnpm test' },
    { kind: 'result', text: 'ok' },
  ]);
});

test('long text is truncated and tool summaries take the first line only', () => {
  const [u] = parseTranscript('claude', [j({ type: 'user', message: { role: 'user', content: 'x'.repeat(9000) } })]);
  assert.equal(u.text.length, 4001);
  assert.ok(u.text.endsWith('…'));
  assert.equal(summarizeToolInput({ command: 'echo a\necho b' }), 'echo a');
  assert.equal(summarizeToolInput({ file_path: '/a/b.ts', old_string: 'zzz' }), '/a/b.ts');
  assert.equal(summarizeToolInput({ weird: 1 }), '{"weird":1}');
});

test('codex: unwraps the exec envelope to the real output and flags non-zero exits', () => {
  const env = (o: object) => [
    { type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
    { type: 'input_text', text: JSON.stringify(o) },
  ];
  const out = (output: unknown) => j({ type: 'response_item', payload: { type: 'custom_tool_call_output', output } });
  const items = parseTranscript('codex', [
    out(env({ chunk_id: 'a', exit_code: 0, output: 'total 96\nfile.ts' })),
    out(env({ chunk_id: 'b', exit_code: 2, output: 'boom' })),
    out('plain string result'),
  ]);
  assert.deepEqual(items.map((i) => i.text), ['total 96\nfile.ts', 'boom\n[exit 2]', 'plain string result']);
});
