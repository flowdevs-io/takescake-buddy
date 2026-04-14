const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { detectElectronArch, rebuildOverlayWindow } = require('./rebuild-overlay-window');

const overlayDir = path.resolve(__dirname, '..');

function runCommand(command, args) {
  console.log(`[overlay:build] ${command} ${args.join(' ')}`);

  const result = spawnSync(command, args, {
    cwd: overlayDir,
    env: process.env,
    stdio: 'inherit'
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function escapePowerShellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveElectronBuilderCli() {
  return require.resolve('electron-builder/out/cli/cli.js', {
    paths: [overlayDir]
  });
}

function resolveOutputDir(args) {
  const outputArg = args.find((arg) => arg.startsWith('-c.directories.output='));
  if (!outputArg) {
    return path.join(overlayDir, 'dist-app');
  }

  const configuredPath = outputArg.slice('-c.directories.output='.length);
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(overlayDir, configuredPath);
}

function hasExplicitOutputDir(args) {
  return args.some((arg) => arg.startsWith('-c.directories.output='));
}

function resolveTargetArch(args) {
  if (args.includes('--arm64')) {
    return 'arm64';
  }

  if (args.includes('--x64')) {
    return 'x64';
  }

  return detectElectronArch();
}

function getDefaultBunTarget(targetArch) {
  return targetArch === 'arm64' ? 'bun-windows-arm64' : 'bun-windows-x64';
}

function isBunTargetCompatible(bunTarget, targetArch) {
  const normalizedTarget = String(bunTarget || '').toLowerCase();
  if (targetArch === 'arm64') {
    return normalizedTarget.includes('arm64');
  }

  return normalizedTarget.includes('x64') && !normalizedTarget.includes('arm64');
}

function isWindowsLockError(error) {
  return !!error && (error.code === 'EPERM' || error.code === 'EBUSY');
}

function createFallbackOutputDir(targetArch) {
  return path.join(overlayDir, `dist-app-${targetArch}-${Date.now()}`);
}

function stopProcessesUnderPath(targetPath) {
  if (process.platform !== 'win32') {
    return;
  }

  const resolvedTargetPath = escapePowerShellLiteral(path.resolve(targetPath));
  const script = `
$targetPath = '${resolvedTargetPath}'
$processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -like "$targetPath*"
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
    console.warn(`[overlay:build] Stopped processes under ${targetPath}:\n${result.stdout.trim()}`);
  }

  if (result.error) {
    console.warn(`[overlay:build] Failed to stop processes under ${targetPath}: ${result.error.message}`);
  }
}

function clearOutputDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });

  clearDirectoryContents(targetPath);
}

function clearDirectoryContents(targetPath, allowLockedEntries = false) {
  for (const entry of fs.readdirSync(targetPath)) {
    const entryPath = path.join(targetPath, entry);
    const entryStats = fs.lstatSync(entryPath);
    const isDirectory = entryStats.isDirectory();
    const allowLockedEntry = allowLockedEntries || entry === 'staging';

    if (isDirectory) {
      clearDirectoryContents(entryPath, allowLockedEntry);
    }

    try {
      fs.rmSync(entryPath, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 300
      });
    } catch (error) {
      const isLockedEntry = error && (error.code === 'EPERM' || error.code === 'EBUSY');
      if (isLockedEntry && isDirectory) {
        const label = allowLockedEntry ? 'Leaving locked staging directory in place' : 'Leaving locked directory root in place';
        console.warn(`[overlay:build] ${label}: ${entryPath}`);
        continue;
      }

      if (isLockedEntry && allowLockedEntry) {
        console.warn(`[overlay:build] Leaving locked staging entry in place: ${entryPath}`);
        continue;
      }

      throw error;
    }
  }
}

async function prepareOutputDir(targetPath) {
  if (process.platform === 'win32') {
    stopProcessesUnderPath(targetPath);
    await sleep(500);
  }

  clearOutputDir(targetPath);
}

async function resolvePreparedOutput(targetArch, electronBuilderArgs) {
  const configuredOutputDir = resolveOutputDir(electronBuilderArgs);

  try {
    await prepareOutputDir(configuredOutputDir);
    return {
      outputDir: configuredOutputDir,
      electronBuilderArgs
    };
  } catch (error) {
    if (hasExplicitOutputDir(electronBuilderArgs) || !isWindowsLockError(error)) {
      throw error;
    }

    const fallbackOutputDir = createFallbackOutputDir(targetArch);
    console.warn(`[overlay:build] Default output directory is locked. Falling back to ${fallbackOutputDir}`);
    await prepareOutputDir(fallbackOutputDir);

    return {
      outputDir: fallbackOutputDir,
      electronBuilderArgs: [...electronBuilderArgs, `-c.directories.output=${fallbackOutputDir}`]
    };
  }
}

async function main() {
  const requestedElectronBuilderArgs = process.argv.slice(2);
  const targetArch = resolveTargetArch(requestedElectronBuilderArgs);
  const previousBunTarget = process.env.BUN_BACKEND_TARGET;
  const defaultBunTarget = getDefaultBunTarget(targetArch);

  if (!previousBunTarget) {
    process.env.BUN_BACKEND_TARGET = defaultBunTarget;
    console.log(`[overlay:build] Using BUN_BACKEND_TARGET=${defaultBunTarget}`);
  } else if (!isBunTargetCompatible(previousBunTarget, targetArch)) {
    console.warn(`[overlay:build] Warning: BUN_BACKEND_TARGET=${previousBunTarget} does not match the requested ${targetArch} package architecture.`);
  }

  try {
    await rebuildOverlayWindow(targetArch);
    runCommand(process.execPath, [path.join(__dirname, 'build-backend.js')]);
    runCommand(process.execPath, [path.join(__dirname, 'build-scraper.js')]);
    const preparedOutput = await resolvePreparedOutput(targetArch, requestedElectronBuilderArgs);
    console.log(`[overlay:build] Using electron-builder output directory ${preparedOutput.outputDir}`);
    runCommand(process.execPath, [resolveElectronBuilderCli(), 'build', ...preparedOutput.electronBuilderArgs]);
  } finally {
    if (!previousBunTarget) {
      delete process.env.BUN_BACKEND_TARGET;
    } else {
      process.env.BUN_BACKEND_TARGET = previousBunTarget;
    }
  }
}

main().catch((error) => {
  console.error('[overlay:build] Failed:', error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});