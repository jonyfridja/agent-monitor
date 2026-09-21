// Builds release/agent-monitor-darwin-<arch>/agent-monitor.app (run via `pnpm package`).
// The main process is already bundled by esbuild, so the app ships only dist/, renderer/ and the phone web client.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronVersion = require('electron/package.json').version;

const [appPath] = await packager({
  dir: root,
  out: join(root, 'release'),
  overwrite: true,
  name: 'agent-monitor',
  appBundleId: 'dev.agent-monitor.host',
  appCategoryType: 'public.app-category.developer-tools',
  platform: 'darwin',
  arch: process.arch,
  electronVersion,
  icon: join(root, 'build', 'icon.icns'),
  // The phone client is served from real files: lands in agent-monitor.app/Contents/Resources/public.
  extraResource: [resolve(root, '../../packages/web/public')],
  // Menu-bar utility: no Dock icon / app-switcher entry unless the tray icon is hidden (see checkTray in main.ts).
  extendInfo: { LSUIElement: true, NSHumanReadableCopyright: 'agent-monitor' },
  asar: true,
  prune: false, // nothing to prune: deps are bundled into dist/main.cjs
  ignore: [/^\/node_modules($|\/)/, /^\/src($|\/)/, /^\/scripts($|\/)/, /^\/build($|\/)/, /^\/release($|\/)/, /^\/build\.mjs$/, /\.map$/],
});

const app = join(appPath, 'agent-monitor.app');
// Editing the bundle (icon, plist, asar) voids Electron's original signature, and Apple Silicon will not launch an
// unsigned-or-invalid bundle. Ad-hoc sign it: fine for running on this Mac; distributing to others needs a real identity.
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
console.log(`\nBuilt ${app}`);
