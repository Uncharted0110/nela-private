; GenHat / NELA NSIS installer hooks + FileIndexer setup page helpers.
; Page custom entries live in nsis/installer.nsi; functions are here via installerHooks.

; ── FileIndexer page state ───────────────────────────────────────────────────
Var FiMode
Var FiRoots
Var FiDialog
Var FiRadioDefault
Var FiRadioCustom
Var FiBrowseBtn
Var FiAddBtn
Var FiRemoveBtn
Var FiList
Var FiPathEdit
Var FiInfoLabel
Var FiConfirmLabel
Var FiTemp
Var FiIndex
Var FiDriveMask
Var FiLetter
Var FiPath

!macro FiInitDefaults
  StrCpy $FiMode "default"
  StrCpy $FiRoots ""
!macroend

Function FiEnsureInit
  ${If} $FiMode == ""
    !insertmacro FiInitDefaults
  ${EndIf}
FunctionEnd

Function FiCollectFixedDrives
  StrCpy $FiRoots ""
  System::Call 'kernel32::GetLogicalDrives()i.r0'
  StrCpy $FiDriveMask $0
  StrCpy $FiLetter 65 ; 'A'
  FiDriveLoop:
    IntOp $1 $FiDriveMask & 1
    ${If} $1 != 0
      IntFmt $FiPath "%c:" $FiLetter
      StrCpy $FiPath "$FiPath\"
      IfFileExists "$FiPath*.*" 0 FiDriveNext
        ${If} $FiRoots == ""
          StrCpy $FiRoots "$FiPath"
        ${Else}
          StrCpy $FiRoots "$FiRoots|$FiPath"
        ${EndIf}
    ${EndIf}
    FiDriveNext:
    IntOp $FiDriveMask $FiDriveMask >> 1
    IntOp $FiLetter $FiLetter + 1
    IntCmp $FiLetter 91 FiDriveDone FiDriveLoop FiDriveDone
  FiDriveDone:
FunctionEnd

Function FiAppendRoot
  Pop $FiPath
  ${If} $FiPath == ""
    Return
  ${EndIf}
  ${If} $FiRoots == ""
    StrCpy $FiRoots "$FiPath"
  ${Else}
    StrCpy $FiRoots "$FiRoots|$FiPath"
  ${EndIf}
FunctionEnd

Function FiRefreshList
  SendMessage $FiList ${LB_RESETCONTENT} 0 0
  StrCpy $FiTemp "$FiRoots"
  FiListLoop:
    ${If} $FiTemp == ""
      Goto FiListDone
    ${EndIf}
    StrCpy $0 $FiTemp
    StrCpy $1 0
    FiFindPipe:
      StrCpy $2 $0 1 $1
      ${If} $2 == ""
        ${NSD_LB_AddString} $FiList $0
        StrCpy $FiTemp ""
        Goto FiListLoop
      ${ElseIf} $2 == "|"
        StrCpy $3 $0 $1
        ${NSD_LB_AddString} $FiList $3
        IntOp $1 $1 + 1
        StrCpy $FiTemp $0 "" $1
        Goto FiListLoop
      ${EndIf}
      IntOp $1 $1 + 1
      Goto FiFindPipe
  FiListDone:
FunctionEnd

Function PageFileIndexerMode
  Call FiEnsureInit
  ${If} $PassiveMode = 1
    Call PageLeaveFileIndexerMode
    Return
  ${EndIf}

  nsDialogs::Create 1018
  Pop $FiDialog
  ${If} $FiDialog == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 24u "Choose which folders NELA should index for local file search."
  Pop $FiInfoLabel

  ${NSD_CreateRadioButton} 10u 40u 100% 12u "Default — index all fixed drives"
  Pop $FiRadioDefault
  ${NSD_CreateRadioButton} 10u 58u 100% 12u "Custom — choose specific folders"
  Pop $FiRadioCustom

  ${If} $FiMode == "custom"
    ${NSD_Check} $FiRadioCustom
  ${Else}
    ${NSD_Check} $FiRadioDefault
  ${EndIf}

  ${NSD_CreateLabel} 0 86u 100% 40u "The embedding model is installed under models\fileindexer. Indexing starts automatically after you finish setup."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function PageLeaveFileIndexerMode
  ${If} $PassiveMode = 1
    StrCpy $FiMode "default"
    Call FiCollectFixedDrives
    Return
  ${EndIf}
  ${NSD_GetState} $FiRadioDefault $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $FiMode "default"
    Call FiCollectFixedDrives
    ${If} $FiRoots == ""
      MessageBox MB_ICONEXCLAMATION "No drives were found to index."
      Abort
    ${EndIf}
  ${Else}
    StrCpy $FiMode "custom"
  ${EndIf}
FunctionEnd

Function PageFileIndexerCustom
  Call FiEnsureInit
  ${If} $PassiveMode = 1
    Call PageLeaveFileIndexerCustom
    Return
  ${EndIf}
  ${If} $FiMode != "custom"
    Abort ; skip this page for Default mode
  ${EndIf}

  nsDialogs::Create 1018
  Pop $FiDialog
  ${If} $FiDialog == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 16u "Add folders to index. Selecting a parent folder includes everything underneath."
  Pop $FiInfoLabel

  ${NSD_CreateText} 0 22u -70u 12u ""
  Pop $FiPathEdit

  ${NSD_CreateButton} -65u 21u 65u 14u "Browse…"
  Pop $FiBrowseBtn
  ${NSD_OnClick} $FiBrowseBtn FiOnBrowse

  ${NSD_CreateButton} 0 42u 70u 14u "Add folder"
  Pop $FiAddBtn
  ${NSD_OnClick} $FiAddBtn FiOnAdd

  ${NSD_CreateButton} 75u 42u 80u 14u "Remove selected"
  Pop $FiRemoveBtn
  ${NSD_OnClick} $FiRemoveBtn FiOnRemove

  ${NSD_CreateListBox} 0 62u 100% -10u
  Pop $FiList

  Call FiRefreshList
  nsDialogs::Show
FunctionEnd

Function FiOnBrowse
  nsDialogs::SelectFolderDialog "Select a folder to index" "$PROFILE"
  Pop $0
  ${If} $0 != "error"
  ${AndIf} $0 != ""
    ${NSD_SetText} $FiPathEdit $0
  ${EndIf}
FunctionEnd

Function FiOnAdd
  ${NSD_GetText} $FiPathEdit $FiPath
  ${If} $FiPath == ""
    MessageBox MB_ICONEXCLAMATION "Enter or browse to a folder first."
    Return
  ${EndIf}
  IfFileExists "$FiPath\*.*" 0 FiAddBad
    Push $FiPath
    Call FiAppendRoot
    ${NSD_SetText} $FiPathEdit ""
    Call FiRefreshList
    Return
  FiAddBad:
    MessageBox MB_ICONEXCLAMATION "That path is not a valid folder."
FunctionEnd

Function FiOnRemove
  SendMessage $FiList ${LB_GETCURSEL} 0 0 $FiIndex
  IntCmp $FiIndex -1 FiRemReturn FiRemOk FiRemOk
  FiRemReturn:
    Return
  FiRemOk:
  StrCpy $R9 ""
  StrCpy $R8 0
  StrCpy $FiTemp "$FiRoots"
  FiRemLoop:
    ${If} $FiTemp == ""
      Goto FiRemDone
    ${EndIf}
    StrCpy $0 $FiTemp
    StrCpy $1 0
    FiRemFind:
      StrCpy $2 $0 1 $1
      ${If} $2 == ""
        StrCpy $3 $0
        StrCpy $FiTemp ""
        Goto FiRemItem
      ${ElseIf} $2 == "|"
        StrCpy $3 $0 $1
        IntOp $1 $1 + 1
        StrCpy $FiTemp $0 "" $1
        Goto FiRemItem
      ${EndIf}
      IntOp $1 $1 + 1
      Goto FiRemFind
    FiRemItem:
      IntCmp $R8 $FiIndex FiRemSkip FiRemKeep FiRemKeep
      FiRemKeep:
        ${If} $R9 == ""
          StrCpy $R9 "$3"
        ${Else}
          StrCpy $R9 "$R9|$3"
        ${EndIf}
      FiRemSkip:
      IntOp $R8 $R8 + 1
      Goto FiRemLoop
  FiRemDone:
  StrCpy $FiRoots $R9
  Call FiRefreshList
FunctionEnd

Function PageLeaveFileIndexerCustom
  ${If} $FiMode != "custom"
    Return
  ${EndIf}
  ${If} $PassiveMode = 1
    ${If} $FiRoots == ""
      StrCpy $FiMode "default"
      Call FiCollectFixedDrives
    ${EndIf}
    Return
  ${EndIf}
  ${If} $FiRoots == ""
    MessageBox MB_ICONEXCLAMATION "Add at least one folder, or go back and choose Default."
    Abort
  ${EndIf}
FunctionEnd

Function PageFileIndexerConfirm
  Call FiEnsureInit
  ${If} $PassiveMode = 1
    Call PageLeaveFileIndexerConfirm
    Return
  ${EndIf}

  nsDialogs::Create 1018
  Pop $FiDialog
  ${If} $FiDialog == error
    Abort
  ${EndIf}
  ${IfThen} $(^RTL) = 1 ${|} nsDialogs::SetRTL $(^RTL) ${|}

  ${NSD_CreateLabel} 0 0 100% 20u "These folders will be indexed. Click Next/Install to continue."
  Pop $FiConfirmLabel

  ${NSD_CreateListBox} 0 28u 100% -10u
  Pop $FiList
  Call FiRefreshList

  nsDialogs::Show
FunctionEnd

Function PageLeaveFileIndexerConfirm
  ${If} $FiRoots == ""
    MessageBox MB_ICONEXCLAMATION "No folders selected for indexing."
    Abort
  ${EndIf}
FunctionEnd

Function FiWriteConfig
  CreateDirectory "$APPDATA\com.genhat.dev"
  CreateDirectory "$APPDATA\com.genhat.dev\fileindexer"

  FileOpen $0 "$APPDATA\com.genhat.dev\fileindexer\mode.txt" w
  FileWrite $0 "$FiMode"
  FileClose $0

  FileOpen $0 "$APPDATA\com.genhat.dev\fileindexer\roots.txt" w
  StrCpy $FiTemp "$FiRoots"
  FiWriteRoots:
    ${If} $FiTemp == ""
      Goto FiWriteRootsDone
    ${EndIf}
    StrCpy $1 $FiTemp
    StrCpy $2 0
    FiWriteFind:
      StrCpy $3 $1 1 $2
      ${If} $3 == ""
        FileWrite $0 "$1$\r$\n"
        StrCpy $FiTemp ""
        Goto FiWriteRoots
      ${ElseIf} $3 == "|"
        StrCpy $4 $1 $2
        FileWrite $0 "$4$\r$\n"
        IntOp $2 $2 + 1
        StrCpy $FiTemp $1 "" $2
        Goto FiWriteRoots
      ${EndIf}
      IntOp $2 $2 + 1
      Goto FiWriteFind
  FiWriteRootsDone:
  FileClose $0

  DetailPrint "FileIndexer folders saved to $APPDATA\com.genhat.dev\fileindexer"
FunctionEnd

; ── Standard Tauri hooks ─────────────────────────────────────────────────────

!macro NSIS_HOOK_PREINSTALL
    CreateDirectory "$INSTDIR\models"
    CreateDirectory "$INSTDIR\models\LLM"
    CreateDirectory "$INSTDIR\models\LiquidAI-VLM"
    CreateDirectory "$INSTDIR\models\bge-1.5-embed"
    CreateDirectory "$INSTDIR\models\distilBert-query-router"
    CreateDirectory "$INSTDIR\models\distilBert-query-router\onnx_model"
    CreateDirectory "$INSTDIR\models\tts"
    CreateDirectory "$INSTDIR\models\tts\kitten-tts"
    CreateDirectory "$INSTDIR\models\tts\kitten-tts\mini"
    CreateDirectory "$INSTDIR\models\grader"
    CreateDirectory "$INSTDIR\models\grader\ms-marco-MiniLM-L6-v2-onnx-int8"
    CreateDirectory "$INSTDIR\models\asr"
    CreateDirectory "$INSTDIR\models\asr\parakeet"
    CreateDirectory "$INSTDIR\models\fileindexer"
!macroend

!macro NSIS_HOOK_POSTINSTALL
    ; Persist FileIndexer folder selection chosen on the custom installer pages.
    Call FiWriteConfig
    ; Ensure sidecar is next to the app binary when packaged as a resource.
    IfFileExists "$INSTDIR\fileindexer_sidecar.exe" 0 +2
      DetailPrint "FileIndexer sidecar present"
    IfFileExists "$INSTDIR\models\fileindexer\models--Qdrant--all-MiniLM-L6-v2-onnx\*.*" 0 +2
      DetailPrint "FileIndexer embedding model present"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
    ; Leave user index data unless they opted into delete-appdata (handled by Tauri UI).
!macroend
