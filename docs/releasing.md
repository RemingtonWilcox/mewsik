# Public beta release checklist

mewsik can produce self-contained Windows and macOS installers. It is suitable for controlled friend testing once the exact artifact has passed the checks below. It is not yet a polished public distribution channel: Windows signing and in-app updates are not wired up, and each macOS architecture must currently be built separately.

## Supported release targets

| Target | Build host | Artifact | Current minimum |
| --- | --- | --- | --- |
| Windows x64 | Windows x64 | NSIS `setup.exe` (preferred for beta) and MSI | Windows 10/11 |
| macOS Apple Silicon | Apple Silicon Mac | signed and notarized DMG | macOS 13.5 |
| macOS Intel | Intel Mac | signed and notarized DMG | macOS 13.5 |

`scripts/prepare-runtime-resources.mjs` bundles the host Node and FFmpeg executables and deliberately rejects a platform or architecture mismatch. A Windows machine therefore cannot produce the Mac release. Running `scripts/macos-release.sh` over SSH on a Mac is fine because the build and signing still happen on macOS. Native macOS GitHub Actions runners are another option after release secrets are configured.

A single universal macOS artifact is not supported yet. Ship separate `aarch64` and `x64` DMGs until Node, FFmpeg, and the app executable are all packaged as universal binaries.

## Version and toolchain gate

Release builds use:

- Node 24.15.0 from `.node-version`
- pnpm 10.11.0 from `package.json#packageManager`
- Rust 1.95.0 from `rust-toolchain.toml`

The app version must match in `package.json`, `sidecar/package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. Change all four and then run:

```sh
pnpm version:check
pnpm install --frozen-lockfile
```

Never reuse a version for different public bits. Tag the exact reviewed commit as `vX.Y.Z` only after every release artifact has been built from it.

## Windows release

Build on Windows x64:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test:e2e
Push-Location src-tauri
cargo test
Pop-Location
pnpm tauri build
```

The NSIS installer installs for the current user under `%LOCALAPPDATA%` without elevation. Downgrades are blocked, and the MSI upgrade code is pinned so a future product-name edit cannot accidentally create a second installation identity. The current Tauri WebView2 mode downloads Microsoft's bootstrapper when WebView2 is missing, so those uncommon machines need an internet connection during setup. Tauri's uninstall checkbox only clears interface/WebView preferences and cache derived from the bundle identifier, so its text explicitly says that the SQLite library and downloaded music are preserved. The core JSON config also remains in the private data folder, while browser-backed preferences such as visualizer choices can be cleared by that checkbox. Do not add an installer hook that silently deletes or moves user-owned library data or downloads.

Before broad distribution, configure Authenticode signing and timestamping for the app and installer. Signing identifies the publisher and protects the file from modification; it does not guarantee that Microsoft SmartScreen will immediately have reputation for a new build. The present repository does not contain a Windows signing certificate or signing configuration.

For a controlled unsigned beta, state clearly that Windows will show an unknown-publisher warning, distribute the installer only from the project's GitHub release, publish its SHA-256 hash, and never ask testers to disable antivirus.

## macOS release

The release script refuses to build unless a Developer ID signing identity and exactly one notarization credential method are available. The recommended local setup stores notarization credentials in the macOS Keychain:

```sh
xcrun notarytool store-credentials "mewsik-notary" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID" \
  --password "YOUR_APP_SPECIFIC_PASSWORD"

export APPLE_NOTARY_KEYCHAIN_PROFILE="mewsik-notary"
export APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR NAME (TEAMID)"
pnpm release:macos
```

The script also supports either `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_API_KEY` + `APPLE_API_KEY_PATH` with optional `APPLE_API_ISSUER`. Keep certificates, API keys, and passwords in Keychain or CI secrets—never in the repository or a chat transcript.

The script signs the embedded Node and FFmpeg executables with hardened-runtime entitlements, signs the app and DMG, waits for an explicit `Accepted` notarization result, staples the ticket, and fails unless codesign, DMG, stapler, and Gatekeeper assessments pass.

## Upgrade and data-safety test

Do this on a disposable Windows user profile and a disposable macOS user profile before publishing an update:

1. Install the previous public version and create a library, favorites, playlists, settings changes, and at least one completed download.
2. Record the displayed download location and copy the private data folder somewhere outside the test profile.
3. Install the new version over the old version without manually uninstalling it.
4. Confirm the library, playlists, settings, station favorites, playback history, and downloaded file still exist and play.
5. Confirm a pending schema change created a valid file in the private `backups` directory and that no more than three pre-migration backups are retained.
6. Launch search, external playback, radio playback, download, queue, and every visualizer engine from the installed build—not only the dev server.
7. Uninstall and verify that the explicit installer wording matches what remains on disk. Reinstall and confirm the preserved user data is still readable.

Do not publish if an upgrade changes the Tauri identifier, Windows installer scope, data-directory convention, database path, or download-path semantics without a separately reviewed migration plan.

## Artifact and release gate

- Working tree and tag point to the intended commit.
- `pnpm version:check`, `pnpm check`, Rust tests, and Playwright tests pass.
- Runtime manifest hashes and bundled third-party license files are present.
- Windows artifacts are signed for a public release, or explicitly labeled unsigned for controlled testing.
- Every macOS DMG is signed, notarized, stapled, and tested on a clean machine of the matching architecture.
- SHA-256 hashes are published with the release.
- Release notes list supported OS/architecture, known limitations, storage behavior, and whether updates are manual.
- Provider terms and redistribution/licensing obligations for Node, FFmpeg, YouTube, SoundCloud, Bandcamp, and radio-directory integrations have been reviewed for the intended release model.

## Updates are still manual

There is no updater plugin or release feed in this repository today. A tester must download and run the newer installer. The intended next distribution milestone is a signed, pull-based updater backed by HTTPS/GitHub Releases with a visible confirmation prompt, passive install, relaunch, signed update metadata, rollback-aware migrations, and preservation of private data and user-owned downloads.

Updater artifact signatures are separate from Windows Authenticode and Apple Developer ID signatures. Do not enable the updater until its private signing key has an offline backup and the corresponding public key, HTTPS endpoint, release workflow, and recovery procedure have been reviewed together.
