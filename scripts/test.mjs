// `pnpm test` / `pnpm test:coverage` — the single definition of "the test suite", used locally and by CI.
//   node scripts/test.mjs               run everything
//   node scripts/test.mjs --coverage    run everything and enforce the coverage floor (the release gate)
// Globs are handed to `node --test` itself (Node expands them), so this behaves the same on macOS, Linux and Windows.
import { spawnSync } from 'node:child_process';

const GLOBS = [
  'packages/*/src/**/*.test.ts',
  'apps/*/src/**/*.test.ts',
  'scripts/*.test.mjs',
  'packages/web/test/*.test.mjs',
];

// Just under the measured numbers (97.8 / 92.1 / 92.9 when set): blocks regressions without being brittle.
// Only files the tests load are measured; GUI code (tray/window) is covered by the smoke test instead.
const FLOOR = { lines: 92, branches: 85, functions: 85 };

const coverage = process.argv.includes('--coverage');
const args = ['--test'];
if (coverage) {
  args.push(
    '--experimental-test-coverage',
    '--test-coverage-exclude=**/*.test.ts',
    '--test-coverage-exclude=**/*.test.mjs',
    `--test-coverage-lines=${FLOOR.lines}`,
    `--test-coverage-branches=${FLOOR.branches}`,
    `--test-coverage-functions=${FLOOR.functions}`,
  );
}
args.push(...GLOBS);

const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
