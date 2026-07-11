#!/bin/bash
#
# build-local-dmg.sh — Build a locally-installable, ad-hoc-signed macOS DMG.
#
# Why this exists: `npm run build --workspace=@getpaseo/desktop` produces a
# notarized, code-signed release that needs Apple Developer credentials. For
# local testing we don't have those, and passing `-c.mac.identity=null` to
# electron-builder yields a *broken* signature (resources not sealed) that
# Apple Silicon refuses to launch. This script instead:
#   1. Packs the unpacked .app only (electron-builder --dir, no notarize).
#   2. Deep ad-hoc signs the whole bundle so resources are properly sealed.
#   3. Packages the signed .app into a compressed DMG via hdiutil.
#
# The result installs and opens on the local machine (arm64) without Gatekeeper
# rejecting it. It is NOT distributable — no Developer ID, no notarization.
#
# Usage:
#   ./scripts/build-local-dmg.sh              # reuse existing dist/, arm64
#   ./scripts/build-local-dmg.sh --rebuild    # rebuild main (tsc) first
#   ARCH=x64 ./scripts/build-local-dmg.sh     # target a different arch
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$DESKTOP_DIR"

ARCH="${ARCH:-arm64}"
VERSION="$(node -e "console.log(require('./package.json').version)")"
OUT_DIR="release"
APP_DIR="$OUT_DIR/mac-${ARCH}/Paseo.app"
DMG_PATH="$OUT_DIR/Paseo-${VERSION}-${ARCH}-local.dmg"

echo "══════════════════════════════════════════════════════"
echo "  Paseo Local DMG (ad-hoc signed, unnotarized)"
echo "  version=${VERSION} arch=${ARCH}"
echo "══════════════════════════════════════════════════════"

if [[ "${1:-}" == "--rebuild" ]]; then
  echo "▸ Rebuilding main process (tsc)…"
  npm run build:main
fi

if [[ ! -f dist/main.js ]]; then
  echo "✗ dist/main.js missing. Run 'npm run build:main' (or pass --rebuild),"
  echo "  and ensure deps are built (npm run build:server-deps at repo root)." >&2
  exit 1
fi

# The packaged app loads its UI from paseo://app/, which maps to the Expo web
# export bundled as extraResources (../app/dist → app-dist). Without it the app
# launches, fails to load paseo://app/ (ERR_FILE_NOT_FOUND), and self-quits.
# `npm run build --workspace=desktop` does NOT export this — only build:desktop
# does — so we must export it here.
APP_WEB_DIST="../app/dist"
if [[ "${1:-}" == "--rebuild" || ! -f "$APP_WEB_DIST/index.html" ]]; then
  echo "▸ Exporting Expo web bundle (PASEO_WEB_PLATFORM=electron)…"
  ( cd ../app && PASEO_WEB_PLATFORM=electron npx expo export --platform web )
fi
if [[ ! -f "$APP_WEB_DIST/index.html" ]]; then
  echo "✗ Expo web export missing at $APP_WEB_DIST/index.html." >&2
  echo "  Ensure app deps are built: 'npm run build:app-deps' at repo root, then rerun." >&2
  exit 1
fi

echo "▸ Packing unpacked .app (electron-builder --dir, no notarize/sign)…"
# --dir builds only the unpacked app, skipping electron-builder's own DMG and
# code-signing steps. identity=null keeps it from attempting a real sign; we do
# our own deep ad-hoc sign next.
npx electron-builder --mac --"${ARCH}" --dir \
  -c.mac.notarize=false \
  -c.mac.identity=null \
  --publish never

if [[ ! -d "$APP_DIR" ]]; then
  echo "✗ Expected app not found at $APP_DIR" >&2
  exit 1
fi

echo "▸ Deep ad-hoc signing $APP_DIR …"
codesign --force --deep --sign - "$APP_DIR"

echo "▸ Verifying signature…"
codesign --verify --deep --strict --verbose=2 "$APP_DIR"

echo "▸ Building DMG via hdiutil → $DMG_PATH …"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
cp -R "$APP_DIR" "$STAGING/Paseo.app"
ln -s /Applications "$STAGING/Applications"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "Paseo ${VERSION}" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG_PATH"

echo "══════════════════════════════════════════════════════"
echo "  ✓ Done: $DESKTOP_DIR/$DMG_PATH"
echo "  Install: open the DMG, drag Paseo → Applications."
echo "  (Ad-hoc signed — local use only, not distributable.)"
echo "══════════════════════════════════════════════════════"
