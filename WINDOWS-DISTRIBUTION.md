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

Artifacts are written to:

```text
overlay\dist-app
```

Release publishing:

- Local build only:

```powershell
.\Build-Release.ps1 -Version patch
```

- Build, commit, tag, push, and publish through GitHub Actions:

```powershell
.\Build-Release.ps1 -Version patch -Publish
```

What `-Publish` does:

- requires a clean git working tree
- bumps the app version in `overlay\package.json`
- builds the installer locally first
- creates a `Release vX.Y.Z` commit
- creates and pushes a matching `vX.Y.Z` tag
- triggers `.github/workflows/release.yml`, which rebuilds on `windows-latest` and attaches the installer, blockmap, and checksum to the GitHub Release

Why use Actions for the actual release assets:

- the official release is built from a tagged commit inside GitHub, not from a one-off local machine state
- the GitHub Release remains reproducible and tied to the exact source revision
- reruns happen in CI if the publish step needs to be retried

Backend build target:

- Default: `bun-windows-x64`
- Override: set `BUN_BACKEND_TARGET`

Example:

```powershell
$env:BUN_BACKEND_TARGET = "bun-windows-x64-baseline"
npm run backend:build
```

Note:

- The standard `x64` target is working locally.
- The `x64-baseline` target is preferable for broader CPU compatibility, but Bun's baseline runtime download failed in this environment during testing, so it is exposed as an override instead of the default.
