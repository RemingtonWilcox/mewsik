# Checks that an NSIS install of mewsik matches the current build.
#
# Do not hash-compare the installed mewsik.exe with target\release\mewsik.exe
# directly: when Tauri bundles the NSIS installer it stamps the copy it packs
# with its bundle type (__TAURI_BUNDLE_TYPE_VAR_NSS; the cargo output keeps
# __TAURI_BUNDLE_TYPE_VAR_UNK). A correct install therefore always differs from
# target\release by those 3 bytes, and copying target\release\mewsik.exe over
# an install leaves the updater unable to tell it was installed by NSIS.
#
# Usage: pwsh scripts/verify-nsis-install.ps1 [-InstallDir <dir>]
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'mewsik'),
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)
$ErrorActionPreference = 'Stop'

$marker = [Text.Encoding]::ASCII.GetBytes('__TAURI_BUNDLE_TYPE_VAR_')

function Find-Marker([byte[]]$bytes) {
  $first = $marker[0]
  $i = [Array]::IndexOf($bytes, $first)
  while ($i -ge 0 -and $i -le $bytes.Length - $marker.Length - 3) {
    $hit = $true
    for ($j = 1; $j -lt $marker.Length; $j++) {
      if ($bytes[$i + $j] -ne $marker[$j]) { $hit = $false; break }
    }
    if ($hit) { return $i + $marker.Length }
    $i = [Array]::IndexOf($bytes, $first, $i + 1)
  }
  return -1
}

function Get-Sha256([byte[]]$bytes) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))
}

$failures = 0
function Report([string]$name, [bool]$ok, [string]$detail = '') {
  $status = if ($ok) { 'ok  ' } else { 'FAIL' }
  Write-Output "$status $name $detail"
  if (-not $ok) { $script:failures++ }
}

# Main binary: equal to the build once the bundle-type stamp is ignored, and
# stamped as an NSIS install.
$built = [IO.File]::ReadAllBytes((Join-Path $RepoRoot 'src-tauri\target\release\mewsik.exe'))
$installed = [IO.File]::ReadAllBytes((Join-Path $InstallDir 'mewsik.exe'))
$builtAt = Find-Marker $built
$installedAt = Find-Marker $installed
if ($builtAt -lt 0 -or $installedAt -lt 0 -or $built.Length -ne $installed.Length -or $builtAt -ne $installedAt) {
  Report 'mewsik.exe' $false 'differs from target\release\mewsik.exe (not the same build)'
} else {
  $stamp = [Text.Encoding]::ASCII.GetString($installed, $installedAt, 3)
  [Array]::Copy($built, $builtAt, $installed, $installedAt, 3)
  $same = (Get-Sha256 $built) -eq (Get-Sha256 $installed)
  Report 'mewsik.exe' $same $(if ($same) { "same build, bundle type $stamp" } else { 'differs from target\release\mewsik.exe (not the same build)' })
  if ($same) { Report 'mewsik.exe bundle type' ($stamp -eq 'NSS') "($stamp, expected NSS)" }
}

# Resources are packed unchanged.
$resources = @{
  'sidecar\dist\index.cjs'      = 'sidecar\dist\index.cjs'
  'seed_favorite_stations.json' = 'src-tauri\resources\seed_favorite_stations.json'
}
Get-ChildItem (Join-Path $RepoRoot 'src-tauri\resources\bin') -File | ForEach-Object {
  $resources["bin\$($_.Name)"] = "src-tauri\resources\bin\$($_.Name)"
}
foreach ($entry in $resources.GetEnumerator() | Sort-Object Name) {
  $dst = Join-Path $InstallDir $entry.Name
  $src = Join-Path $RepoRoot $entry.Value
  $ok = (Test-Path $dst) -and ((Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash)
  Report $entry.Name $ok
}

$version = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\mewsik' -ErrorAction SilentlyContinue).DisplayVersion
$expected = (Get-Content (Join-Path $RepoRoot 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json).version
Report 'registered version' ($version -eq $expected) "($version, expected $expected)"

if ($failures) { Write-Output "$failures check(s) failed"; exit 1 }
Write-Output 'install matches the current build'
