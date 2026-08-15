# Changelog

## Unreleased

- Add macOS support: cross-platform runtime preparation
  (`scripts/prepare-runtime.mjs` with pinned Node.js macOS arm64/x64
  checksums), platform branch in `main.js`, generated `build/icon.icns`,
  electron-builder dmg target, ad-hoc signing, and
  `scripts/verify-macos.sh` for one-command acceptance on a Mac.
- Add `.github/workflows/macos-release.yml`: `macos-15` (arm64) and
  `macos-15-intel` (x64) build and publish per-architecture dmgs for `v*`
  tags; window-controls QA runs in CI, screenshot QA is skipped without a
  Screen Recording grant.
- Add a HarmonyOS DevEco thin-client project (`harmonyos/`): ArkWeb loads the
  LAN `dsh web` host, with a persisted host URL, connection status, error
  retry, and documented host deployment via the `webserver` profile patch.
- `npm run setup` now uses the cross-platform Node implementation on Windows
  and macOS; the legacy PowerShell entry point is kept for compatibility.
- Three-platform documentation in `README.md` / `README.en.md` covers
  Windows/macOS build and run, HarmonyOS host deployment, connection, and
  risks.

## 0.1.0 - 2026-08-13

- Initial open-source release.
- Bundle DeepSeek Harness `0.1.0-rc.6`, Electron `43.4.0`, and Node.js
  `24.19.0`.
- Add a frameless custom title bar with minimize, maximize/restore, and close.
- Use the official whale icon from the upstream Harness package.
- Provide reproducible Windows runtime preparation, NSIS installer, portable
  executable, license inventory, checksums, and GitHub Release automation.
- Keep the installer in the standard per-user directory to avoid legacy
  Windows path-length limits in deeply nested upstream dependencies.
