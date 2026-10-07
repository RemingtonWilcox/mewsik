@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat" -no_logo -arch=x64 -host_arch=x64 || exit /b 1
pnpm tauri build --bundles nsis
