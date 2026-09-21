import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMonitorServer } from './server.ts';
import { looksLikeAgentMonitor, probeAgentMonitor } from './probe.ts';

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () =>
      resolve({ port: (s.address() as AddressInfo).port, close: () => new Promise((r) => (s.closeAllConnections(), s.close(() => r()))) }),
    );
  });

test('looksLikeAgentMonitor only accepts the /api/state shape', () => {
  assert.equal(looksLikeAgentMonitor({ now: 1, sessions: [] }), true);
  for (const bad of [null, undefined, 'x', 42, {}, { now: 1 }, { sessions: [] }, { now: '1', sessions: [] }, { now: 1, sessions: {} }]) {
    assert.equal(looksLikeAgentMonitor(bad), false, JSON.stringify(bad));
  }
});

test('recognises a real agent-monitor server', async () => {
  const port = 47700 + Math.floor(Math.random() * 90);
  const server = createMonitorServer({ port, token: 'secret' }); // token only guards non-loopback callers
  await server.start();
  try {
    assert.equal(await probeAgentMonitor(port), true);
  } finally {
    await server.stop();
  }
});

test('does not recognise other services, and never throws', async () => {
  const web = await listen((_req, res) => res.end('<html>hello</html>'));
  const json = await listen((_req, res) => res.setHeader('content-type', 'application/json').end('{"ok":true}'));
  const slow = await listen(() => {}); // accepts, never answers
  const gone = await listen((_req, res) => res.end());
  await gone.close();
  try {
    assert.equal(await probeAgentMonitor(web.port), false);
    assert.equal(await probeAgentMonitor(json.port), false);
    assert.equal(await probeAgentMonitor(slow.port, 200), false);
    assert.equal(await probeAgentMonitor(gone.port), false); // connection refused
  } finally {
    await Promise.all([web.close(), json.close(), slow.close()]);
  }
});
