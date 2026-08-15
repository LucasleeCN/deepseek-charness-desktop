# DeepSeek Harness Desktop

[中文](README.md)

An open-source, unofficial desktop client for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) covering three
platforms:

| Platform | Form | Status |
| --- | --- | --- |
| Windows | Electron installer + portable exe | ✅ shipped |
| macOS | Electron `.dmg` (x64 / arm64, ad-hoc signed) | ✅ code + CI ready; dmg produced on macOS/CI |
| HarmonyOS | DevEco ArkTS thin client (ArkWeb loads the LAN host) | ✅ project ready; build on device/emulator |

The desktop process starts the official `@deepseek-ai/dsh` local web server and
loads its unmodified UI in a sandboxed Electron `WebContentsView`. The wrapper
only owns process lifecycle, native-window integration, navigation policy, and
the custom title bar. The HarmonyOS app bundles no runtime: it connects over
the LAN to `dsh web` running on your own computer.

> [!IMPORTANT]
> This project is not an official DeepSeek product and does not provide model
> quota or bypass API authentication. DeepSeek Harness is still a Developer
> Preview; do not open untrusted projects with elevated privileges.

![DeepSeek Harness Desktop](docs/screenshot.png)

## Pinned versions

| Component | Version |
| --- | --- |
| DeepSeek Harness (`@deepseek-ai/dsh`) | `0.1.0-rc.6` |
| Electron | `43.4.0` |
| Bundled Node.js | `24.19.0` |
| electron-builder | `26.15.3` |

Versions are pinned in both `package-lock.json` files. `npm run setup` downloads
the Node.js runtime from the official site and verifies it against both a
repository-pinned value and the official `SHASUMS256.txt` (Windows x64 plus
macOS arm64/x64 archives are pinned).

## Run from source

Requirements: Node.js 24, npm, git.

### Windows

PowerShell 5 or later is also required.

```powershell
git clone <this repository>
cd deepseek-harness-desktop
npm ci
npm run setup
npm start
```

### macOS

Node.js 24 and Xcode Command Line Tools are also required
(`xcode-select --install`) for native module compilation and electron-builder
packaging. If the Electron download from GitHub times out, retry with
`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`.

```sh
git clone <this repository>
cd deepseek-harness-desktop
npm ci
npm run setup
npm start
```

The first screenshot-QA run on macOS asks for Screen Recording permission. If
the grant is unavailable, the screenshot hook records the documented skip
(`macOS screen capture unavailable` in `desktop.log`); the window-controls QA
still runs.

## Build releases

### Windows

```powershell
npm ci
npm run build:windows
```

Outputs in `dist/`: NSIS installer, portable exe, `win-unpacked/`, source
snapshot, and `SHA256SUMS.txt`. The installer is unsigned, so Windows may show
"unknown publisher". **Install-location policy (since 2026-08-15)**: the
directory page is enabled; the default directory is relocated to the first
non-system drive, and interactive installs may choose any path. Enforced by
`build/installer.nsh` and asserted by `npm run check`.

### macOS

On a Mac the host architecture is detected automatically (override with
`ARCH=x64` or `ARCH=arm64`; the same ARCH is passed to the bundled Node runtime
preparation so the packaged app and runtime never mismatch):

```sh
npm ci
npm run build:mac        # = scripts/build.sh
```

Outputs `dist/DeepSeek-Harness-Desktop-<version>-<arch>.dmg` and
`dist/SHA256SUMS-mac.txt`. The script ad-hoc signs the `.app` and rebuilds the
dmg from the signed bundle. First launch: mount the dmg, drag the app to
`/Applications`, then **right-click → Open** (one quarantine prompt for ad-hoc
builds).

One-command verification (QA smoke + package + signature + mount test):

```sh
bash scripts/verify-macos.sh
```

CI: `.github/workflows/macos-release.yml` builds on `macos-15` (arm64) and
`macos-15-intel` (x64), and attaches both dmgs to the GitHub Release for `v*`
tags. The screenshot QA is skipped in CI (no Screen Recording grant); the
window-controls QA still runs.

## Phone remote access (tray-hosted desktop + HarmonyOS companion)

The desktop follows the "phone is a remote control, not a runtime" model:

- **Tray lifecycle**: the close button hides the window to the system tray and
  keeps the local Harness running; the tray menu can open the window, open the
  remote-access settings, or quit (graceful Host shutdown).
- **One-click remote mode**: the "手机" button in the title bar (or the tray
  menu) opens the remote window. Enabling it writes the webserver profile patch
  (`host: 0.0.0.0`, default port `8787`), restarts Harness, and shows the LAN
  URL and QR code.
- **Connect from HarmonyOS / a phone browser** on the same LAN using that URL.
  Disabling the switch restores `127.0.0.1`.

> [!WARNING]
> `dsh web` has no TLS and no authentication. Remote mode exposes Harness to
> the network — use it only on trusted LANs and turn it off afterwards.

## HarmonyOS thin client

### Topology

```text
Desktop app (Windows/macOS)                  HarmonyOS device / emulator
┌─────────────────────────────┐             ┌──────────────────────────┐
│ tray-owned Host             │    LAN      │ harmonyos/ DevEco project │
│ remote mode 0.0.0.0:8787    │ ──────────▶ │ ArkWeb loads the QR URL   │
│ official UI + tool runtime  │             └──────────────────────────┘
└─────────────────────────────┘
```

The HarmonyOS app is a thin client: sessions, tools, and model calls all run on
the host PC.

### Path A: connect to the desktop app (recommended)

1. Open "Phone remote access" in the desktop app and enable the switch.
2. Scan the QR code with the HarmonyOS app, or type the displayed
   `http://<PC-IP>:8787`.
3. The desktop window can be closed — the Host keeps running in the tray.

### Path B: standalone `dsh web` host (CLI)

**The CLI deliberately rejects `dsh web --host 0.0.0.0`** for safety. Binding to
a non-loopback address is only possible via a user-level profile patch. For port
8080:

1. Create `$DSH_HOME/profiles/web/cordis.patch.yml` (`%USERPROFILE%\.dsh` on
   Windows, `~/.dsh` on macOS):

   ```yaml
   - id: webserver
     config:
       host: 0.0.0.0
       port: 8080
   ```

2. Start without `--host`:

   ```sh
   dsh web
   # prints e.g.: dsh web: http://127.0.0.1:8080 (LAN: http://<PC-IP>:8080)
   ```

3. Open the firewall port and use the real LAN IP (the printed LAN address can
   be a WSL/virtual adapter address).

4. **Acceptance**: first load `http://<PC-IP>:8080` in a phone browser on the
   same LAN and complete a real conversation (new session → question → reply).
   Page load alone is not enough. With `0.0.0.0` the `/api` trust fence
   auto-trusts LAN IPv4 literals; hostname access requires
   `dsh web --trusted-host <host[:port]>`.

> [!WARNING]
> `dsh web` has no TLS and no authentication. Binding `0.0.0.0` exposes
> Harness to the network — use it only on trusted LANs and restore
> `127.0.0.1` afterwards.

### Build and run the HarmonyOS app

1. Open `harmonyos/` with DevEco Studio 6.x (Stage model + ArkTS).
2. If the SDK/API version does not match, set `compatibleSdkVersion` in
   `build-profile.json5` to an API installed locally (the project defaults to
   `5.0.0(12)`).
3. Sign in to DevEco with a Huawei account for free automatic signing on a real
   device, or use a local emulator.
4. Enter the host address (desktop remote mode defaults to
   `http://<PC-IP>:8787`; the CLI example is `http://<PC-IP>:8080`) and tap
   Connect. The URL is persisted and reloaded on startup; errors show a retry
   page.
5. **Acceptance**: complete a real conversation (new session → question →
   streamed reply).

Plaintext HTTP is path A (MVP). If your ArkWeb build still reports
`net::ERR_CLEARTEXT_NOT_PERMITTED`, follow path B in `harmonyos/README.md`
(https + mkcert self-signed CA + reverse proxy, or the cleartext configuration
supported by your SDK). Both paths must pass a real `/api` interaction.

## Layout

```text
.
├─ main.js                         Electron main process, Harness child, content view
├─ preload.js                      minimal window-control bridge
├─ shell.html                      custom title bar and startup view
├─ build/
│  ├─ deepseek-harness.svg         official whale icon from the Harness package
│  ├─ icon.png / icon.icns         macOS icons (generated from the SVG and committed)
│  └─ installer.nsh                Windows install-location policy
├─ harness/                        isolated runtime dependency tree and lockfile
├─ scripts/
│  ├─ prepare-runtime.mjs          cross-platform runtime preparation (npm run setup)
│  ├─ prepare-runtime.ps1          legacy Windows entry point (kept for compatibility)
│  ├─ generate-icons.mjs           SVG -> PNG/ICNS using the harness dependency tree
│  ├─ build-windows.ps1 / build.sh  Windows / macOS one-command builds
│  ├─ verify-macos.sh              macOS end-to-end acceptance script
│  └─ verify-source.mjs            source and packaging policy gate (npm run check)
├─ harmonyos/                      HarmonyOS DevEco thin-client project
├─ dist/                           per-platform artifacts
└─ .github/workflows/              Windows / macOS release automation
```

## API key and data

The app inherits the launching environment, so an existing `DEEPSEEK_API_KEY`
works directly, or configure a provider under Models in the Harness UI. This
project never stores, uploads, or embeds API keys.

Desktop user data and logs:

```text
Windows: %APPDATA%\deepseek-harness-desktop\harness-home
         %APPDATA%\deepseek-harness-desktop\logs\desktop.log
macOS:   ~/Library/Application Support/deepseek-harness-desktop/harness-home
         ~/Library/Application Support/deepseek-harness-desktop/logs/desktop.log
```

The Harness process's default workspace is
`<userData>/harness-home/workspace` — it never starts in the entire user home
directory. Other directories can be picked explicitly in the Harness UI.

The HarmonyOS app persists only the host URL setting; no session data is stored.

## Security boundary

- The desktop Harness service listens on a random `127.0.0.1` port by default;
  phone remote access is an explicit, reversible switch that binds
  `0.0.0.0:<port>` and restores loopback when disabled;
- the Harness child process is confined to
  `<userData>/harness-home/workspace` as its default workspace, never the
  user's home directory;
- the official page runs in a `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false` content view;
- the custom title bar and the remote-access window only reach the main process
  through a narrow, sender-checked IPC bridge;
- non-local navigation opens in the system browser and the page never gets
  Node.js access;
- quitting the single-instance app stops the Harness child process gracefully
  (SIGTERM grace period, then SIGKILL).

## Upstream, icon and licenses

The desktop shell (`main.js` / `preload.js` / `shell.html` and build scripts) is
original work by this repository under the [MIT License](LICENSE). DeepSeek
Harness and the official whale icon belong to
[deepseek-ai](https://github.com/deepseek-ai) and are used under its MIT
license. `@deepseek-ai/dsh`, Electron, and Node.js are third-party
distributions; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing

Issues and pull requests are welcome. Before submitting, run:

```sh
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
