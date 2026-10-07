#!/usr/bin/env bash
set -euo pipefail
umask 077

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

[[ "$(uname -s)" == "Darwin" ]] || die "macOS releases must be built and signed on macOS"

for command in node pnpm codesign security xcrun hdiutil spctl; do
  require_command "$command"
done

PRODUCT_NAME="$(node -p "require('./src-tauri/tauri.conf.json').productName")"
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
BUNDLE_ID="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
ARCH="$(uname -m)"

# Fail before touching signing identities or notarization credentials. The
# checked-in review gate applies equally to Windows and macOS distribution.
node scripts/check-release-policy.mjs "$VERSION"

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

[[ -f "$NODE_ENTITLEMENTS" ]] || die "Node entitlements file not found: $NODE_ENTITLEMENTS"
SIGNING_IDENTITIES="$(security find-identity -v -p codesigning)"
grep -Fq "$IDENTITY" <<<"$SIGNING_IDENTITIES" \
  || die "Developer ID signing identity is not available in the login keychain: $IDENTITY"

NOTARY_ARGS=()
NOTARY_MODE_COUNT=0

if [[ -n "${APPLE_NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  NOTARY_ARGS=(--keychain-profile "$APPLE_NOTARY_KEYCHAIN_PROFILE")
  NOTARY_MODE_COUNT=$((NOTARY_MODE_COUNT + 1))
fi

if [[ -n "${APPLE_ID:-}" || -n "${APPLE_PASSWORD:-}" || -n "${APPLE_TEAM_ID:-}" ]]; then
  [[ -n "${APPLE_ID:-}" && -n "${APPLE_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]] \
    || die "APPLE_ID notarization requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID"
  NOTARY_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID")
  NOTARY_MODE_COUNT=$((NOTARY_MODE_COUNT + 1))
fi

if [[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_PATH:-}" || -n "${APPLE_API_ISSUER:-}" ]]; then
  [[ -n "${APPLE_API_KEY:-}" && -n "${APPLE_API_KEY_PATH:-}" ]] \
    || die "API-key notarization requires APPLE_API_KEY and APPLE_API_KEY_PATH"
  [[ -f "$APPLE_API_KEY_PATH" ]] || die "Apple API key file not found: $APPLE_API_KEY_PATH"
  NOTARY_ARGS=(--key-id "$APPLE_API_KEY" --key "$APPLE_API_KEY_PATH")
  if [[ -n "${APPLE_API_ISSUER:-}" ]]; then
    NOTARY_ARGS+=(--issuer "$APPLE_API_ISSUER")
  fi
  NOTARY_MODE_COUNT=$((NOTARY_MODE_COUNT + 1))
fi

[[ "$NOTARY_MODE_COUNT" -gt 0 ]] || die "notarization credentials are required; configure a keychain profile, Apple ID credentials, or an App Store Connect API key"
[[ "$NOTARY_MODE_COUNT" -eq 1 ]] || die "configure exactly one notarization credential method"

pnpm version:check

echo "Building unsigned app bundle..."
pnpm tauri build --bundles app --no-sign
[[ -d "$APP_PATH" ]] || die "Tauri did not produce the expected app bundle: $APP_PATH"

NODE_PATH="$APP_PATH/Contents/Resources/bin/node"
FFMPEG_PATH="$APP_PATH/Contents/Resources/bin/ffmpeg"
MAIN_EXECUTABLE="$APP_PATH/Contents/MacOS/$PRODUCT_NAME"
for binary in "$NODE_PATH" "$FFMPEG_PATH" "$MAIN_EXECUTABLE"; do
  [[ -f "$binary" ]] || die "expected bundled executable is missing: $binary"
done

echo "Signing embedded runtimes..."
codesign --force --timestamp --options runtime --sign "$IDENTITY" \
  --entitlements "$NODE_ENTITLEMENTS" \
  "$NODE_PATH"
codesign --force --timestamp --options runtime --sign "$IDENTITY" \
  "$FFMPEG_PATH"
codesign --verify --strict --verbose=2 "$NODE_PATH"
codesign --verify --strict --verbose=2 "$FFMPEG_PATH"

echo "Signing app bundle..."
codesign --force --timestamp --options runtime --sign "$IDENTITY" \
  "$MAIN_EXECUTABLE"
codesign --force --timestamp --options runtime --sign "$IDENTITY" "$APP_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo "Preparing signed DMG payload..."
mkdir -p "$(dirname "$DMG_PATH")"
rm -f "$DMG_PATH"
cp -R "$APP_PATH" "$STAGE_DIR/"
ln -s /Applications "$STAGE_DIR/Applications"
hdiutil create -volname "$PRODUCT_NAME" -srcfolder "$STAGE_DIR" -format UDZO "$DMG_PATH" >/dev/null

echo "Signing DMG..."
codesign --force --timestamp --sign "$IDENTITY" "$DMG_PATH"
codesign --verify --strict --verbose=2 "$DMG_PATH"
hdiutil verify "$DMG_PATH" >/dev/null

echo "Submitting DMG for notarization..."
NOTARY_JSON="$(xcrun notarytool submit "$DMG_PATH" "${NOTARY_ARGS[@]}" --wait --output-format json)"
printf '%s\n' "$NOTARY_JSON"
NOTARY_STATUS="$(printf '%s' "$NOTARY_JSON" | node -e "process.stdin.setEncoding('utf8');let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(String(JSON.parse(data).status ?? '')));")"
[[ "$NOTARY_STATUS" == "Accepted" ]] || die "Apple notarization did not return Accepted (status: ${NOTARY_STATUS:-missing})"

echo "Stapling and validating notarization ticket..."
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
codesign --verify --strict --verbose=2 "$DMG_PATH"
hdiutil verify "$DMG_PATH" >/dev/null
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

echo "Release app: $APP_PATH"
echo "Release dmg: $DMG_PATH"
echo "Bundle identifier: $BUNDLE_ID"
