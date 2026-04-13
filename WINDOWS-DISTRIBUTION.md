# Windows Distribution

Recommended approach for this app:

- Keep Electron as the desktop shell because the overlay already depends on it.
- Package the Bun tracker backend as a standalone Windows executable.
- Ship both together with `electron-builder` using the `NSIS` target so Windows users get a visual installation wizard with desktop shortcut options.

Why this shape:

- Users do not need Bun, Node, or Python installed.
- Electron can start the tracker backend automatically and point the overlay at the correct local port.
- Writable runtime data lives in the app's `%LOCALAPPDATA%` user data directory instead of inside the packaged app.

Current commands:

```powershell
cd overlay
npm install
npm run backend:build
npm run make
```

Direct `electron-builder` artifacts are written to:

```text
overlay\dist-app
```

To build a native Windows ARM64 installer directly from `overlay/`:

```powershell
$env:BUN_BACKEND_TARGET = "bun-windows-arm64"
npm run make -- --arm64
```

Windows ARM64 packaging requires Bun 1.3.12 or newer.
Local ARM64 packaging also requires the Visual Studio Desktop development with C++ workload and the ARM64 MSVC tools because `electron-overlay-window` is rebuilt natively.

Release helper assets are written to:

```text
dist-release
```

Silent install or update from PowerShell:

```powershell
Start-Process -FilePath '.\MTGA Tracker Setup X.Y.Z-arm64.exe' -ArgumentList '/S' -Wait
```

- `/S` runs the NSIS installer silently.
- Silent upgrades reuse the existing install location and update it in place.

Release publishing:

- Local build only:

```powershell
.\Build-Release.ps1 -Version patch
```

This builds the x64 installer locally.

To build only the arm64 installer locally:

```powershell
.\Build-Release.ps1 -Version patch -Architectures arm64
```

To build both local installers:

```powershell
.\Build-Release.ps1 -Version patch -Architectures x64,arm64
```

- Build, commit, tag, push, and publish through GitHub Actions:

```powershell
.\Build-Release.ps1 -Version patch -Publish
```

What `-Publish` does:

- requires a clean git working tree
- bumps the app version in `overlay\package.json`
- builds the x64 installer locally first by default
- creates a `Release vX.Y.Z` commit
- creates and pushes a matching `vX.Y.Z` tag
- triggers `.github/workflows/release.yml`, which rebuilds on `windows-latest` and attaches x64 and arm64 installers, blockmaps, and checksums to the GitHub Release

Why use Actions for the actual release assets:

- the official release is built from a tagged commit inside GitHub, not from a one-off local machine state
- the GitHub Release remains reproducible and tied to the exact source revision
- reruns happen in CI if the publish step needs to be retried

Backend build target:

- Default: `bun-windows-x64`
- Override: set `BUN_BACKEND_TARGET` to match the installer architecture you are building

Example:

```powershell
$env:BUN_BACKEND_TARGET = "bun-windows-x64-baseline"
npm run backend:build
```

For native ARM64 packaging, use:

```powershell
$env:BUN_BACKEND_TARGET = "bun-windows-arm64"
npm run make -- --arm64
```

Note:

- The standard `x64` target is working locally.
- The `x64-baseline` target is preferable for broader CPU compatibility, but Bun's baseline runtime download failed in this environment during testing, so it is exposed as an override instead of the default.
