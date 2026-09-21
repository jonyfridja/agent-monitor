# agent-monitor

A tiny second screen for your coding agents. A tray app on your Mac runs a local server; an old phone (or any browser on your Wi-Fi) shows which agents are **working** and which are **waiting for you**. Local-only — nothing leaves your network. Supports **Claude Code** and **Codex**.

```
Claude Code ─┐ hook (curl, 1s cap, never blocks)
Codex        ─┴─► POST 127.0.0.1:47821/api/events ─► server ─► SSE ─► phone browser
                                                        └── tray app (Electron): sessions, phones, agent toggles
```

## Host app or `pnpm server`?

You only need **one**. The server (hooks in → live state → phone out) is the engine; the tray app *contains* that same server and adds the window, QR code, settings and tray icon. `pnpm server` runs the bare engine with no GUI — for development or a headless machine. Both use port 47821, so running both gives `EADDRINUSE` (the CLI now says which one is already running). Use `pnpm host` / the `.app` day to day.

## Run it

```bash
pnpm install
pnpm host          # tray app (menu-bar dot + window)
pnpm server        # or: headless server only (add --install to write hooks)
```

1. Launch the host. A dot appears in the menu bar (red = needs approval, green = your turn, amber = working, grey = idle; the number is how many need you).
2. **Open window** → scan the QR code / open the URL on the phone (same Wi-Fi).
3. Tap anywhere on the phone once per page load (browsers require it) to allow alert sound. Alert and theme options are behind the ⚙ icon.
4. **Restart any already-running agent sessions** — hooks are read at session start.

The host writes hooks into `~/.claude/settings.json` and `~/.codex/hooks.json` for enabled agents, alongside your existing hooks (a one-time `*.agent-monitor.bak` copy is made). Untick an agent, or remove hooks, and only agent-monitor's entries are removed. Hooks stay in place when the host is quit; they fail silently.

Settings (port, pairing token, enabled agents) persist in `~/.agent-monitor/config.json`.

## Build the .app

```bash
pnpm package      # → apps/host/release/agent-monitor-darwin-arm64/agent-monitor.app
```

Generates the icon, bundles the host, packages it with `@electron/packager`, and ad-hoc signs it (fine on the Mac that built it; giving it to others needs a real Developer ID). Copy it to `/Applications` to use it. It runs tray-only (`LSUIElement`), and **Launch at login** in its window works for the packaged app only.

`pnpm host` (dev) and the `.app` use the same port — run `pnpm stop` when switching between them.

## Icons

Tray: an outlined phone (the second screen) with a status badge — grey idle, amber working, green your turn, red needs approval — plus a count of sessions waiting on you. The glyph is drawn white or near-black to follow the system appearance and re-drawn when it changes; a stopped server shows the phone dimmed with no badge. The app icon is the same phone on a dark tile. Both are generated in code (`apps/host/src/icons.ts`, `apps/host/scripts/make-icon.mjs`) — no image assets to maintain; `pnpm package` regenerates the app icon.

## If you can't see the menu-bar icon

macOS parks a menu-bar item off-screen when the bar is full (the notch takes the middle of it) or when the app is switched off under **System Settings → Menu Bar → Allow in the Menu Bar**. The app detects this, shows a **Dock icon** and opens its window with a note; the tray icon returns by itself once there is room.

## Stop everything

```bash
pnpm stop              # SIGTERM, then SIGKILL after 3s: the tray app (dev or packaged) + helpers, and the headless server
pnpm stop --dry-run    # list what it would stop
```

Two independent routes find agent-monitor's processes, so a renamed `.app` or a different launcher can't hide one: by executable path, and by port (whatever listens there *and* answers `/api/state` like agent-monitor). If something else holds the port it is reported, never killed. `--port N` checks a custom port. If it still finds nothing but the port is busy, see the holder with `lsof -nP -iTCP:47821 -sTCP:LISTEN`.

## Session names

Each card is titled with the name the harness itself shows, with the project folder as the small label above it. Looked up on every hook event, so renames follow:

| Agent | Source (first match wins) |
|---|---|
| Claude Code | desktop app title (`~/Library/Application Support/Claude/claude-code-sessions`, macOS) → the transcript's own `customTitle` (`/rename`, `--name`), then `aiTitle` — exactly what the CLI puts in the terminal tab → the name in `~/.claude/sessions/*.json`, last |
| Codex | `thread_name` in `~/.codex/session_index.jsonl` |

Auto-generated names like `jonyfridja-81` are ignored, and the folder name is the fallback. The session-file name ranks last on purpose: a CLI started from a desktop-app terminal inherits the *host* session's name there, while its terminal tab shows its own title.

## Unread

When a session raises an alert you'd actually receive (needs approval, or finished — your turn), its card moves into an **Unread** section at the top with a colored ring and a **New** badge; everything else sits under **Other sessions**. With nothing unread the list is plain, with no headings. A card is read when you tap or open it, or when the agent moves on by itself (say you approved it on the Mac); **Mark all read** clears the section. Muted levels or Alerts-off (⚙) don't create unread. State is kept per phone in `localStorage`.

Session alerts don't pop a toast — the highlighted card is the notification (plus flash, sound and vibration if enabled). Custom notifications from `/api/notify` have no card, so they still show a toast.

## Phone settings (⚙)

Theme (System / Dark / Light), master **Alerts** switch, which events alert (needs approval / your turn / custom), and how (sound / vibration / screen flash), plus a test button. Saved in the phone's `localStorage`, so each device keeps its own.

## Live transcript

Tap a session on the phone to open a terminal-style live view of its conversation: your prompts, replies, tool calls and their (collapsed) output, following the latest activity. Tap a result to expand it; use back to return.

- Works for CLI **and** desktop-app sessions (both hand hooks a `transcript_path`); it is a transcript view, not a mirror of a terminal.
- The phone only names a session. The file path comes from the agent's own hook, must be a `.jsonl` inside `~/.claude` or `~/.codex` (symlinks resolved), and is never sent to the phone.
- It exposes prompts, code and command output to anyone with the pairing URL, so the host window has a **"Let the phone open a session's live transcript"** switch (default on).
- Already-running sessions get a transcript link on their next event.

## Custom notifications

```bash
curl -X POST localhost:47821/api/notify -H 'content-type: application/json' \
  -d '{"title":"Deploy done","body":"prod is green","level":"attention"}'   # info | attention | urgent
```

## Develop

```bash
pnpm test        # reducer, hook-file editing, adapters, host lifecycle (temp HOME, no real configs touched)
pnpm typecheck
```

| Path | What |
|---|---|
| `packages/protocol` | shared types |
| `packages/server` | HTTP + SSE server, pure `reduce()` state machine, config |
| `packages/adapters` | per-agent hook install/uninstall + payload → event mapping |
| `packages/web/public` | phone UI (no build step) |
| `apps/host` | Electron tray app; `controller.ts` holds all logic, `main.ts` is thin UI glue |

## Known limits

- Phone alerts are in-page (page must be visible). Android Chrome blocks service workers over plain HTTP; for real system notifications set `chrome://flags/#unsafely-treat-insecure-origin-as-secure` to `http://<mac-ip>:47821`.
- The phone screen can sleep (Wake Lock needs HTTPS): enable Android "Stay awake while charging".
- Esc-interrupting an agent may not fire a hook; such sessions show as idle after 10 minutes.
- The `.app` is ad-hoc signed and macOS-arm64 only for now (`process.arch` decides).
