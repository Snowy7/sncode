; SnCode custom NSIS installer configuration.
; Included by electron-builder via package.json "include".

!include "LogicLib.nsh"
!include "nsDialogs.nsh"

!pragma warning push
!pragma warning disable 6010
!include "StrFunc.nsh"
!pragma warning pop

; StrFunc requires one-time registration before argument-based use.
; Register only the side we compile to avoid warning 6010 in strict builds.
!ifdef BUILD_UNINSTALLER
  ${UnStrStr}
  ${UnStrRep}
!else
  ${StrStr}
!endif

!ifndef BUILD_UNINSTALLER
  Var ADD_TO_PATH
  Var DLG_PATH_CHECKBOX
!endif

!macro customHeader
  !ifndef MUI_WELCOMEPAGE_TITLE
    !define MUI_WELCOMEPAGE_TITLE "Welcome to SnCode"
  !endif
  !ifndef MUI_WELCOMEPAGE_TEXT
    !define MUI_WELCOMEPAGE_TEXT "SnCode is your AI-powered desktop coding agent.$\r$\n$\r$\nThis wizard will guide you through the installation.$\r$\nClick Next to continue."
  !endif

  !ifndef MUI_FINISHPAGE_TITLE
    !define MUI_FINISHPAGE_TITLE "SnCode is Ready"
  !endif
  !ifndef MUI_FINISHPAGE_TEXT
    !define MUI_FINISHPAGE_TEXT "SnCode has been installed successfully.$\r$\n$\r$\nClick Finish to close the wizard and start coding."
  !endif

  !ifndef MUI_ABORTWARNING
    !define MUI_ABORTWARNING
  !endif
  !ifndef MUI_ABORTWARNING_TEXT
    !define MUI_ABORTWARNING_TEXT "Are you sure you want to cancel the SnCode installation?"
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customInit
    ; Default to adding `sncode` to the user PATH.
    StrCpy $ADD_TO_PATH "1"

    ; Optional CLI override: /ADD_TO_PATH=0 to disable, /ADD_TO_PATH=1 to force.
    ${GetParameters} $0
    ${GetOptions} $0 "/ADD_TO_PATH=" $1
    ${If} $1 == "0"
      StrCpy $ADD_TO_PATH "0"
    ${ElseIf} $1 == "1"
      StrCpy $ADD_TO_PATH "1"
    ${EndIf}
  !macroend

  !macro customPageAfterChangeDir
    Page custom sncodePathPage sncodePathPageLeave
  !macroend

  Function sncodePathPage
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 8u 100% 16u "Command-line setup"
    Pop $1
    ${NSD_CreateLabel} 0 30u 100% 40u "If enabled, this adds the ""sncode"" command to your user PATH so you can launch SnCode from Command Prompt, PowerShell, or Terminal."
    Pop $2

    ${NSD_CreateCheckbox} 0 82u 100% 14u "Add 'sncode' command to PATH (recommended)"
    Pop $DLG_PATH_CHECKBOX
    ${If} $ADD_TO_PATH == "1"
      ${NSD_Check} $DLG_PATH_CHECKBOX
    ${Else}
      ${NSD_Uncheck} $DLG_PATH_CHECKBOX
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function sncodePathPageLeave
    ${NSD_GetState} $DLG_PATH_CHECKBOX $0
    ${If} $0 == 1
      StrCpy $ADD_TO_PATH "1"
    ${Else}
      StrCpy $ADD_TO_PATH "0"
    ${EndIf}
  FunctionEnd

  ; Add install directory to user PATH so `sncode` works from a terminal.
  !macro customInstall
    ${If} $ADD_TO_PATH == "1"
      ReadRegStr $0 HKCU "Environment" "PATH"
      ${StrStr} $1 "$0" "$INSTDIR"
      StrCmp $1 "" 0 path_already_set
        StrCmp $0 "" 0 has_existing_path
          WriteRegExpandStr HKCU "Environment" "PATH" "$INSTDIR"
          Goto path_done
        has_existing_path:
          WriteRegExpandStr HKCU "Environment" "PATH" "$0;$INSTDIR"
      path_already_set:
      path_done:
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=500
    ${EndIf}
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  ; Remove install directory from user PATH on uninstall.
  !macro customUnInstall
    ReadRegStr $0 HKCU "Environment" "PATH"
    ${UnStrStr} $1 "$0" "$INSTDIR"
    StrCmp $1 "" path_clean 0
      ${UnStrRep} $2 "$0" ";$INSTDIR" ""
      ${UnStrRep} $3 "$2" "$INSTDIR;" ""
      ${UnStrRep} $4 "$3" "$INSTDIR"  ""
      WriteRegExpandStr HKCU "Environment" "PATH" "$4"
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=500
    path_clean:
  !macroend
!endif
