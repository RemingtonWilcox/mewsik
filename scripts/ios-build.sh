#!/usr/bin/env bash
# Builds and exports the iPhone app on the MacBook.
#
# Run this from Terminal.app (a GUI session), not over SSH: the final codesign
# step needs the login keychain, and SSH sessions get errSecInternalComponent.
#
#   bash scripts/ios-build.sh            # development export (install via Xcode/devicectl)
#   bash scripts/ios-build.sh --open     # same, then open the folder with the .ipa
#
# Output: src-tauri/gen/apple/build/arm64/mewsik.ipa
set -euo pipefail

cd "$(dirname "$0")/.."

# The repo pins Node 24.15.0 and pnpm 10.11.0 (package.json "engines").
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use 24.15.0 >/dev/null
fi

# Homebrew ships its own cargo/rustc which shadow rustup's and cannot see the
# iOS target. Force the rustup toolchain pinned in rust-toolchain.toml.
export PATH="$HOME/.cargo/bin:$PATH"
TOOLCHAIN="$(rustup show active-toolchain 2>/dev/null | awk '{print $1}')"
export RUSTC="$HOME/.rustup/toolchains/${TOOLCHAIN}/bin/rustc"
rustup target add aarch64-apple-ios >/dev/null 2>&1 || true

pnpm install --frozen-lockfile
pnpm tauri ios build --export-method debugging

IPA="src-tauri/gen/apple/build/arm64/mewsik.ipa"
echo
echo "Exported: $IPA"
if [ "${1:-}" = "--open" ]; then
  open "$(dirname "$IPA")"
fi
