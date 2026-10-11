# Setting up agent-monitor

- [First Time Install](#first-time-install)
- [Updating](#updating)

## First Time Install

**You need:** a Mac with macOS, Node 24+ and pnpm (`corepack enable` turns pnpm on), and a phone on the same Wi-Fi.

### 1. Install and launch

```bash
git clone https://github.com/jonyfridja/agent-monitor.git
cd agent-monitor
pnpm install
pnpm host
```

`pnpm host` starts the menu-bar app and returns. You can close the terminal: the app keeps running.

### 2. Choose a password

The window opens to a setup screen, and phones can't connect until you set a password. The window checks it as you type:

- at least 10 characters
- upper- and lowercase letters
- a number
- a symbol
- no common words or repeated characters
- both entries match

### 3. Connect your agents

The next screen has an **Install hooks** button for each agent (Claude Code, Codex). Click the ones you use. Nothing is written to their config until you click, and a backup of each file is made first.

You can skip this step and do it later from the window, or from the terminal with `pnpm hooks install`.

### 4. Restart running agent sessions

Agents read hooks only when a session starts, so restart any Claude Code or Codex sessions that were already open.

### 5. Connect the phone

1. Scan the QR code in the window (menu-bar icon → **Open window**).
2. The certificate is self-signed, so the browser warns once. Choose **Advanced → Proceed** (Chrome) or **Show Details → visit this website** (Safari).
3. Log in with your password. The phone stays logged in for 30 days.
4. Tap the screen once so the browser allows alert sounds. Theme and alert options are behind ⚙.

### Optional: start at login

`pnpm host` doesn't come back after a reboot. To have it start at login, use the packaged app:

```bash
pnpm package    # → apps/host/release/agent-monitor-darwin-arm64/agent-monitor.app
```

Copy `agent-monitor.app` to `/Applications`, open it, and tick **Launch at login** in its window.

### Stopping and removing

| To | Do |
|---|---|
| Quit | Menu-bar icon → **Quit**, or `pnpm stop` |
| Remove the hooks | `pnpm hooks uninstall`, or **Uninstall** in the window |
| Remove everything | Remove the hooks first, then delete the repo folder and `~/.agent-monitor` |

## Updating

Your settings, password, hooks and certificate live outside the repo (in `~/.agent-monitor` and the agents' config files), so updating keeps them.

### 1. Stop the running app

```bash
pnpm stop
```

### 2. Get the new version

```bash
git pull
pnpm install
```

### 3. Start it again

```bash
pnpm host
```

`pnpm host` rebuilds the app every time it starts, so there's no separate build step. Phones reconnect by themselves and stay logged in.

If you use the packaged app instead, rebuild it with `pnpm package`, replace the copy in `/Applications` with the new `agent-monitor.app`, and open it.

### 4. Check the hooks

```bash
pnpm hooks
```

- Both `installed`: nothing to do.
- `wrong-port` (you changed the port), or the release notes say the hook command changed: run `pnpm hooks install`, then restart running agent sessions. Reinstalling replaces agent-monitor's own entries and leaves yours alone.

### Updating from a version without a password

Versions before password protection need two extra steps:

- On launch, the window shows the password setup screen. Choose a password before phones can connect.
- Older versions installed hooks automatically. They keep working, and `pnpm hooks` shows their status. From now on, hooks change only when you ask.

Phones paired with the old QR link need to log in once with the new password.
