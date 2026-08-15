; DeepSeek Harness Desktop — custom NSIS header (installer policy).
;
; Policy (user decision 2026-08-15): the DEFAULT install directory must not be
; on the system drive (C:). It is relocated to the first available
; fixed/removable non-system drive (D:, E:, F:, ...). The interactive install
; may choose any path (including C:) — no page-level C: rejection.
;
; This file is included by electron-builder ahead of the generated installer
; script, so the macros below are visible at every hook site in the template
; (customInit after initMultiUser). It applies to the assisted (non-one-click)
; installer; the portable target does not use these hooks and is unaffected.

!include "LogicLib.nsh"
!include "FileFunc.nsh"

Var NonCDrivePickedDrive

; Runs in .onInit AFTER electron-builder computed $INSTDIR from its own rules.
!macro customInit
  Call NonCDrivePickDefault
!macroend

Function NonCDrivePickDefault
  ; If the user explicitly passed /D=<path>, respect it — never relocate an
  ; explicit choice (interactive selection happens later, after this hook).
  StrCpy $1 $R0 2
  StrCmp $1 "" 0 done
  StrCpy $0 $INSTDIR 2
  StrCmp $0 "C:" 0 done
  StrCmp $0 "c:" 0 done
  ; The default is on the system drive: relocate to the first fixed/removable
  ; non-system drive (D:, E:, F:, G:, ...).
  StrCpy $NonCDrivePickedDrive ""
  ${GetDrives} "FDD+HDD" NonCDrivePickCallback
  ${If} $NonCDrivePickedDrive != ""
    StrCpy $INSTDIR "$NonCDrivePickedDrive${APP_FILENAME}"
  ${EndIf}
done:
FunctionEnd

Function NonCDrivePickCallback
  ; $9 = candidate drive root (e.g. "D:\")
  StrCpy $0 $9 2
  StrCmp $0 "C:" 0 keep
  StrCmp $0 "c:" 0 keep
  Push 1
  Return
keep:
  StrCpy $NonCDrivePickedDrive $9
  Push 0
FunctionEnd
