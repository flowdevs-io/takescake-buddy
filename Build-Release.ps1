param(
    [Parameter(Mandatory=$true, HelpMessage="Version number or bump type (e.g. 1.0.1, major, minor, patch)")]
    [string]$Version
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory=$true)]
        [string]$FilePath,

        [string[]]$ArgumentList = @(),

        [Parameter(Mandatory=$true)]
        [string]$FailureMessage
    )

    & $FilePath @ArgumentList

    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)."
    }
}

function Restore-TextFile {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path,

        [AllowNull()]
        [string]$Content
    )

    if ($null -eq $Content) {
        if (Test-Path -LiteralPath $Path) {
            Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
        }

        return
    }

    Set-Content -LiteralPath $Path -Value $Content -Encoding utf8 -NoNewline
}

function Remove-StaleBuildOutput {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path,

        [int]$MaxAttempts = 6,
        [int]$DelaySeconds = 2
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
            return
        } catch {
            if ($attempt -eq $MaxAttempts) {
                $repoProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                    Where-Object {
                        $_.ExecutablePath -like "$Path*" -or $_.CommandLine -like "*$Path*"
                    } |
                    Select-Object Name, ProcessId, ExecutablePath

                $processHint = if ($repoProcesses) {
                    $repoProcesses |
                        ForEach-Object {
                            "$($_.Name) (PID $($_.ProcessId)): $($_.ExecutablePath)"
                        } |
                        Out-String
                } else {
                    "No running process was found under that directory. Windows Defender, Search indexing, or another background scanner is the likely lock holder. Wait a few seconds and retry."
                }

                throw "Unable to remove stale packaged app output at '$Path'. $processHint Original error: $($_.Exception.Message)"
            }

            Start-Sleep -Seconds $DelaySeconds
        }
    }
}

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Building MTGA Tracker Installer" -ForegroundColor Cyan
Write-Host " Target Version: $Version" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

Push-Location overlay
$packageJsonPath = Join-Path (Get-Location) "package.json"
$packageLockPath = Join-Path (Get-Location) "package-lock.json"
$stalePackagePath = Join-Path (Get-Location) "dist-app\win-unpacked"
$packageJsonBackup = Get-Content -LiteralPath $packageJsonPath -Raw
$packageLockBackup = if (Test-Path -LiteralPath $packageLockPath) {
    Get-Content -LiteralPath $packageLockPath -Raw
} else {
    $null
}
$versionWasUpdated = $false

try {
    Write-Host "[1/3] Updating package.json version..." -ForegroundColor Yellow
    Invoke-NativeCommand -FilePath "npm" -ArgumentList @("version", $Version, "--no-git-tag-version", "--allow-same-version") -FailureMessage "npm version failed"
    $versionWasUpdated = $true
    
    # Read the actual version that npm resolved (in case 'patch' or 'minor' was passed)
    $actualVersion = (Get-Content package.json | ConvertFrom-Json).version

    Write-Host "[2/3] Installing/verifying dependencies..." -ForegroundColor Yellow
    Invoke-NativeCommand -FilePath "npm" -ArgumentList @("install") -FailureMessage "npm install failed"

    Write-Host "[3/3] Compiling backend and packaging NSIS Installer..." -ForegroundColor Yellow
    Remove-StaleBuildOutput -Path $stalePackagePath
    Invoke-NativeCommand -FilePath "npm" -ArgumentList @("run", "make") -FailureMessage "npm run make failed"
    
    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host " SUCCESS!" -ForegroundColor Green
    Write-Host " Built version: $actualVersion" -ForegroundColor Green
    Write-Host " The new installer (.exe) is located in:" -ForegroundColor Green
    Write-Host " $(Resolve-Path dist-app)\" -ForegroundColor Gray
    Write-Host "=========================================" -ForegroundColor Green
} catch {
    if ($versionWasUpdated) {
        Restore-TextFile -Path $packageJsonPath -Content $packageJsonBackup
        Restore-TextFile -Path $packageLockPath -Content $packageLockBackup
    }

    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host " BUILD FAILED" -ForegroundColor Red
    Write-Host " $_" -ForegroundColor Red
    if ($versionWasUpdated) {
        Write-Host " package.json and package-lock.json were restored to their pre-build versions." -ForegroundColor Yellow
    }
    Write-Host "=========================================" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
