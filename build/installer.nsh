; SnCode — Custom NSIS installer configuration
; Included by electron-builder via the "include" option in package.json

!include "StrFunc.nsh"
${StrStr}
${StrRep}
${UnStrStr}
${UnStrRep}

!macro customHeader
  ; ── Welcome page ──
  !ifndef MUI_WELCOMEPAGE_TITLE
    !define MUI_WELCOMEPAGE_TITLE "Welcome to SnCode"
  !endif
  !ifndef MUI_WELCOMEPAGE_TEXT
    !define MUI_WELCOMEPAGE_TEXT "SnCode is your AI-powered desktop coding agent.$\r$\n$\r$\nThis wizard will guide you through the installation.$\r$\nClick Next to continue."
  !endif

  ; ── Finish page ──
  !ifndef MUI_FINISHPAGE_TITLE
    !define MUI_FINISHPAGE_TITLE "SnCode is Ready"
  !endif
  !ifndef MUI_FINISHPAGE_TEXT
    !define MUI_FINISHPAGE_TEXT "SnCode has been installed successfully.$\r$\n$\r$\nClick Finish to close the wizard and start coding."
  !endif

  ; ── Abort warning ──
  !ifndef MUI_ABORTWARNING
    !define MUI_ABORTWARNING
  !endif
  !ifndef MUI_ABORTWARNING_TEXT
    !define MUI_ABORTWARNING_TEXT "Are you sure you want to cancel the SnCode installation?"
  !endif
!macroend

; ── Add install directory to user PATH so `sncode` works from any terminal ──
!macro customInstall
  ; Read the current user PATH
  ReadRegStr $0 HKCU "Environment" "PATH"

  ; Only append if the install dir is not already present
  ${StrStr} $1 "$0" "$INSTDIR"
  StrCmp $1 "" 0 path_already_set
    ; Append install dir to user PATH
    StrCmp $0 "" 0 has_existing_path
      WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
      Goto path_done
    has_existing_path:
      WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR"
  path_already_set:
  path_done:

  ; Broadcast the environment change so open terminals pick it up
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=500
!macroend

; ── Remove install directory from user PATH on uninstall ──
!macro customUnInstall
  ReadRegStr $0 HKCU "Environment" "PATH"
  ${UnStrStr} $1 "$0" "$INSTDIR"
  StrCmp $1 "" path_clean 0
    ; Simple removal: replace $INSTDIR; or ;$INSTDIR with empty string
    ${UnStrRep} $2 "$0" ";$INSTDIR" ""
    ${UnStrRep} $3 "$2" "$INSTDIR;" ""
    ${UnStrRep} $4 "$3" "$INSTDIR"  ""
    WriteRegExpandStr HKCU "Environment" "PATH" "$4"
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=500
  path_clean:
!macroend
