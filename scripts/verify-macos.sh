#!/usr/bin/env bash
#
# DeepSeek Harness Desktop — macOS end-to-end verification (stage 2 acceptance).
#
# Run this ON A MAC from the repository root (or pass the repo path):
#
#   bash scripts/verify-macos.sh
#   bash scripts/verify-macos.sh /path/to/deepseek-harness-desktop
#
# The script performs every automated stage of the macOS acceptance:
#   1. prerequisites (macOS, Node.js >= 24, Xcode CLT)
#   2. npm ci (root) + npm run setup (bundled harness + pinned macOS Node runtime)
#   3. icon regeneration + npm run check
#   4. QA smoke: screenshot hook and window-controls hook (both auto-quit)
#   5. build.sh -> ad-hoc signed dmg -> signature + mount verification
#   6. prints the remaining MANUAL checks for you to confirm and report back
#
# Screenshot note: macOS Screen Recording permission is required for the
# screenshot QA hook. If the permission prompt appears, click "Allow" and the
# hook is retried automatically. Without the grant the script records the
# documented skip (`macOS screen capture unavailable`) and continues — that is
# an accepted outcome per the execution plan.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -ge 1 ]]; then
  ROOT="$(cd "$1" && pwd)"
fi
cd "$ROOT"

LOG_SEARCH_PATHS=(
  "$HOME/Library/Application Support/deepseek-harness-desktop/logs/desktop.log"
  "$HOME/Library/Application Support/DeepSeek Harness Desktop/logs/desktop.log"
)
SCREENSHOT_PATH="${TMPDIR:-/tmp}/dsh-qa-screenshot.png"
APP_NAME="DeepSeek Harness Desktop"
VERSION="$(node -p "require('./package.json').version")"
ARCH="$(node -p "process.arch === 'arm64' ? 'arm64' : 'x64'")"
DMG_PATH="dist/DeepSeek-Harness-Desktop-${VERSION}-${ARCH}.dmg"

step() { printf '\n==== %s\n' "$1"; }
die() { printf '\nverify-macos: FAILED — %s\n' "$1" >&2; exit 1; }

latest_log() {
  local found=""
  for candidate in "${LOG_SEARCH_PATHS[@]}"; do
    if [[ -f "$candidate" ]]; then
      found="$candidate"
      break
    fi
  done
  if [[ -z "$found" ]]; then
    found="$(find "$HOME/Library/Application Support" -maxdepth 3 -name desktop.log -print 2>/dev/null | sort | tail -n 1 || true)"
  fi
  printf '%s' "$found"
}

# ---------------------------------------------------------------------------
step "1/8 Prerequisites"
if [[ "$(uname -s)" != "Darwin" ]]; then
  die "this script must run on macOS"
fi
for cmd in node npm npx git codesign hdiutil shasum; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing command: $cmd"
done
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 24 ]]; then
  die "Node.js 24+ is required (found $(node -v)); the bundled Node 24 runtime is used by the app itself"
fi
if ! xcode-select -p >/dev/null 2>&1; then
  die "Xcode Command Line Tools are required: run 'xcode-select --install' first"
fi
printf '      macOS %s / Node %s / %s\n' "$(sw_vers -productVersion 2>/dev/null || echo '?')" "$(node -v)" "$ARCH"

# ---------------------------------------------------------------------------
step "2/8 Install pinned dependencies (npm ci)"
npm ci --no-audit --no-fund

step "3/8 Prepare bundled runtime (harness npm ci + Node.js ${ARCH} download + checksum)"
npm run setup

step "4/8 Regenerate icons and verify source"
node scripts/generate-icons.mjs
npm run check

# ---------------------------------------------------------------------------
step "5/8 QA hook 1 — screenshot + auto quit"
rm -f "$SCREENSHOT_PATH"
printf '      If macOS asks for Screen Recording permission, click Allow.\n'
DSH_DESKTOP_QA_SCREENSHOT="$SCREENSHOT_PATH" DSH_DESKTOP_QA_AUTO_QUIT=1 npm start
sleep 2
if [[ -s "$SCREENSHOT_PATH" ]]; then
  SIZE="$(stat -f%z "$SCREENSHOT_PATH" 2>/dev/null || echo 0)"
  printf '      screenshot saved: %s (%s bytes)\n' "$SCREENSHOT_PATH" "$SIZE"
  if [[ "$SIZE" -le 10240 ]]; then
    die "screenshot exists but is smaller than the 10 KB acceptance threshold"
  fi
else
  LOG="$(latest_log)"
  if [[ -n "$LOG" ]] && grep -q "macOS screen capture unavailable" "$LOG"; then
    printf '      screenshot skipped with the documented macOS branch (no Screen Recording grant).\n'
  else
    die "no screenshot and no macOS-skip record in desktop.log (log: ${LOG:-not found})"
  fi
fi

# ---------------------------------------------------------------------------
step "6/8 QA hook 2 — window controls + custom close"
DSH_DESKTOP_QA_WINDOW_CONTROLS=1 DSH_DESKTOP_QA_AUTO_QUIT=1 npm start
sleep 2
LOG="$(latest_log)"
[[ -n "$LOG" ]] || die "desktop.log was not created"
grep -q "Window controls QA passed" "$LOG" || die "window controls QA did not pass (see $LOG)"
grep -q "Testing the custom close action" "$LOG" || die "custom close QA did not run (see $LOG)"
printf '      Window controls QA passed: maximize, restore, minimize, close\n'
if pgrep -f '@deepseek-ai/dsh/lib/bin.js' >/dev/null 2>&1; then
  die "a bundled Harness node process is still running after auto-quit"
fi
printf '      no residual Harness process\n'

# ---------------------------------------------------------------------------
step "7/8 Build the ad-hoc signed dmg (build.sh)"
bash scripts/build.sh

APP_PATH="$(find dist -maxdepth 4 -type d -name "${APP_NAME}.app" -print | sort | tail -n 1)"
[[ -n "$APP_PATH" ]] || die "packaged .app not found"
codesign --verify --deep --strict "$APP_PATH"
grep -q 'Signature=adhoc' <(codesign -dv --verbose=2 "$APP_PATH" 2>&1) || die "app is not ad-hoc signed"
[[ -f "$DMG_PATH" ]] || die "dmg artifact is missing: $DMG_PATH"
printf '      dmg: %s\n' "$DMG_PATH"

VOLUME_OUTPUT="$(hdiutil attach -nobrowse -readonly "$DMG_PATH")"
printf '      %s\n' "$VOLUME_OUTPUT" | head -n 3
VOLUME="$(printf '%s\n' "$VOLUME_OUTPUT" | awk '/\/Volumes\// { print $NF; exit }')"
[[ -n "$VOLUME" ]] || die "dmg did not mount"
test -d "$VOLUME/${APP_NAME}.app" || die "mounted dmg has no ${APP_NAME}.app"
hdiutil detach "$VOLUME" >/dev/null
printf '      dmg mount + app presence verified\n'

# ---------------------------------------------------------------------------
step "8/8 Automated verification complete — manual checks left"
cat <<'MANUAL'
Automated checks passed. Please confirm these MANUAL items and report back:

  1. Open the dmg, drag "DeepSeek Harness Desktop" into /Applications.
  2. First launch: right-click the app -> Open (quarantine prompt may appear once).
  3. Confirm the official UI loads, the 42px title bar shows Chinese text
     (最小化/最大化/关闭), window controls work, and the title follows the page.
  4. Quit the app and confirm no leftover node process in Activity Monitor.

If you grant Screen Recording permission, rerun this script once so the
screenshot hook records a real capture as well.
MANUAL
printf '\nverify-macos: ALL AUTOMATED CHECKS PASSED (manual items above remain)\n'
