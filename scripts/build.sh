#!/usr/bin/env bash
#
# DeepSeek Harness Desktop — macOS release build (stage 2.4 / D5).
#
# Produces dist/DeepSeek-Harness-Desktop-<version>-<arch>.dmg for the current
# machine architecture, ad-hoc signed so it survives Gatekeeper's first-launch
# quarantine with "right-click -> Open". Runs on macOS only.
#
# Usage:
#   bash scripts/build.sh
#   ARCH=arm64 bash scripts/build.sh     # optional explicit override
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build.sh: macOS is required (electron-builder cannot produce a .dmg here)." >&2
  exit 1
fi

for cmd in node npm npx codesign hdiutil; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "build.sh: missing required command: $cmd" >&2
    exit 1
  fi
done

VERSION="$(node -p "require('./package.json').version")"
HOST_ARCH="$(node -p "process.arch === 'arm64' ? 'arm64' : 'x64'")"
ARCH="${ARCH:-$HOST_ARCH}"
case "$ARCH" in
  arm64|x64) ;;
  *)
    echo "build.sh: unsupported ARCH=$ARCH (supported: arm64, x64)" >&2
    exit 1
    ;;
esac

APP_NAME="DeepSeek Harness Desktop"
DMG_NAME="DeepSeek-Harness-Desktop-${VERSION}-${ARCH}.dmg"
DMG_PATH="dist/${DMG_NAME}"

echo "==> [1/6] Installing pinned build dependencies (npm ci)"
npm ci --no-audit --no-fund

echo "==> [2/6] Source verification"
npm run check

echo "==> [3/6] Preparing bundled runtime (harness npm ci + Node.js ${ARCH})"
npm run setup

echo "==> [4/6] Regenerating icons (icon.png / icon.icns)"
node scripts/generate-icons.mjs

echo "==> [5/6] Packaging ${ARCH} application + unsigned dmg"
rm -f "dist/${DMG_NAME}"
npx --no-install electron-builder --mac dmg --"$ARCH" --publish never

APP_PATH="$(find dist -maxdepth 4 -type d -name "${APP_NAME}.app" -print | sort | tail -n 1)"
if [[ -z "$APP_PATH" ]]; then
  echo "build.sh: packaged .app bundle was not found under dist/" >&2
  exit 1
fi
echo "      Packaged app: $APP_PATH"

echo "==> [6/6] Ad-hoc signing and rebuilding the dmg from the signed app"
codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
SIGNATURE_LINE="$(codesign -dv --verbose=2 "$APP_PATH" 2>&1 | grep -E '^Signature=' || true)"
echo "      $SIGNATURE_LINE"
if [[ "$SIGNATURE_LINE" != *"Signature=adhoc"* ]]; then
  echo "build.sh: expected an ad-hoc signature on the packaged app." >&2
  exit 1
fi

STAGING_DIR="$(mktemp -d)"
cleanup() { rm -rf "$STAGING_DIR"; }
trap cleanup EXIT
cp -R "$APP_PATH" "$STAGING_DIR/"
ln -s /Applications "$STAGING_DIR/Applications"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGING_DIR" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null

shasum -a 256 "$DMG_PATH" > "dist/SHA256SUMS-mac.txt"
echo "      $(cat "dist/SHA256SUMS-mac.txt")"

echo
echo "macOS artifact ready: $DMG_PATH"
echo "  - mount the dmg, drag the app to /Applications"
echo "  - first launch: right-click -> Open (Gatekeeper quarantine for ad-hoc builds)"
