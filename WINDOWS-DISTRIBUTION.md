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
