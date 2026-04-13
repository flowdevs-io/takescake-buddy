!macro StopTrackerProcesses
  ExecWait "taskkill /im mtga-tracker-scraper.exe /f /t"
  ExecWait "taskkill /im mtga-tracker-backend.exe /f /t"
  ExecWait "taskkill /im $\"MTGA Tracker.exe$\" /f /t"
!macroend

!macro SuppressRegisteredUninstaller
  ClearErrors
  ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${ifNot} ${Errors}
  ${andIfNot} $0 == ""
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString" ""
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "QuietUninstallString" ""
  ${endIf}

  !ifdef UNINSTALL_REGISTRY_KEY_2
    ClearErrors
    ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    ${ifNot} ${Errors}
    ${andIfNot} $0 == ""
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString" ""
      WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}" "QuietUninstallString" ""
    ${endIf}
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
!include "getProcessInfo.nsh"

Var pid

!macro StopTrackerProcessesInInstallDir
  ${If} $INSTDIR != ""
    ${if} $IsPowerShellAvailable == 0
      nsExec::Exec `"$PowerShellPath" -C "$$currentPid = $pid; Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') -and $$_.ProcessId -ne $$currentPid } | % { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
      Pop $0
    ${endif}
  ${EndIf}
!macroend

!macro FindTrackerProcesses _RETURN
  ${if} $IsPowerShellAvailable == 0
    ${If} $INSTDIR == ""
      StrCpy ${_RETURN} 1
    ${Else}
      nsExec::Exec `"$PowerShellPath" -C "$$currentPid = $pid; if ((Get-CimInstance -ClassName Win32_Process | ? { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') -and $$_.ProcessId -ne $$currentPid }).Count -gt 0) { exit 0 } else { exit 1 }"`
      Pop ${_RETURN}
    ${EndIf}
  ${else}
    StrCpy ${_RETURN} 1
    !insertmacro FIND_PROCESS "MTGA Tracker.exe" ${_RETURN}
    ${if} ${_RETURN} != 0
      !insertmacro FIND_PROCESS "mtga-tracker-backend.exe" ${_RETURN}
    ${endif}
    ${if} ${_RETURN} != 0
      !insertmacro FIND_PROCESS "mtga-tracker-scraper.exe" ${_RETURN}
    ${endif}
  ${endif}
!macroend

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  StrCpy $R1 0

  checkAppRunningLoop:
    !insertmacro StopTrackerProcesses
    !insertmacro StopTrackerProcessesInInstallDir
    Sleep 1000
    !insertmacro FindTrackerProcesses $R0

    ${if} $R0 == 0
      IntOp $R1 $R1 + 1
      ${if} $R1 > 1
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY checkAppRunningLoop
        Quit
      ${else}
        Goto checkAppRunningLoop
      ${endif}
    ${endif}
!macroend
!endif

!macro customInit
  !insertmacro StopTrackerProcesses
  !insertmacro SuppressRegisteredUninstaller
!macroend

!macro customUnInit
  !insertmacro StopTrackerProcesses
!macroend
