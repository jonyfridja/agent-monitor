import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, nativeTheme, screen, Tray } from 'electron';
import QRCode from 'qrcode';
import { AGENT_IDS, AGENT_LABELS, type AgentId, type Session } from '@agent-monitor/protocol';
import { Controller, type HostState } from './controller.ts';
import { phonePng, TRAY_COLORS } from './icons.ts';

// esbuild bundles this to dist/main.cjs, so __dirname is apps/host/dist.
const webDir = app.isPackaged ? join(process.resourcesPath, 'public') : resolve(__dirname, '../../../packages/web/public');
const controller = new Controller({ webDir });

let tray: Tray | undefined;
let win: BrowserWindow | undefined;
let quitting = false;
let trayHidden = false;
let qrFor: string | null = null;
let qrData: string | null = null;

// ---- state shared with the window ----
async function viewState() {
  const state = controller.state();
  if (state.phoneUrl !== qrFor) {
    qrFor = state.phoneUrl;
    qrData = state.phoneUrl ? await QRCode.toDataURL(state.phoneUrl, { margin: 1, width: 240 }) : null;
  }
  return { ...state, qr: qrData, packaged: app.isPackaged, trayHidden };
}

// ---- tray ----
type Level = keyof typeof TRAY_COLORS;
const icons = new Map<string, Electron.NativeImage>();

function icon(level: Level | 'off'): Electron.NativeImage {
  // The glyph follows the system appearance (light on dark, dark on light); the status badge is always colored.
  const dark = nativeTheme.shouldUseDarkColors;
  const cacheKey = `${level}:${dark}`;
  let img = icons.get(cacheKey);
  if (!img) {
    const fg = dark ? ([245, 245, 247] as const) : ([29, 29, 31] as const);
    const png = level === 'off' ? phonePng(36, { fg, alpha: 0.5 }) : phonePng(36, { fg, badge: TRAY_COLORS[level] });
    // 36px PNG at scale factor 2 → an 18pt menu-bar icon.
    img = nativeImage.createFromBuffer(png, { scaleFactor: 2 });
    icons.set(cacheKey, img);
  }
  return img;
}

function worst(sessions: Session[]): { level: Level; needsMe: number } {
  const live = sessions.filter((s) => s.status !== 'ended');
  const needsMe = live.filter((s) => s.status === 'waiting' && (s.reason === 'approval' || s.reason === 'your-turn')).length;
  if (live.some((s) => s.reason === 'approval')) return { level: 'approval', needsMe };
  if (needsMe) return { level: 'turn', needsMe };
  if (live.some((s) => s.status === 'working')) return { level: 'working', needsMe };
  return { level: 'idle', needsMe };
}

const label = (s: Session): string => {
  const what = s.status === 'working' ? 'working' : s.reason === 'approval' ? 'needs approval' : s.reason === 'your-turn' ? 'your turn' : s.status === 'ended' ? 'ended' : 'idle';
  return `${AGENT_LABELS[s.agent]} · ${s.name ?? s.project} — ${what}`;
};

function updateTray(state: HostState): void {
  if (!tray) return;
  const { level, needsMe } = worst(state.sessions);
  tray.setImage(icon(state.running ? level : 'off'));
  tray.setTitle(state.running && needsMe ? ` ${needsMe}` : '');
  const live = state.sessions.filter((s) => s.status !== 'ended');
  tray.setToolTip(state.running ? `agent-monitor · ${live.length} sessions · ${state.viewers.length} phones` : 'agent-monitor (server stopped)');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: state.running
          ? `${live.length} session${live.length === 1 ? '' : 's'} · ${state.viewers.length} phone${state.viewers.length === 1 ? '' : 's'} connected`
          : state.error ?? 'Server stopped',
        enabled: false,
      },
      ...(state.needsPassword ? [{ label: 'Set a phone password to start…', click: showWindow }] : []),
      ...live.slice(0, 8).map((s) => ({ label: label(s), enabled: false })),
      { type: 'separator' },
      { label: 'Open window', click: showWindow },
      { label: 'Copy phone URL', enabled: !!state.phoneUrl, click: () => state.phoneUrl && clipboard.writeText(state.phoneUrl) },
      { type: 'separator' },
      state.running
        ? { label: 'Stop server', click: () => void controller.stopServer() }
        : { label: 'Start server', click: () => void controller.startServer() },
      { type: 'separator' },
      { label: 'Quit agent-monitor', click: () => app.quit() },
    ]),
  );
}

/**
 * macOS parks a status item off-screen (x < 0) when the menu bar has no room for it — a full bar, the notch —
 * or when it is switched off under System Settings → Menu Bar. Nothing in the app can tell the user otherwise,
 * so fall back to a Dock icon + the window, and go back to tray-only once the icon becomes visible.
 */
function checkTray(): void {
  if (!tray || process.platform !== 'darwin') return;
  const b = tray.getBounds();
  const onScreen = screen.getAllDisplays().some((d) => b.width > 0 && b.x >= d.bounds.x && b.x + b.width <= d.bounds.x + d.bounds.width);
  if (onScreen === !trayHidden) return; // no change
  trayHidden = !onScreen;
  if (trayHidden) {
    app.dock?.show();
    showWindow();
  } else {
    app.dock?.hide();
  }
  void viewState().then((s) => win?.webContents.send('state', s));
}

// ---- window ----
function showWindow(): void {
  if (!win) {
    win = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'agent-monitor',
      backgroundColor: '#0b0d10',
      show: false,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    void win.loadFile(join(__dirname, '../renderer/index.html'));
    win.once('ready-to-show', () => win?.show());
    // Closing the window keeps the app (and server) alive in the tray.
    win.on('close', (e) => {
      if (quitting) return;
      e.preventDefault();
      win?.hide();
    });
  } else {
    win.show();
  }
  void controller.refreshHooks(); // the user may have edited the hook files by hand
  win.focus();
  app.focus({ steal: true });
}

// ---- lifecycle ----
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // Dock icon click (shown only when the tray icon is hidden)

  ipcMain.handle('state', viewState);
  ipcMain.handle('agent:set', (_e, id: AgentId, enabled: boolean) => AGENT_IDS.includes(id) && controller.setAgentEnabled(id, enabled));
  ipcMain.handle('hooks:install', (_e, id: AgentId) => AGENT_IDS.includes(id) && controller.installHooks(id));
  ipcMain.handle('hooks:uninstall', (_e, id: AgentId) => AGENT_IDS.includes(id) && controller.uninstallHooks(id));
  ipcMain.handle('hooks:refresh', () => controller.refreshHooks());
  ipcMain.handle('server:start', () => controller.startServer());
  ipcMain.handle('server:stop', () => controller.stopServer());
  ipcMain.handle('url:copy', () => {
    const url = controller.state().phoneUrl;
    if (url) clipboard.writeText(url);
  });
  // Resolves to an error message (or null) instead of rejecting: IPC rejections arrive as noisy wrapped errors.
  ipcMain.handle('password:set', (_e, value: unknown) =>
    controller.setPassword(typeof value === 'string' ? value : '').then(
      () => null,
      (err: Error) => err.message,
    ),
  );
  ipcMain.handle('transcripts:set', (_e, value: boolean) => controller.setShareTranscripts(!!value));
  ipcMain.handle('login:set', async (_e, value: boolean) => {
    await controller.setLaunchAtLogin(value);
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: value }); // dev would register the bare Electron binary
  });
  ipcMain.handle('app:quit', () => app.quit());

  void app.whenReady().then(async () => {
    const dockIcon = join(__dirname, '../build/icon.png'); // dev only: the packaged .app carries icon.icns
    if (existsSync(dockIcon)) app.dock?.setIcon(nativeImage.createFromPath(dockIcon));
    app.dock?.hide(); // tray-only, like a menu-bar utility
    tray = new Tray(icon('off'));
    nativeTheme.on('updated', () => {
      icons.clear(); // re-draw the glyph for the new appearance
      updateTray(controller.state());
    });
    controller.on('change', async (state: HostState) => {
      updateTray(state);
      win?.webContents.send('state', await viewState());
    });
    await controller.init();
    updateTray(controller.state());
    setTimeout(checkTray, 1500); // let macOS lay the status item out first
    setInterval(checkTray, 5000); // it moves back on-screen when the user frees up menu-bar space
    // Nothing visible on launch except the tray icon; open the window only when something needs attention.
    // First run (no password chosen yet) or a problem: open the window; otherwise stay quietly in the tray.
    if (controller.state().error || controller.state().needsPassword) showWindow();
  });

  // Release the port and stop the server before exiting.
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void controller.shutdown().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => {}); // stay resident
}
