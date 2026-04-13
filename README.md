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

To build a specific Windows architecture directly, set the matching Bun target and pass the matching `electron-builder` flag:

```powershell
$env:BUN_BACKEND_TARGET = "bun-windows-arm64"
npm run make -- --arm64
```

Windows ARM64 packaging requires Bun 1.3.12 or newer.
Local ARM64 packaging also requires the Visual Studio Desktop development with C++ workload and the ARM64 MSVC tools because `electron-overlay-window` is rebuilt natively.

There is also a release helper at the repo root:

```powershell
.\Build-Release.ps1 -Version patch
```

That command builds the x64 installer locally.

To build only the arm64 installer locally, use:

```powershell
.\Build-Release.ps1 -Version patch -Architectures arm64
```

To build both local installers, use:

```powershell
.\Build-Release.ps1 -Version patch -Architectures x64,arm64
```

To publish an official GitHub release, use:

```powershell
.\Build-Release.ps1 -Version patch -Publish
```

That flow:

- requires a clean git working tree
- bumps `overlay/package.json`
- builds the Windows x64 installer locally by default
- creates a `Release vX.Y.Z` commit
- creates and pushes a `vX.Y.Z` tag
- lets GitHub Actions build and publish both x64 and arm64 release assets

Release helper output is written to:

```text
dist-release
```

## GitHub releases

The repo includes a tag-driven workflow at `.github/workflows/release.yml`.

- pushing a tag like `v1.0.18` triggers a Windows build on GitHub Actions
- the workflow publishes x64 and arm64 installers, each with a `.blockmap` and a `.sha256` checksum, to the GitHub Release
- the local script is the intended entry point so the package version, git commit, tag, and release stay aligned

## Notes

- Large generated assets, package output, local card image caches, and sqlite runtime files are intentionally ignored by Git.
- Packaging details and target notes live in [WINDOWS-DISTRIBUTION.md](WINDOWS-DISTRIBUTION.md).
