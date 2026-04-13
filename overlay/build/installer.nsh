!macro customInit
  ExecWait "taskkill /im mtga-tracker-backend.exe /f"
  ExecWait "taskkill /im $\"MTGA Tracker.exe$\" /f"
!macroend

!macro customUnInit
  ExecWait "taskkill /im mtga-tracker-backend.exe /f"
  ExecWait "taskkill /im $\"MTGA Tracker.exe$\" /f"
!macroend
