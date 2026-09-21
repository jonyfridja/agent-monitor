import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ancestors, findTargets, parsePs, planStop } from './stop-lib.mjs';

const R = '/Users/me/personal/code/agent-monitor';
const ps = `
    1     0 /sbin/launchd
  100     1 /Applications/Claude.app/Contents/MacOS/Claude
  200   100 ${R}/node_modules/.pnpm/electron@39.8.10/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
  201   200 ${R}/node_modules/.pnpm/electron@39.8.10/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility
  300     1 /Users/me/Applications/agent-monitor.app/Contents/MacOS/agent-monitor
  301   300 /Users/me/Applications/agent-monitor.app/Contents/Frameworks/agent-monitor Helper (Renderer).app/Contents/MacOS/agent-monitor Helper (Renderer) --type=renderer
  400     1 node ${R}/packages/server/src/cli.ts
  500     1 /Users/me/other-project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
  501     1 /Applications/Claude.app/Contents/Helpers/claude --output-format stream-json
  502     1 node /Users/me/projects/my-monitor/server.js
  510     1 ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
  511   510 ${R}/node_modules/.pnpm/electron@39.8.10/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU) --type=gpu-process
  520     1 bash -lc ( node ${R}/packages/server/src/cli.ts & )
  521     1 /bin/zsh -c open ${R}/../Applications/agent-monitor.app/Contents/MacOS/agent-monitor
  522     1 vim ${R}/packages/server/src/cli.ts
  600   777 node ${R}/scripts/stop.mjs
  777     1 -zsh
`;

test('parsePs reads pid, ppid and the whole command line', () => {
  const procs = parsePs(ps);
  assert.equal(procs.length, 17);
  assert.deepEqual(procs.find((p) => p.pid === 400), { pid: 400, ppid: 1, command: `node ${R}/packages/server/src/cli.ts` });
});

test('selects the dev app + helpers, the packaged app + helpers and the headless server — nothing else', () => {
  const pids = findTargets(parsePs(ps), 600).map((t) => t.pid).sort((a, b) => a - b);
  assert.deepEqual(pids, [200, 201, 300, 301, 400, 510, 511]);
});

test("does not touch other Electron apps, Claude, unrelated node processes, or shells/editors that merely mention our paths", () => {
  const pids = findTargets(parsePs(ps), 600).map((t) => t.pid);
  for (const other of [1, 100, 500, 501, 502, 777, 520, 521, 522]) assert.ok(!pids.includes(other), `pid ${other}`);
});

test('a relative-path `electron .` main is found through its helper, and only ours', () => {
  const pids = findTargets(parsePs(ps), 600).map((t) => t.pid);
  assert.ok(pids.includes(510));
  assert.ok(!pids.includes(500)); // another project's Electron main stays alone
});

test('never targets itself or its ancestors, even if their command line matches', () => {
  // `pnpm stop` run from inside the app's own process tree: the script's parent chain is protected.
  const procs = parsePs(`
    50     1 ${R}/node_modules/.pnpm/electron@1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
    60    50 node ${R}/packages/server/src/cli.ts
    70    60 node ${R}/scripts/stop.mjs
    80     1 node ${R}/packages/server/src/cli.ts
  `);
  assert.deepEqual([...ancestors(procs, 70)].sort((x, y) => x - y), [1, 50, 60, 70]);
  assert.deepEqual(findTargets(procs, 70).map((t) => t.pid), [80]);
});

test('empty or garbage input yields no targets', () => {
  assert.deepEqual(findTargets(parsePs(''), 1), []);
  assert.deepEqual(findTargets(parsePs('not a ps line\n\n'), 1), []);
});

test('planStop: a port owner that answers like agent-monitor is stopped even when no path pattern matches it', () => {
  // A renamed copy / odd launcher: nothing in `ps` looks like ours, but it serves /api/state on :47821.
  const procs = parsePs(`
    900     1 /opt/somewhere/Totally Different Name.app/Contents/MacOS/thing
    901   900 /opt/somewhere/Totally Different Name.app/Contents/MacOS/thing --helper
    600   777 node ${R}/scripts/stop.mjs
    777     1 -zsh
  `);
  assert.deepEqual(findTargets(procs, 600), []); // path matching alone misses it
  const { targets, foreign } = planStop({ procs, selfPid: 600, portOwners: [{ port: 47821, pid: 900, ours: true }] });
  assert.deepEqual(targets.map((t) => [t.pid, t.kind]), [[900, 'agent-monitor on :47821 (found by port)']]);
  assert.deepEqual(foreign, []);
});

test('planStop: a foreign process on the port is reported, never targeted', () => {
  const procs = parsePs('  50   1 python3 -m http.server 47821\n  600 777 node stop.mjs\n  777 1 -zsh');
  const { targets, foreign } = planStop({ procs, selfPid: 600, portOwners: [{ port: 47821, pid: 50, command: 'Python', ours: false }] });
  assert.deepEqual(targets, []);
  assert.deepEqual(foreign.map((f) => f.pid), [50]);
});

test('planStop: no duplicates when both routes find the same process; own ancestors are never targeted', () => {
  const procs = parsePs(`
    200   100 ${R}/node_modules/.pnpm/electron@1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
    600   200 node ${R}/scripts/stop.mjs
  `);
  // 200 matches by path AND owns the port — but it is also our ancestor here, so it must be left alone.
  const both = planStop({ procs, selfPid: 600, portOwners: [{ port: 47821, pid: 200, ours: true }] });
  assert.deepEqual(both.targets, []);
  const procs2 = parsePs(`200 1 ${R}/node_modules/.pnpm/electron@1/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .\n 600 777 node stop.mjs\n 777 1 -zsh`);
  const dup = planStop({ procs: procs2, selfPid: 600, portOwners: [{ port: 47821, pid: 200, ours: true }] });
  assert.deepEqual(dup.targets.map((t) => t.pid), [200]);
  assert.equal(dup.targets[0].kind, 'host app (dev)'); // path route wins; not listed twice
});
