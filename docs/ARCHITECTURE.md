# Architecture

```text
BrowserWindow (frameless shell)
├─ shell.html
│  └─ preload.js -> narrow window-control IPC
└─ WebContentsView
   └─ http://127.0.0.1:<random port> (official Harness UI)
        └─ bundled Node runtime runs @deepseek-ai/dsh web --port 0
```

## Why two renderers?

The frameless `BrowserWindow` owns the trusted title bar. The official Harness
page is attached as a separate `WebContentsView` below it. This prevents the
remote-style local web application from receiving Electron or Node.js access
while keeping the native window controls responsive.

## Startup

1. Electron creates the hidden frameless shell and loads `shell.html`.
2. The shell is shown with a lightweight startup view.
3. The main process starts the pinned Node.js runtime with
   `@deepseek-ai/dsh web --port 0`.
4. It parses the loopback URL printed by Harness.
5. A sandboxed `WebContentsView` loads that URL and fills the area below the
   42-pixel title bar.

## Shutdown

`before-quit` stops the child Harness process. The application uses a
single-instance lock so a second launch activates the existing window instead
of starting a second local service.

## Platform differences (Windows / macOS)

- `main.js` selects `runtime/node.exe` on Windows and `runtime/node` on macOS;
  the cross-platform `scripts/prepare-runtime.mjs` downloads and double-checks
  the matching Node.js 24.19.0 archive (pinned SHA-256 + official
  `SHASUMS256.txt`).
- Windows removes the application menu; macOS installs a minimal app menu
  (About/Hide/Quit, Edit, Window) so Cmd+Q and clipboard shortcuts keep
  working, and sets the dock icon from `build/icon.png`.
- macOS packaging uses `build/icon.icns`; `scripts/build.sh` builds the host
  architecture dmg, ad-hoc signs the `.app`, and rebuilds the dmg from the
  signed bundle.
- The screenshot QA hook has a documented macOS branch: without a Screen
  Recording grant it logs `macOS screen capture unavailable` and continues
  instead of failing the run.

## HarmonyOS thin client

The `harmonyos/` DevEco project is a separate renderer, not an Electron build:

```text
HarmonyOS device/emulator                  Host PC (Windows/macOS)
┌───────────────────────────────┐         ┌────────────────────────────┐
│ ArkWeb Web component          │   LAN   │ dsh web bound to 0.0.0.0   │
│ http://<PC-LAN-IP>:8080       │ ──────▶ │ profile patch: webserver   │
│ (settings page stores URL)    │         │ official UI + tool runtime │
└───────────────────────────────┘         └────────────────────────────┘
```

The host binding is an explicit user-level `cordis.patch.yml` override of the
`webserver` composition line — the `dsh web --host 0.0.0.0` CLI path is
intentionally rejected upstream. Binding `0.0.0.0` auto-trusts LAN IPv4
literals in the `/api` browser trust fence; hostname access needs
`--trusted-host`. The ArkTS app persists only the host URL via Preferences,
shows connection state, and offers retry on error.

## Trust boundaries

- `shell.html` is packaged application code and may access only the API exposed
  by `preload.js`.
- Harness content has no preload script and no Node.js integration.
- IPC messages are accepted only when their sender is the shell web contents.
- Navigation remains inside the discovered loopback origin; ordinary external
  HTTP(S) links open in the system browser.
