; mewsik NSIS hooks (bundle > windows > nsis > installerHooks).
;
; Tauri's own running-app check only looks at mewsik.exe. mewsik also starts
; helper processes from the install folder: bin\node.exe (search sidecar) and
; bin\ffmpeg.exe (radio and downloads). If mewsik is force-closed, they can
; outlive it for a moment and keep their files locked. A silent installer then
; skips those files and still exits 0, leaving a half-upgraded install.
;
; Before anything is written or removed, close every process that is using
; mewsik.exe or one of the helper binaries in THIS install folder. Restart
; Manager matches exact file paths, so unrelated node.exe/ffmpeg.exe processes
; elsewhere on the machine are never touched. An interactive run still asks
; before closing an open mewsik window, like Tauri's own check.

!macro MEWSIK_RELEASE_INSTALL_DIR
  ; Is mewsik itself open from this folder?
  StrCpy $1 0
  !insertmacro RestartManager_StartSession $R0
  ${If} $R0 != ""
    !insertmacro RestartManager_RegisterFile $R0 "$INSTDIR\${MAINBINARYNAME}.exe"
    ${If} $0 = 0
      System::Call 'RSTRTMGR::RmGetList(p R0, *i .r2, *i .r3, p 0, *i .r4) i .r0'
      ${If} $0 = ${ERROR_MORE_DATA}
        StrCpy $1 1
      ${EndIf}
    ${EndIf}
    !insertmacro RestartManager_EndSession $R0
  ${EndIf}

  ${If} $1 = 1
  ${AndIfNot} ${Silent}
  ${AndIf} $PassiveMode <> 1
    nsis_tauri_utils::StrReplace "$(appRunningOkKill)" "{{product_name}}" "${PRODUCTNAME}"
    Pop $R1
    ${If} ${Cmd} `MessageBox MB_OKCANCEL "$R1" IDCANCEL`
      nsis_tauri_utils::StrReplace "$(appRunning)" "{{product_name}}" "${PRODUCTNAME}"
      Pop $R1
      Abort "$R1"
    ${EndIf}
  ${EndIf}

  ; Close the app, then anything still holding the helper binaries.
  !insertmacro RestartManager_ShutdownFile "$INSTDIR\${MAINBINARYNAME}.exe" $0
  !insertmacro RestartManager_ShutdownFile "$INSTDIR\bin\node.exe" $0
  !insertmacro RestartManager_ShutdownFile "$INSTDIR\bin\ffmpeg.exe" $0
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro MEWSIK_RELEASE_INSTALL_DIR
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MEWSIK_RELEASE_INSTALL_DIR
!macroend
