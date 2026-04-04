#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PRODUCT_NAME="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
BUNDLE_ID="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64) TAURI_ARCH="aarch64" ;;
  x86_64) TAURI_ARCH="x64" ;;
  *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
esac

IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: REMINGTON LYNN WILCOX (JRKTK7PN93)}"
NODE_ENTITLEMENTS="${NODE_ENTITLEMENTS:-$REPO_ROOT/src-tauri/entitlements/node.plist}"
APP_PATH="$REPO_ROOT/src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"
DMG_PATH="$REPO_ROOT/src-tauri/target/release/bundle/dmg/${PRODUCT_NAME}_${VERSION}_${TAURI_ARCH}.dmg"
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mewsik-release.XXXXXX")"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "Building unsigned app bundle..."
pnpm tauri build --bundles app --no-sign

echo "Signing embedded runtimes..."
codesign --force --timestamp --options runtime --sign "$IDENTITY" \
  --entitlements "$NODE_ENTITLEMENTS" \
  "$APP_PATH/Contents/Resources/bin/node"
codesign --force --timestamp --options runtime --sign "$IDENTITY" \
  "$APP_PATH/Contents/Resources/bin/ffmpeg"

echo "Signing app bundle..."
codesign --force --timestamp --options runtime --sign "$IDENTITY" \
  "$APP_PATH/Contents/MacOS/$PRODUCT_NAME"
codesign --force --timestamp --options runtime --sign "$IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "Preparing signed DMG payload..."
rm -f "$DMG_PATH"
cp -R "$APP_PATH" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"
hdiutil create -volname "$PRODUCT_NAME" -srcfolder "$STAGE_DIR" -format UDZO "$DMG_PATH" >/dev/null

echo "Signing DMG..."
codesign --force --timestamp --sign "$IDENTITY" "$DMG_PATH"

submit_with_notary() {
  local artifact="$1"

  if [[ -n "${APPLE_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
    xcrun notarytool submit "$artifact" \
      --keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE" \
      --wait
    return 0
  fi

  if [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    xcrun notarytool submit "$artifact" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
    return 0
  fi

  if [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]]; then
    if [[ -n "${APPLE_API_ISSUER:-}" ]]; then
      xcrun notarytool submit "$artifact" \
        --key-id "$APPLE_API_KEY" \
        --issuer "$APPLE_API_ISSUER" \
        --key "$APPLE_API_KEY_PATH" \
        --wait
    else
      xcrun notarytool submit "$artifact" \
        --key-id "$APPLE_API_KEY" \
        --key "$APPLE_API_KEY_PATH" \
        --wait
    fi
    return 0
  fi

  return 1
}

if submit_with_notary "$DMG_PATH"; then
  echo "Stapling notarization ticket..."
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
else
  cat <<EOF
Signed release artifacts are ready, but notarization credentials were not found.
Set one of the following before rerunning:
  - APPLE_NOTARY_KEYCHAIN_PROFILE
  - APPLE_ID + APPLE_PASSWORD + APPLE_TEAM_ID
  - APPLE_API_KEY + APPLE_API_KEY_PATH (+ APPLE_API_ISSUER for team keys)
EOF
fi

echo "Release app: $APP_PATH"
echo "Release dmg: $DMG_PATH"
echo "Bundle identifier: $BUNDLE_ID"
