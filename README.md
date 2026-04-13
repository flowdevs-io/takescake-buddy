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

To publish an official GitHub release, use:

```powershell
.\Build-Release.ps1 -Version patch -Publish
```

That flow:

- requires a clean git working tree
- bumps `overlay/package.json`
- builds the Windows installer locally
- creates a `Release vX.Y.Z` commit
- creates and pushes a `vX.Y.Z` tag
- lets GitHub Actions build the tagged commit on Windows and publish the release assets

## GitHub releases

The repo includes a tag-driven workflow at `.github/workflows/release.yml`.

- pushing a tag like `v1.0.18` triggers a Windows build on GitHub Actions
- the workflow publishes the installer `.exe`, its `.blockmap`, and a `.sha256` checksum to the GitHub Release
- the local script is the intended entry point so the package version, git commit, tag, and release stay aligned

## Notes

- Large generated assets, package output, local card image caches, and sqlite runtime files are intentionally ignored by Git.
- Packaging details and target notes live in [WINDOWS-DISTRIBUTION.md](WINDOWS-DISTRIBUTION.md).
