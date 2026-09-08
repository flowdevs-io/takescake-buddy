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

`npm start` rebuilds `electron-overlay-window` for the Electron binary that is actually installed in `overlay/node_modules` when the native overlay backend is in use. On Windows ARM64, the app now uses a PowerShell-based window tracker instead of the native addon, so local ARM runs no longer depend on a native overlay rebuild.

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
npm run make:arm64
```

`make:x64`, `make:arm64`, `package:x64`, and `package:arm64` automatically choose the matching Bun backend target unless you explicitly override `BUN_BACKEND_TARGET` yourself.

Windows ARM64 packaging requires Bun 1.3.12 or newer.
The packaged ARM64 app uses a PowerShell-based overlay tracker instead of `electron-overlay-window`, so local ARM64 builds no longer require the Visual Studio ARM64 C++ toolchain.

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

## takescake.com Web Integration

MTGA Tracker Pro integrates directly with [takescake.com](https://takescake.com):
- **Web Distribution Portal**: Hosted on [takescake.com/download](https://takescake.com/download) with high-speed delivery and dynamic GitHub Release fallback (`/api/download`).
- **Telemetry & Health Probe**: `takescake.com` client-side probes `http://localhost:3000/api/state` to detect when MTGA Tracker Pro is running and display active player rank, daily wins, and wildcard inventory.
- **Bi-Directional Deck Studio Crafting Sync**: `POST /api/crafting-cost` calculates the exact rare and mythic wildcards needed for any deck built on `takescake.com` against the player's live local MTGA collection.
- **Fair Play & WotC Compliance**: Fully transparent, log-reading only (`Player.log`), with zero memory injection and zero network packet sniffing.

## Notes

- Large generated assets, package output, local card image caches, and sqlite runtime files are intentionally ignored by Git.
- Packaging details and target notes live in [WINDOWS-DISTRIBUTION.md](WINDOWS-DISTRIBUTION.md).

