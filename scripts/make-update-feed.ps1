# Unlocks the updater signing key for this Windows account, then signs the
# release's update packages and writes latest.json (scripts/make-update-feed.mjs).
#   pwsh scripts/make-update-feed.ps1 -Version 0.4.2 -Dir <release-dir> -Notes <notes.md>
# The key and password never leave this process and are never printed.
param(
	[Parameter(Mandatory)] [string] $Version,
	[Parameter(Mandatory)] [string] $Dir,
	[string] $Notes = '',
	[string] $KeyDir = (Join-Path $HOME 'Documents\Mewsik Release Keys')
)
$ErrorActionPreference = 'Stop'
$secure = Get-Content (Join-Path $KeyDir 'mewsik-updater-password.dpapi') | ConvertTo-SecureString
$env:TAURI_SIGNING_PRIVATE_KEY_PATH = Join-Path $KeyDir 'mewsik-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Net.NetworkCredential]::new('', $secure).Password
try {
	$nodeArgs = @((Join-Path $PSScriptRoot 'make-update-feed.mjs'), $Version, $Dir)
	if ($Notes) { $nodeArgs += $Notes }
	& node @nodeArgs
	if ($LASTEXITCODE -ne 0) { throw "make-update-feed failed ($LASTEXITCODE)" }
} finally {
	Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD, Env:TAURI_SIGNING_PRIVATE_KEY_PATH -ErrorAction SilentlyContinue
}
