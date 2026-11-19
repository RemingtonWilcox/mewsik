@echo off
rem Builds the Windows NSIS installer. "build-nsis.cmd release" also turns on
rem in-app updates (stable channel, public key and feed from tauri.updater.conf.json).
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64 || exit /b 1
if /i "%~1"=="release" (
  set MEWSIK_UPDATE_CHANNEL=stable
  pnpm tauri build --bundles nsis --config src-tauri/tauri.updater.conf.json
) else (
  pnpm tauri build --bundles nsis
)
