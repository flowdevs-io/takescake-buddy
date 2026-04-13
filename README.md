# takescake-buddy

Windows desktop tooling for MTG Arena tracking and overlay display.

The repo currently contains:

- `overlay/`: the Electron desktop shell and Windows packaging config
- `scraper/`: the tracker, collection/history logic, and UI/backend source
- `Build-Release.ps1`: release helper for version bumps and Windows builds
- `WINDOWS-DISTRIBUTION.md`: packaging notes for the Windows installer flow

## Stack

- Electron for the desktop overlay shell
- Bun for compiling the tracker backend executables
- Python/TypeScript sources under `scraper/`
- `electron-builder` for Windows distribution

## Local development

Install overlay dependencies:

```powershell
cd overlay
npm install
```

Start the Electron app:

```powershell
npm start
```

## Build the backend binaries

From `overlay/`:

```powershell
npm run backend:build
npm run scraper:build
```

Compiled backend artifacts are written to:

```text
overlay\dist\backend
```

## Build the Windows installer

From `overlay/`:

```powershell
npm run make
```

Installer output is written to:

```text
overlay\dist-app
```

There is also a release helper at the repo root:

```powershell
.\Build-Release.ps1 -Version patch
```

## Notes

- Large generated assets, package output, local card image caches, and sqlite runtime files are intentionally ignored by Git.
- Packaging details and target notes live in [WINDOWS-DISTRIBUTION.md](WINDOWS-DISTRIBUTION.md).
