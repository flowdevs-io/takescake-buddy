param(
    [Parameter(Mandatory=$true, HelpMessage="Version number or bump type (e.g. 1.0.1, major, minor, patch)")]
    [string]$Version,

    [switch]$Publish,

    [string]$RemoteName = "origin"
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

function Get-NativeCommandOutput {
    param(
        [Parameter(Mandatory=$true)]
        [string]$FilePath,

        [string[]]$ArgumentList = @(),

        [Parameter(Mandatory=$true)]
        [string]$FailureMessage
    )

    $output = & $FilePath @ArgumentList 2>&1

    if ($LASTEXITCODE -ne 0) {
        $renderedOutput = ($output | Out-String).Trim()
        if ([string]::IsNullOrWhiteSpace($renderedOutput)) {
            throw "$FailureMessage (exit code $LASTEXITCODE)."
        }

        throw "$FailureMessage (exit code $LASTEXITCODE). $renderedOutput"
    }

    return $output
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

function Assert-CleanGitWorkingTree {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RepoRoot
    )

    $status = Get-NativeCommandOutput -FilePath "git" -ArgumentList @("-C", $RepoRoot, "status", "--porcelain") -FailureMessage "git status failed"
    $renderedStatus = ($status | Out-String).Trim()

    if (-not [string]::IsNullOrWhiteSpace($renderedStatus)) {
        throw "Git working tree is not clean. Commit, stash, or discard changes before publishing a release.`n$renderedStatus"
    }
}

function Get-GitCurrentBranch {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RepoRoot
    )

    $branch = Get-NativeCommandOutput -FilePath "git" -ArgumentList @("-C", $RepoRoot, "symbolic-ref", "--quiet", "--short", "HEAD") -FailureMessage "Unable to determine the current git branch"
    return ($branch | Out-String).Trim()
}

function Assert-GitRemoteExists {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RepoRoot,

        [Parameter(Mandatory=$true)]
        [string]$RemoteName
    )

    $null = Get-NativeCommandOutput -FilePath "git" -ArgumentList @("-C", $RepoRoot, "remote", "get-url", $RemoteName) -FailureMessage "Unable to resolve git remote '$RemoteName'"
}

function Assert-GitTagAvailable {
    param(
        [Parameter(Mandatory=$true)]
        [string]$RepoRoot,

        [Parameter(Mandatory=$true)]
        [string]$RemoteName,

        [Parameter(Mandatory=$true)]
        [string]$TagName
    )

    $localTag = Get-NativeCommandOutput -FilePath "git" -ArgumentList @("-C", $RepoRoot, "tag", "--list", $TagName) -FailureMessage "Unable to check local git tags"
    $localTagName = ($localTag | Out-String).Trim()

    if ($localTagName -eq $TagName) {
        throw "The local git tag '$TagName' already exists."
    }

    $remoteTag = Get-NativeCommandOutput -FilePath "git" -ArgumentList @("-C", $RepoRoot, "ls-remote", "--tags", $RemoteName, "refs/tags/$TagName") -FailureMessage "Unable to check remote git tags on '$RemoteName'"
    $remoteTagOutput = ($remoteTag | Out-String).Trim()

    if (-not [string]::IsNullOrWhiteSpace($remoteTagOutput)) {
        throw "The remote git tag '$TagName' already exists on '$RemoteName'."
    }
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
if ($Publish) {
    Write-Host " Publish Mode: enabled (remote '$RemoteName')" -ForegroundColor Cyan
}
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

$repoRoot = $PSScriptRoot
$releaseCommitCreated = $false
$releaseTagCreated = $false
$currentBranch = $null

if ($Publish) {
    Assert-CleanGitWorkingTree -RepoRoot $repoRoot
    Assert-GitRemoteExists -RepoRoot $repoRoot -RemoteName $RemoteName
    $currentBranch = Get-GitCurrentBranch -RepoRoot $repoRoot
}

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
    $tagName = "v$actualVersion"

    if ($Publish) {
        Assert-GitTagAvailable -RepoRoot $repoRoot -RemoteName $RemoteName -TagName $tagName
    }

    Write-Host "[2/3] Installing/verifying dependencies..." -ForegroundColor Yellow
    Invoke-NativeCommand -FilePath "npm" -ArgumentList @("install") -FailureMessage "npm install failed"

    Write-Host "[3/3] Compiling backend and packaging NSIS Installer..." -ForegroundColor Yellow
    Remove-StaleBuildOutput -Path $stalePackagePath
    Invoke-NativeCommand -FilePath "npm" -ArgumentList @("run", "make") -FailureMessage "npm run make failed"

    if ($Publish) {
        Write-Host "[4/5] Creating release commit..." -ForegroundColor Yellow
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $repoRoot, "add", "--", "overlay/package.json", "overlay/package-lock.json") -FailureMessage "git add failed"

        $stagedFiles = Get-NativeCommandOutput -FilePath "git" -ArgumentList @("-C", $repoRoot, "diff", "--cached", "--name-only") -FailureMessage "Unable to inspect staged files"
        $stagedOutput = ($stagedFiles | Out-String).Trim()

        if ([string]::IsNullOrWhiteSpace($stagedOutput)) {
            throw "No releasable version changes were staged. Refusing to publish '$tagName' without a version bump commit."
        }

        Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $repoRoot, "commit", "-m", "Release $tagName") -FailureMessage "git commit failed"
        $releaseCommitCreated = $true

        Write-Host "[5/5] Pushing branch and release tag..." -ForegroundColor Yellow
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $repoRoot, "tag", "-a", $tagName, "-m", "Release $tagName") -FailureMessage "git tag failed"
        $releaseTagCreated = $true

        Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $repoRoot, "push", $RemoteName, $currentBranch) -FailureMessage "git push failed"
        Invoke-NativeCommand -FilePath "git" -ArgumentList @("-C", $repoRoot, "push", $RemoteName, $tagName) -FailureMessage "git push tag failed"
    }

    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host " SUCCESS!" -ForegroundColor Green
    Write-Host " Built version: $actualVersion" -ForegroundColor Green
    Write-Host " The new installer (.exe) is located in:" -ForegroundColor Green
    Write-Host " $(Resolve-Path dist-app)\" -ForegroundColor Gray
    if ($Publish) {
        Write-Host " Published branch '$currentBranch' and tag '$tagName' to '$RemoteName'." -ForegroundColor Green
        Write-Host " GitHub Actions will build and attach the release assets for $tagName." -ForegroundColor Green
    }
    Write-Host "=========================================" -ForegroundColor Green
} catch {
    if ($versionWasUpdated -and -not $releaseCommitCreated) {
        Restore-TextFile -Path $packageJsonPath -Content $packageJsonBackup
        Restore-TextFile -Path $packageLockPath -Content $packageLockBackup
    }

    Write-Host ""
    Write-Host "=========================================" -ForegroundColor Red
    Write-Host " BUILD FAILED" -ForegroundColor Red
    Write-Host " $_" -ForegroundColor Red
    if ($versionWasUpdated -and -not $releaseCommitCreated) {
        Write-Host " package.json and package-lock.json were restored to their pre-build versions." -ForegroundColor Yellow
    }
    if ($releaseCommitCreated) {
        Write-Host " A local release commit was created and was not rolled back." -ForegroundColor Yellow
    }
    if ($releaseTagCreated) {
        Write-Host " A local git tag was created and may need cleanup if you do not want to keep it." -ForegroundColor Yellow
    }
    Write-Host "=========================================" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
