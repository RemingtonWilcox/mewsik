# Public beta release checklist

mewsik is structured to produce self-contained Windows and macOS installers. Version 0.2.0 adds the credential-free code foundation for a signed Windows updater and a guarded GitHub draft-release workflow. No signing key, certificate, or password is stored in the repository. The workflow cannot create even a draft unless every required release credential is configured, and a human must still review and publish that draft.

Normal local builds deliberately have no updater endpoint or public key. They report `updaterConfigured: false` to the UI and continue to build and run without release credentials. Only the guarded release workflow generates the ignored Tauri merge config and compiles in the `stable` update channel.

## Current readiness on 2026-07-14

- The installed/local Windows 0.2.0 build is unsigned private-test output. It is current enough for local testing, but it is not the signed public bootstrap installer.
- The updater UI, native shutdown gate, and draft workflow exist. The protected `release` environment is restricted to `main`, requires owner approval, and contains a cryptographically verified Tauri updater keypair. The encrypted recovery material is stored outside the repository under the current Windows account, but still needs one separate disaster-recovery copy because its local password envelope is DPAPI-bound to this account. Azure Artifact Signing account/profile credentials are still absent, so the public `latest.json` feed is not live.
- `.github/workflows/ci.yml` runs the version, Svelte/type, discovery publisher, Rust format/test, production build, and four-worker Playwright gates for pull requests and `main`. GitHub secret scanning, push protection, and Dependabot security updates are enabled for the public repository.
- `release/provider-policy.json` is a checked-in fail-closed distribution gate. It currently blocks the draft workflow because the prototype's unofficial YouTube audio extraction/download, SoundCloud multi-provider playback/download, and Bandcamp scraping paths are not suitable for distribution. Azure credentials or a workflow dispatch cannot bypass this code-reviewed gate.
- GitHub Pages is enabled and the credential-free discovery snapshot is live. YouTube and Last.fm intentionally remain `unavailable`: keys are absent, activation switches are off, and their data is excluded from mewsik-derived shelves until the policy gates below pass.
- No distributable Mac build is current. A fresh clean Apple Silicon release checkout now passes dependency, Svelte, sidecar, runtime-resource, and Rust checks with the pinned toolchains. The Mac mini still lacks the Developer ID Application identity/private key and the `mewsik-notary` Keychain profile; the MacBook that may hold the signing identity was unreachable during the audit.

## Supported release targets

| Target | Build host | Artifact | Current minimum |
| --- | --- | --- | --- |
| Windows x64 | Windows x64 | Authenticode-signed NSIS `setup.exe` | Windows 10/11 |
| macOS Apple Silicon | Apple Silicon Mac | signed and notarized DMG | macOS 13.5 |
| macOS Intel | Intel Mac | signed and notarized DMG | macOS 13.5 |

`scripts/prepare-runtime-resources.mjs` bundles the host Node and FFmpeg executables and rejects a platform or architecture mismatch. A Windows machine therefore cannot produce the Mac release. Running `scripts/macos-release.sh` over SSH on a Mac is fine because the build and signing still happen on macOS. Native macOS CI runners are another option after that release lane is completed.

A universal macOS artifact is not supported yet. Ship separate `aarch64` and `x64` DMGs until Node, FFmpeg, and the app executable are all packaged as universal binaries.

## What happens on somebody else's computer

No tester types a `C:\Users\...` path. Tauri's installer and mewsik resolve the signed-in Windows user's standard folders at runtime. NSIS installs per user under that user's local application-data folder. New downloads normally go to that user's `Music\Mewsik` folder, then `Downloads\Mewsik` if Windows exposes no Music folder, and only fall back to the private app-data `downloads` folder if neither standard user folder is available. A user-selected location is stored per user. The account name is never hardcoded.

The Windows deliverable is the NSIS `setup.exe`; that installer is the setup experience, so no separate wizard is required. Signing identifies the publisher and protects the file from modification, but no signing method can promise that every antivirus or reputation system immediately trusts a brand-new product. Never tell testers to disable security software. Distribute only the GitHub Release artifact and publish its SHA-256 hash.

## Shared discovery publication

`.github/workflows/deploy-discovery-snapshot.yml` runs hourly from the default branch and publishes `https://remingtonwilcox.github.io/mewsik/discovery/v1/snapshot.json` through GitHub Pages. It contains normalized public aggregate batches only; it must never contain user history, library contents, interactions, or provider credentials.

Configure these repository Actions secrets only after the corresponding provider account, product UI, and terms gates are approved. A secret alone does not activate a provider:

| Name | Purpose |
| --- | --- |
| `MEWSIK_YOUTUBE_API_KEY` | Shared YouTube Data API v3 Music-category chart refresh. Restrict it to the YouTube Data API v3, not runner IP addresses. Keep absent until the separate branded shelf, versioned Terms/Privacy acceptance, and policy review are complete. |
| `MEWSIK_LASTFM_API_KEY` | Shared Last.fm top-tracks refresh. Keep absent until written public-use approval and visible attribution/linkbacks are complete. |

The repository variables `MEWSIK_ENABLE_YOUTUBE_DISCOVERY` and `MEWSIK_ENABLE_LASTFM_DISCOVERY` must also equal the literal string `true` before the publisher will call those providers. Their safe/default value is `false`. Never use these switches to bypass the approval gates.

The workflow publishes an honest `unavailable` source when its activation gate is off or its key is absent, reuses a still-fresh prior batch as `cached`, and retains a failed batch as `stale` for at most three provider cadences. YouTube keys travel in `x-goog-api-key`, not request URLs. Last.fm requests identify mewsik, preserve validated provider linkbacks, and omit provider artwork/audio. Ordinary app users configure nothing. Local environment keys are developer fallback only and must never be bundled into an installer.

## Version and toolchain gate

Release builds use:

- Node 24.15.0 from `.node-version`
- pnpm 10.11.0 from `package.json#packageManager`
- Rust 1.95.0 from `rust-toolchain.toml`

The app version must match in `package.json`, `sidecar/package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. Change all four and run:

```sh
pnpm version:check
pnpm install --frozen-lockfile
```

Never reuse a version for different public bits. The stable Windows workflow accepts plain `X.Y.Z` versions only and rejects anything that is not newer than the highest existing stable `vX.Y.Z` tag. A public `v0.1.0` already exists; the updater-capable bootstrap release is `v0.2.0`. Never replace assets under an existing tag.

## Windows release

The NSIS installer installs for the current user without elevation. Downgrades are blocked, and the MSI upgrade code remains pinned so a future product-name edit cannot accidentally create a second installation identity. The current Tauri WebView2 mode downloads Microsoft's bootstrapper when WebView2 is missing, so those uncommon machines need internet during setup.

Tauri's uninstall checkbox clears interface/WebView preferences and cache derived from the bundle identifier; its text explicitly says the SQLite library and downloaded music are preserved. Core JSON config also remains in private data, while browser-backed preferences such as visualizer choices can be cleared. Do not add an installer hook that silently deletes or moves user-owned data.

Public Windows drafts use Azure Artifact Signing through Tauri's `bundle.windows.signCommand`. Tauri signs the application executable and installer while bundling, before updater signatures and `latest.json` are produced. The guarded workflow has no unsigned fallback. A deliberately unsigned private build must be built locally, labeled unmistakably, and never published through the stable updater feed.

### Distribution provider gate

Signing makes an installer attributable and tamper-evident; it does not grant rights to provider content. The current local prototype uses unofficial YouTube InnerTube audio extraction, scraped SoundCloud credentials/streams, and Bandcamp page scraping. Those paths remain available only for local development while product alternatives are built. Do not send the current build to friends or publish it with those features enabled.

The Windows preflight and macOS release script read `release/provider-policy.json` before using any signing identity or secret. A distributable version remains blocked until a reviewed pull request either replaces those paths with approved integrations or disables them server-side for distributed builds, adds real user Terms/Privacy, and binds the approval file to that exact release version and review reference. Do not flip the JSON boolean as a paperwork shortcut.

The provider-by-provider evidence and safe product alternatives are recorded in [Provider distribution strategy](provider-distribution-strategy-2026-07-14.md).

## Windows updater behavior

Version 0.1.0 had no updater, so it cannot update itself. Testers must manually install 0.2.0 once. Preserving the bundle identifier, current-user scope, and data paths makes that an in-place upgrade. From the first updater-enabled release onward, the app can:

1. Check GitHub's HTTPS `latest.json` only when the release build reports updates are configured.
2. Show the new version and release notes instead of silently installing it.
3. Download after the user confirms.
4. Verify Tauri's mandatory updater signature.
5. Recheck that no music download is pending, downloading, or processing. If one started while the app package downloaded, keep the verified package and wait instead of downloading it again.
6. Atomically block new music-download workers, check once more in native code, and only then stop playback, FFmpeg transcoders, and the search sidecar.
7. Run the NSIS updater in passive mode. A successful Windows install exits through the installer; if installer setup fails after native services were quiesced, mewsik immediately attempts a clean recovery relaunch.

This is pull-based, not a remote push into somebody's computer. Publishing a newer signed release makes it discoverable; the installed app checks and the user decides when to install. User data and downloads remain outside the application bundle and survive an in-place update.

The workflow at `.github/workflows/draft-windows-release.yml` is manual-only, requires the full Git ref to be the default branch (a similarly named tag cannot pass), rejects an existing or non-increasing stable version, requires an exact typed confirmation, signs a random challenge and verifies it with the configured public key, runs the version/type/Rust/browser gates, creates signed updater artifacts, and creates a GitHub **draft**. Publishing is a separate human action. Configure a GitHub Environment named `release` with required reviewers before placing credentials in it.

### Exact GitHub release contract

Configure these GitHub Actions **variables** in the protected `release` environment:

| Name | Value |
| --- | --- |
| `MEWSIK_UPDATER_PUBLIC_KEY` | The single canonical base64 line stored by Tauri in the generated `.key.pub` file. It is public and is not a path. Do not encode it again. |
| `AZURE_ARTIFACT_SIGNING_ENDPOINT` | Bare HTTPS endpoint such as `https://wus2.codesigning.azure.net`. |
| `AZURE_ARTIFACT_SIGNING_ACCOUNT` | Azure Artifact Signing account name. |
| `AZURE_ARTIFACT_SIGNING_PROFILE` | Certificate-profile name inside that account. |

Configure these GitHub Actions **secrets** in the same environment:

| Name | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | The single canonical base64 line in the password-encrypted Tauri `.key` file. Do not encode it again. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for that updater private key. |
| `AZURE_CLIENT_ID` | Client ID authorized to sign with the Artifact Signing profile. |
| `AZURE_CLIENT_SECRET` | Client secret for that identity. |
| `AZURE_TENANT_ID` | Azure tenant ID for that identity. |

`GITHUB_TOKEN` is supplied by GitHub with job-scoped `contents: write`; do not create a personal access token. The generated `src-tauri/tauri.release.generated.conf.json` contains only the updater public key, public HTTPS endpoint, passive install mode, and public Artifact Signing identifiers. It is gitignored and never contains the updater private key or Azure client secret.

Generate the updater keypair once on a trusted machine with Tauri's `signer generate` command, use a strong password, keep at least one encrypted offline backup, and place each generated one-line value in the matching GitHub entry. Do not paste the private key into issues, logs, release notes, commits, or chat. Losing it means installed clients cannot trust a replacement key; recovery requires a manually installed bridge release, so backup is a release blocker.

Before dispatching, bump all four manifests to the same never-published version. From the default branch, run **Draft signed Windows release**, enter the version without `v`, and type `CREATE DRAFT vX.Y.Z`. Review the draft's Authenticode publisher, `.sig`, `latest.json`, clean install, upgrade preservation, and SHA-256 hashes before publishing. Do not mark an updater release as a GitHub prerelease: the configured `/releases/latest/` endpoint ignores prereleases. To repair a bad public release, publish a higher version instead of mutating the old one.

### Required updater canary

Do not send 0.2.0 broadly until its exact signed candidate has been installed on a disposable Windows profile and the Settings page reports the stable update channel without treating an older/no-update feed as a network failure. Verify the installer publisher, install scope, preserved library/downloads, and release endpoint from that installed binary.

Because 0.1.0 had no updater, the first complete installed-app update canary necessarily uses 0.2.0 as the old build and a higher signed build as the update. Keep the reviewed 0.2.0 candidate installed on the canary profile. Before announcing the next release broadly, publish its reviewed draft, immediately use 0.2.0 to check, download, verify, install, and relaunch it, then recheck data and playback. If that canary fails, stop rollout and publish a higher fixed version; never replace the failing tag's assets.

## macOS release

The existing native Mac script refuses to build unless a Developer ID signing identity and exactly one notarization credential method are available. Recommended local setup stores notarization credentials in Keychain:

```sh
xcrun notarytool store-credentials "mewsik-notary" \
  --apple-id "YOUR_APPLE_ID" \
  --team-id "YOUR_TEAM_ID" \
  --password "YOUR_APP_SPECIFIC_PASSWORD"

export APPLE_NOTARY_KEYCHAIN_PROFILE="mewsik-notary"
export APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR NAME (TEAMID)"
pnpm release:macos
```

The script also supports `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`, or `APPLE_API_KEY` + `APPLE_API_KEY_PATH` with optional `APPLE_API_ISSUER`. Keep certificates, API keys, and passwords in Keychain or CI secrets—never in the repository or chat.

The script signs embedded Node and FFmpeg with hardened-runtime entitlements, signs the app and DMG, waits for an explicit notarization acceptance, staples the ticket, and fails unless codesign, DMG, stapler, and Gatekeeper checks pass.

Signing and notarization must run on macOS, but the commands may be launched over SSH after that Mac is powered on, unlocked, reachable, and has the certificate and Keychain profile installed. Windows can coordinate the job; it cannot perform the native codesign/notary work itself.

The GitHub updater workflow currently ships Windows x64 only. The macOS updater remains disabled because every nested executable must be explicitly signed before the updater archive is created. The current script does not yet produce the signed `.app.tar.gz` updater bundle or merge both architectures into `latest.json`. Do not add macOS to a generic Tauri matrix until that order is implemented and verified.

A future Mac updater lane must sign every nested executable, sign the app, notarize and staple the distributed build, create the updater archive from that final app, sign the archive with the protected Tauri updater key, and add valid `darwin-aarch64` and `darwin-x86_64` entries to one `latest.json`.

## Upgrade and data-safety test

Do this on disposable Windows and macOS user profiles before publishing an update:

1. Install the previous public version and create a library, favorites, playlists, settings changes, and a completed download.
2. Record the download location and copy private data somewhere outside the profile.
3. Install the new version over the old one without manually uninstalling it.
4. Confirm library, playlists, settings, station favorites, playback history, and the download still exist and play.
5. Confirm a pending schema change created a valid private `backups` file and no more than three pre-migration backups remain.
6. Test search, external playback, radio, downloads, queue, and every visualizer engine from the installed build—not only dev mode.
7. Uninstall and verify the wording matches what remains. Reinstall and confirm preserved data is readable.

Do not publish if an upgrade changes the Tauri identifier, Windows installer scope, data-directory convention, database path, or download-path semantics without a separately reviewed migration plan.

## Final artifact gate

- Working tree and tag point to the intended reviewed commit.
- `pnpm version:check`, `pnpm check`, Rust tests, and Playwright tests pass.
- Runtime manifest hashes and bundled third-party license files are present.
- Windows Authenticode publisher, updater `.sig`, and `latest.json` are valid.
- Every macOS DMG is signed, notarized, stapled, and tested on clean matching hardware.
- SHA-256 hashes are published with the release.
- Release notes list supported OS/architecture, known limitations, and storage behavior.
- `release/provider-policy.json` approves this exact version after YouTube, SoundCloud, Bandcamp, radio-directory, Node, and FFmpeg obligations have been reviewed and all listed blockers are actually closed.
