# Architecture

```text
BrowserWindow (frameless shell)                     remote.html window
├─ shell.html                                       ├─ remote switch + QR
│  └─ preload.js -> narrow window-control IPC       └─ preload.js (same bridge)
└─ WebContentsView
   └─ http://127.0.0.1:<port> (official Harness UI)
        └─ bundled Node runtime runs @deepseek-ai/dsh web
             (loopback `--port 0`, or 0.0.0.0 via webserver profile patch)
```

## Why two renderers?

The frameless `BrowserWindow` owns the trusted title bar. The official Harness
page is attached as a separate `WebContentsView` below it. This prevents the
remote-style local web application from receiving Electron or Node.js access
while keeping the native window controls responsive.

## Startup

1. Electron creates the hidden frameless shell and loads `shell.html`.
2. The shell is shown with a lightweight startup view.
3. The main process starts the pinned Node.js runtime with `dsh web`; the
   child's cwd is `<userData>/harness-home/workspace` so the default Harness
   workspace is a dedicated directory, not the user's whole home directory.
4. Loopback mode passes `--port 0`; phone-remote mode relies on a
   `<userData>/harness-home/profiles/web/cordis.patch.yml` override of the
   `webserver` composition line (`host: 0.0.0.0` + fixed port).
5. It parses the loopback URL (and the `(LAN: …)` URL in remote mode) printed
   by Harness.
6. A sandboxed `WebContentsView` loads the loopback URL and fills the area
   below the 42-pixel title bar.

## Tray-owned lifecycle and shutdown

Closing the main window hides it to the system tray; the Harness Host keeps
running so a phone can stay connected. The tray menu can reopen the window,
open the remote-access settings, or quit.

`requestAppQuit()` runs once: it stops the Host with SIGTERM and a bounded
grace period (5s), escalates to SIGKILL, destroys the tray, and only then
releases Electron's quit sequence (`before-quit` is intercepted until teardown
finishes). A single-instance lock makes a second launch activate the existing
window.

## Phone remote access

The remote window toggles a profile patch under the desktop-owned `DSH_HOME`:

- enable: append/replace the `webserver` entry with `host: 0.0.0.0`, fixed
  port, restart the Host, reload the content view, and show the LAN URL + QR;
- disable: remove the `webserver` entry (other patch entries are preserved),
  restart the Host in loopback mode.

The dsh output line `dsh web: http://127.0.0.1:<port> (LAN: http://<ip>:<port>)`
is parsed line by line; the local URL feeds the content view and the LAN URL
feeds the QR/address UI. If a mode switch fails, the patch and the loopback
Host are rolled back.

## Platform differences (Windows / macOS)

- `main.js` selects `runtime/node.exe` on Windows and `runtime/node` on macOS;
  the cross-platform `scripts/prepare-runtime.mjs` downloads and double-checks
  the matching Node.js 24.19.0 archive (pinned SHA-256 + official
  `SHASUMS256.txt`), supports `--arch x64|arm64`, and verifies the existing
  binary's architecture from the PE/Mach-O header before reuse.
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
│ ArkWeb Web component          │   LAN   │ desktop tray-owned Host     │
│ http://<PC-LAN-IP>:8787       │ ──────▶ │ (or standalone dsh web)     │
│ (settings page stores URL)    │         │ official UI + tool runtime │
└───────────────────────────────┘         └────────────────────────────┘
```

The desktop remote switch is the recommended path: it writes the same
`cordis.patch.yml` override documented for standalone `dsh web`. Binding
`0.0.0.0` auto-trusts LAN IPv4 literals in the `/api` browser trust fence;
hostname access needs `--trusted-host`. The ArkTS app persists only the host
URL via Preferences, shows connection state, and offers retry on error.

## Trust boundaries

- `shell.html` and `remote.html` are packaged application code and may access
  only the API exposed by `preload.js`.
- Harness content has no preload script and no Node.js integration.
- IPC messages are accepted only when their sender is the shell or the remote
  settings window.
- Navigation remains inside the discovered loopback origin; ordinary external
  HTTP(S) links open in the system browser.
