param(
    [Parameter(Mandatory=$true, HelpMessage="Version number or bump type (e.g. 2, 2.1, 1.0.1, major, minor, patch)")]
    [string]$Version,

    [switch]$Publish,

    [string]$RemoteName = "origin",

    [ValidateSet("x64", "arm64")]
    [string[]]$Architectures = @("x64")
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

function Get-NpmExecutable {
    # Prefer the cmd shim on Windows to avoid npm.ps1 strict-mode failures in Windows PowerShell 5.1.
    if ($env:OS -eq "Windows_NT") {
        return "npm.cmd"
    }

    return "npm"
}

function Resolve-VersionArgument {
    param(
        [Parameter(Mandatory=$true)]
        [string]$VersionArgument
    )

    if ($VersionArgument -match '^\d+$') {
        return "$VersionArgument.0.0"
    }

    if ($VersionArgument -match '^\d+\.\d+$') {
        return "$VersionArgument.0"
    }

    return $VersionArgument
}

function Get-BunVersion {
    $versionOutput = Get-NativeCommandOutput -FilePath "bun" -ArgumentList @("--version") -FailureMessage "bun --version failed"
    $resolvedVersion = ($versionOutput | Out-String).Trim()
    $versionMatch = [regex]::Match($resolvedVersion, '^\d+\.\d+\.\d+')

    if (-not $versionMatch.Success) {
        throw "Unable to parse Bun version from '$resolvedVersion'."
    }

    return $versionMatch.Value
}

function Assert-BunSupportsRequestedArchitectures {
    param(
        [Parameter(Mandatory=$true)]
        [string[]]$Architectures
    )

    if ($Architectures -notcontains "arm64") {
        return
    }

    $minimumArm64CompileVersion = [version]"1.3.12"
    $bunVersionString = Get-BunVersion
    $bunVersion = [version]$bunVersionString

    if ($bunVersion -lt $minimumArm64CompileVersion) {
        throw "Windows arm64 Bun compile support requires Bun $minimumArm64CompileVersion or newer. Current Bun version: $bunVersionString. Run 'bun upgrade' or build only x64 with -Architectures x64."
    }
}

function Get-VsWherePath {
    if ([string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        return $null
    }

    $vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path -LiteralPath $vswherePath) {
        return $vswherePath
    }

    return $null
}

function Get-VisualStudioInstallationPaths {
    param(
        [Parameter(Mandatory=$true)]
        [string]$VsWherePath
    )

    $vswhereOutput = Get-NativeCommandOutput -FilePath $VsWherePath -ArgumentList @(
        "-products",
        "*",
        "-format",
        "json"
    ) -FailureMessage "vswhere failed while listing Visual Studio installations"

    $serializedInstallations = ($vswhereOutput | Out-String).Trim()
    if ([string]::IsNullOrWhiteSpace($serializedInstallations) -or $serializedInstallations -eq "[]") {
        return @()
    }

    $installations = $serializedInstallations | ConvertFrom-Json
    return @($installations | Where-Object { -not [string]::IsNullOrWhiteSpace($_.installationPath) } | ForEach-Object { $_.installationPath })
}

function Test-VisualStudioArm64ToolchainAtPath {
    param(
        [Parameter(Mandatory=$true)]
        [string]$InstallationPath
    )

    $msbuildPath = Join-Path $InstallationPath "MSBuild\Current\Bin\MSBuild.exe"
    if (-not (Test-Path -LiteralPath $msbuildPath)) {
        return $false
    }

    $msvcRootPath = Join-Path $InstallationPath "VC\Tools\MSVC"
    if (-not (Test-Path -LiteralPath $msvcRootPath)) {
        return $false
    }

    $msvcToolDirectories = Get-ChildItem -LiteralPath $msvcRootPath -Directory -ErrorAction SilentlyContinue
    foreach ($msvcToolDirectory in $msvcToolDirectories) {
        $x64CompilerPath = Join-Path $msvcToolDirectory.FullName "bin\Hostx64\x64\cl.exe"
        $arm64CompilerPath = Join-Path $msvcToolDirectory.FullName "bin\Hostx64\arm64\cl.exe"

        if ((Test-Path -LiteralPath $x64CompilerPath) -and (Test-Path -LiteralPath $arm64CompilerPath)) {
            return $true
        }
    }

    return $false
}

function Assert-Arm64NativeBuildToolchainAvailable {
    $vswherePath = Get-VsWherePath

    if (-not $vswherePath) {
        throw "Windows arm64 packaging requires Visual Studio C++ ARM64 build tools, but vswhere.exe was not found to verify the installation. Install the Desktop development with C++ workload plus the ARM64 MSVC tools, or build only x64 with -Architectures x64."
    }

    $vswhereOutput = Get-NativeCommandOutput -FilePath $vswherePath -ArgumentList @(
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
        "Microsoft.VisualStudio.VC.MSBuild.Base",
        "-format",
        "json"
    ) -FailureMessage "vswhere failed while checking Visual Studio ARM64 build tools"

    $matchingInstallations = ($vswhereOutput | Out-String).Trim()
    if ($matchingInstallations -ne "[]") {
        return
    }

    $installationPaths = Get-VisualStudioInstallationPaths -VsWherePath $vswherePath
    foreach ($installationPath in $installationPaths) {
        if (Test-VisualStudioArm64ToolchainAtPath -InstallationPath $installationPath) {
            return
        }
    }

    throw "Windows arm64 packaging requires Visual Studio C++ ARM64 build tools. Install the Desktop development with C++ workload and the ARM64 MSVC tools, or build only x64 with -Architectures x64."
}

function Assert-LocalBuildToolchainSupportsRequestedArchitectures {
    param(
        [Parameter(Mandatory=$true)]
        [string[]]$Architectures
    )

    if ($Architectures -contains "arm64") {
        Assert-Arm64NativeBuildToolchainAvailable
    }
}

function Get-BunTargetForArchitecture {
    param(
        [Parameter(Mandatory=$true)]
        [ValidateSet("x64", "arm64")]
        [string]$Architecture
    )

    switch ($Architecture) {
        "x64" {
            return "bun-windows-x64"
        }
        "arm64" {
            return "bun-windows-arm64"
        }
    }
}

function Get-ElectronBuilderArgumentForArchitecture {
    param(
        [Parameter(Mandatory=$true)]
        [ValidateSet("x64", "arm64")]
        [string]$Architecture
    )

    switch ($Architecture) {
        "x64" {
            return "--x64"
        }
        "arm64" {
            return "--arm64"
        }
    }
}

function Reset-Directory {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Path
    )

    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    }

    $null = New-Item -ItemType Directory -Path $Path -Force
}

function Get-ReleaseInstallerName {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Version,

        [Parameter(Mandatory=$true)]
        [ValidateSet("x64", "arm64")]
        [string]$Architecture
    )

    return "MTGA Tracker Setup $Version-$Architecture.exe"
}

function Write-InstallerChecksum {
    param(
        [Parameter(Mandatory=$true)]
        [string]$InstallerPath
    )

    $hash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $leafName = Split-Path -Path $InstallerPath -Leaf
    Set-Content -LiteralPath "$InstallerPath.sha256" -Value "$hash *$leafName"
}

function Copy-InstallerArtifacts {
    param(
        [Parameter(Mandatory=$true)]
        [string]$SourceInstallerPath,

        [Parameter(Mandatory=$true)]
        [string]$ReleaseOutputPath,

        [Parameter(Mandatory=$true)]
        [string]$Version,

        [Parameter(Mandatory=$true)]
        [ValidateSet("x64", "arm64")]
        [string]$Architecture
    )

    if (-not (Test-Path -LiteralPath $SourceInstallerPath)) {
        throw "Expected installer was not produced: $SourceInstallerPath"
    }

    $sourceBlockmapPath = "$SourceInstallerPath.blockmap"
    if (-not (Test-Path -LiteralPath $sourceBlockmapPath)) {
        throw "Expected blockmap was not produced: $sourceBlockmapPath"
    }

    $installerName = Get-ReleaseInstallerName -Version $Version -Architecture $Architecture
    $destinationInstallerPath = Join-Path $ReleaseOutputPath $installerName

    Copy-Item -LiteralPath $SourceInstallerPath -Destination $destinationInstallerPath -Force
    Copy-Item -LiteralPath $sourceBlockmapPath -Destination "$destinationInstallerPath.blockmap" -Force
    Write-InstallerChecksum -InstallerPath $destinationInstallerPath

    return $destinationInstallerPath
}

function Invoke-InstallerBuild {
    param(
        [Parameter(Mandatory=$true)]
        [string]$NpmExecutable,

        [Parameter(Mandatory=$true)]
        [ValidateSet("x64", "arm64")]
        [string]$Architecture,

        [Parameter(Mandatory=$true)]
        [string]$StageOutputRootPath,

        [Parameter(Mandatory=$true)]
        [string]$ReleaseOutputPath,

        [Parameter(Mandatory=$true)]
        [string]$Version
    )

    $architectureDistAppPath = Join-Path $StageOutputRootPath $Architecture
    $baseInstallerPath = Join-Path $architectureDistAppPath "MTGA Tracker Setup $Version.exe"
    $bunTarget = Get-BunTargetForArchitecture -Architecture $Architecture
    $electronBuilderArgument = Get-ElectronBuilderArgumentForArchitecture -Architecture $Architecture
    $previousBunTarget = [Environment]::GetEnvironmentVariable("BUN_BACKEND_TARGET", "Process")

    try {
        [Environment]::SetEnvironmentVariable("BUN_BACKEND_TARGET", $bunTarget, "Process")
        Reset-Directory -Path $architectureDistAppPath

        Write-Host "  - Building Windows $Architecture installer..." -ForegroundColor DarkYellow
        Invoke-NativeCommand -FilePath $NpmExecutable -ArgumentList @("run", "make", "--", $electronBuilderArgument, "-c.directories.output=$architectureDistAppPath") -FailureMessage "npm run make failed for Windows $Architecture" | Out-Host

        $destinationInstallerPath = Copy-InstallerArtifacts -SourceInstallerPath $baseInstallerPath -ReleaseOutputPath $ReleaseOutputPath -Version $Version -Architecture $Architecture
        Write-Host "    Saved $(Split-Path -Leaf $destinationInstallerPath)" -ForegroundColor Gray

        return $destinationInstallerPath
    } finally {
        [Environment]::SetEnvironmentVariable("BUN_BACKEND_TARGET", $previousBunTarget, "Process")
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

    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
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

$targetArchitectures = $Architectures | Select-Object -Unique
Assert-BunSupportsRequestedArchitectures -Architectures $targetArchitectures
Assert-LocalBuildToolchainSupportsRequestedArchitectures -Architectures $targetArchitectures

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host " Building MTGA Tracker Installer" -ForegroundColor Cyan
Write-Host " Target Version: $Version" -ForegroundColor Cyan
Write-Host " Target Architectures: $($targetArchitectures -join ', ')" -ForegroundColor Cyan
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
$stageOutputRootPath = Join-Path $repoRoot (Join-Path ".release-staging" ([guid]::NewGuid().Guid))
$releaseOutputPath = Join-Path $repoRoot "dist-release"
$packageJsonPath = Join-Path (Get-Location) "package.json"
$packageLockPath = Join-Path (Get-Location) "package-lock.json"
$packageJsonBackup = Get-Content -LiteralPath $packageJsonPath -Raw
$packageLockBackup = if (Test-Path -LiteralPath $packageLockPath) {
    Get-Content -LiteralPath $packageLockPath -Raw
} else {
    $null
}
$npmExecutable = Get-NpmExecutable
$resolvedVersion = Resolve-VersionArgument -VersionArgument $Version
$buildStepLabel = if ($Publish) { "[3/5]" } else { "[3/3]" }
$builtInstallerPaths = @()
$versionWasUpdated = $false

try {
    Write-Host "[1/3] Updating package.json version..." -ForegroundColor Yellow
    Invoke-NativeCommand -FilePath $npmExecutable -ArgumentList @("version", $resolvedVersion, "--no-git-tag-version", "--allow-same-version") -FailureMessage "npm version failed"
    $versionWasUpdated = $true

    # Read the actual version that npm resolved (in case 'patch' or 'minor' was passed)
    $actualVersion = (Get-Content package.json | ConvertFrom-Json).version
    $tagName = "v$actualVersion"

    if ($Publish) {
        Assert-GitTagAvailable -RepoRoot $repoRoot -RemoteName $RemoteName -TagName $tagName
    }

    Write-Host "[2/3] Installing/verifying dependencies..." -ForegroundColor Yellow
    Invoke-NativeCommand -FilePath $npmExecutable -ArgumentList @("install") -FailureMessage "npm install failed"

    Reset-Directory -Path $releaseOutputPath

    Write-Host "$buildStepLabel Building Windows installers..." -ForegroundColor Yellow
    foreach ($architecture in $targetArchitectures) {
        $builtInstallerPaths += Invoke-InstallerBuild -NpmExecutable $npmExecutable -Architecture $architecture -StageOutputRootPath $stageOutputRootPath -ReleaseOutputPath $releaseOutputPath -Version $actualVersion
    }

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
    Write-Host " Built architectures: $($targetArchitectures -join ', ')" -ForegroundColor Green
    Write-Host " Release assets are located in:" -ForegroundColor Green
    Write-Host " $(Resolve-Path $releaseOutputPath)\" -ForegroundColor Gray
    foreach ($builtInstallerPath in $builtInstallerPaths) {
        Write-Host "  $(Split-Path -Leaf $builtInstallerPath)" -ForegroundColor Gray
    }
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
    if (Test-Path -LiteralPath $releaseOutputPath) {
        Write-Host " Partial release assets may exist in $(Resolve-Path $releaseOutputPath)\" -ForegroundColor Yellow
    }
    Write-Host "=========================================" -ForegroundColor Red
    exit 1
} finally {
    Pop-Location
}
