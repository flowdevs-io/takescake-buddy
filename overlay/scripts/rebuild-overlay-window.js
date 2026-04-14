const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { rebuild } = require('@electron/rebuild');
const { shouldRebuildNativeOverlay } = require('../overlay-runtime-config');

const VALID_ARCHS = new Set(['x64', 'arm64']);
const overlayDir = path.resolve(__dirname, '..');

function readPeMachine(filePath) {
  const buffer = fs.readFileSync(filePath);
  const peOffset = buffer.readUInt32LE(0x3c);
  const machine = buffer.readUInt16LE(peOffset + 4);

  switch (machine) {
    case 0x8664:
      return 'x64';
    case 0xaa64:
      return 'arm64';
    case 0x14c:
      return 'ia32';
    default:
      return `unknown-0x${machine.toString(16)}`;
  }
}

function getElectronExePath() {
  return path.join(overlayDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
}

function detectElectronArch() {
  const electronExePath = getElectronExePath();

  if (process.platform === 'win32' && fs.existsSync(electronExePath)) {
    const detectedArch = readPeMachine(electronExePath);
    if (VALID_ARCHS.has(detectedArch)) {
      return detectedArch;
    }
  }

  return process.arch;
}

function resolveTargetArch(requestedArch) {
  if (!requestedArch) {
    return detectElectronArch();
  }

  const normalizedArch = String(requestedArch).toLowerCase();
  if (!VALID_ARCHS.has(normalizedArch)) {
    throw new Error(`Unsupported overlay target architecture '${requestedArch}'. Expected one of: ${[...VALID_ARCHS].join(', ')}`);
  }

  return normalizedArch;
}

function getElectronVersion() {
  const electronPackageJsonPath = path.join(overlayDir, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(electronPackageJsonPath)) {
    throw new Error('Electron is not installed. Run npm install in overlay/.');
  }

  return require(electronPackageJsonPath).version;
}

function escapePowerShellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function stopRepoLocalElectronProcesses() {
  if (process.platform !== 'win32') {
    return;
  }

  const targetDir = escapePowerShellLiteral(overlayDir);
  const electronExePath = escapePowerShellLiteral(getElectronExePath());
  const script = `
$targetDir = '${targetDir}'
$electronExePath = '${electronExePath}'
$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -eq 'electron.exe' -and (
    $_.ExecutablePath -eq $electronExePath -or
    $_.CommandLine -like "*$targetDir*"
  )
}
if (-not $processes) { return }
$processes | Select-Object Name, ProcessId, ExecutablePath | Format-Table -AutoSize | Out-String | Write-Output
$processes | ForEach-Object {
  try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { }
}
`.trim();

  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: overlayDir,
    encoding: 'utf8',
    windowsHide: true
  });

  if (result.stdout && result.stdout.trim()) {
    console.warn(`[overlay:rebuild] Stopped repo-local Electron processes:\n${result.stdout.trim()}`);
  }

  if (result.error) {
    console.warn(`[overlay:rebuild] Failed to stop repo-local Electron processes: ${result.error.message}`);
    return;
  }

  if (result.status !== 0 && result.stderr && result.stderr.trim()) {
    console.warn(`[overlay:rebuild] PowerShell reported an issue while stopping Electron:\n${result.stderr.trim()}`);
  }
}

function clearOverlayBuildOutput(electronOverlayWindowPath) {
  const buildDir = path.join(electronOverlayWindowPath, 'build');

  fs.rmSync(buildDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockedAddonError(error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  return /EPERM|EBUSY/i.test(message) && /overlay_window\.node/i.test(message);
}

async function rebuildOverlayWindow(targetArch) {
  const electronOverlayWindowPath = path.join(overlayDir, 'node_modules', 'electron-overlay-window');
  if (!fs.existsSync(electronOverlayWindowPath)) {
    throw new Error('electron-overlay-window is not installed. Run npm install in overlay/.');
  }

  const electronVersion = getElectronVersion();
  console.log(`[overlay:rebuild] Rebuilding electron-overlay-window for Electron ${electronVersion} (${targetArch})`);

  if (process.platform === 'win32') {
    stopRepoLocalElectronProcesses();
    await sleep(500);
    clearOverlayBuildOutput(electronOverlayWindowPath);
  }

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await rebuild({
        buildPath: overlayDir,
        electronVersion,
        arch: targetArch,
        force: true,
        onlyModules: ['electron-overlay-window']
      });
      console.log(`[overlay:rebuild] Rebuilt electron-overlay-window for ${targetArch}`);
      return;
    } catch (error) {
      if (attempt === 2 || !isLockedAddonError(error)) {
        throw error;
      }

      console.warn('[overlay:rebuild] overlay_window.node is locked. Stopping the repo-local Electron app and retrying...');
      stopRepoLocalElectronProcesses();
      clearOverlayBuildOutput(electronOverlayWindowPath);
    }
  }

}

async function main() {
  const targetArch = resolveTargetArch(process.argv[2]);
  if (!shouldRebuildNativeOverlay(targetArch)) {
    console.log(`[overlay:rebuild] Skipping electron-overlay-window rebuild for ${targetArch} because the runtime uses the Windows ARM fallback tracker.`);
    return;
  }

  await rebuildOverlayWindow(targetArch);
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[overlay:rebuild] Failed:', error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

module.exports = {
  detectElectronArch,
  rebuildOverlayWindow,
  resolveTargetArch
};
