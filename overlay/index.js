const { app, BrowserWindow, globalShortcut, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { getOverlayRuntimeDecision } = require('./overlay-runtime-config');

// MTGA window title — Steam version uses 'MTGA'
function loadOverlayRuntime() {
  const runtimeDecision = getOverlayRuntimeDecision();

  if (runtimeDecision.mode === 'fallback') {
    return {
      ...require('./windows-overlay-fallback'),
      label: 'powershell-fallback',
      reason: runtimeDecision.reason
    };
  }

  try {
    return {
      ...require('electron-overlay-window'),
      label: 'native',
      reason: runtimeDecision.reason
    };
  } catch (error) {
    if (process.platform !== 'win32') {
      throw error;
    }

    const renderedError = error instanceof Error ? error.message : String(error);
    console.warn(`[overlay] Native overlay runtime failed to load, switching to the PowerShell fallback: ${renderedError}`);

    return {
      ...require('./windows-overlay-fallback'),
      label: 'powershell-fallback',
      reason: `native load failed: ${renderedError}`
    };
  }
}

const {
  OverlayController,
  OVERLAY_WINDOW_OPTS,
  label: overlayRuntimeLabel,
  reason: overlayRuntimeReason
} = loadOverlayRuntime();

const MTGA_WINDOW_TITLES = ['MTGA', 'Magic: The Gathering Arena'];

let overlayWin;
let launcherWin;
let backendProcess = null;
let backendPort = null;
let tray = null;
let isAppQuitting = false;

const ICON_PATH = path.join(__dirname, 'build', 'icon.png');

function renderStatusPage(title, detail) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
        <style>
          html, body {
            margin: 0;
            min-height: 100%;
            background: transparent;
            color: #f8fafc;
            font-family: "Segoe UI", sans-serif;
          }

          body {
            display: flex;
            align-items: flex-start;
            justify-content: flex-start;
            padding: 24px;
          }

          .panel {
            max-width: 440px;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(15, 23, 42, 0.88);
            border-radius: 18px;
            padding: 18px 20px;
            box-shadow: 0 20px 60px rgba(15, 23, 42, 0.4);
          }

          h1 {
            margin: 0 0 10px;
            font-size: 18px;
          }

          p {
            margin: 0;
            line-height: 1.45;
            font-size: 13px;
            color: #cbd5e1;
            white-space: pre-wrap;
          }
        </style>
      </head>
      <body>
        <div class="panel">
          <h1>${title}</h1>
          <p>${detail}</p>
        </div>
      </body>
    </html>
  `)}`;
}

function getRepoRoot() {
  return path.resolve(__dirname, '..');
}

function getDataDir() {
  return app.isPackaged
    ? app.getPath('userData')
    : path.join(getRepoRoot(), 'scraper');
}

function getBackendCommand() {
  if (app.isPackaged) {
    return {
      command: path.join(process.resourcesPath, 'backend', 'mtga-tracker-backend.exe'),
      args: []
    };
  }

  return {
    command: 'bun',
    args: [path.join(getRepoRoot(), 'scraper', 'ui.ts')]
  };
}

function getPreferredPort() {
  const fromEnv = Number(process.env.PORT || process.env.MTGA_TRACKER_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : 3000;
}

function reservePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : preferredPort;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function resolveBackendPort() {
  try {
    return await reservePort(getPreferredPort());
  } catch {
    return reservePort(0);
  }
}

async function waitForBackend(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
      lastError = new Error(`Health check failed with ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError || new Error('Timed out waiting for backend');
}

async function startBackend() {
  const dataDir = getDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const { command, args } = getBackendCommand();
  if (!fs.existsSync(command) && app.isPackaged) {
    throw new Error(`Bundled backend executable not found at ${command}`);
  }

  backendPort = await resolveBackendPort();
  const child = spawn(command, args, {
    cwd: app.isPackaged ? dataDir : getRepoRoot(),
    env: {
      ...process.env,
      PORT: String(backendPort),
      TRACKER_DATA_DIR: dataDir
    },
    stdio: app.isPackaged ? 'ignore' : 'inherit',
    windowsHide: true
  });

  backendProcess = child;
  child.once('exit', (code, signal) => {
    backendProcess = null;
    console.log(`[overlay] Backend exited (code=${code}, signal=${signal})`);
  });
  child.once('error', (error) => {
    console.error('[overlay] Backend failed to start:', error);
  });

  const baseUrl = `http://127.0.0.1:${backendPort}`;
  await waitForBackend(baseUrl);
  return baseUrl;
}

function stopBackend() {
  if (!backendProcess || backendProcess.killed) return;
  backendProcess.kill();
}

function getScraperCommand() {
  if (app.isPackaged) {
    const scraperExe = path.join(process.resourcesPath, 'backend', 'mtga-tracker-scraper.exe');
    return fs.existsSync(scraperExe) ? { command: scraperExe, args: [] } : null;
  }
  // Dev: run scraper.ts directly with bun
  const scraperTs = path.join(getRepoRoot(), 'scraper', 'scraper.ts');
  if (!fs.existsSync(scraperTs)) return null;
  return { command: 'bun', args: [scraperTs] };
}

let scraperProcess = null;

function startScraper() {
  const dataDir = getDataDir();
  const cmd = getScraperCommand();
  if (!cmd) return;

  scraperProcess = spawn(cmd.command, cmd.args, {
    cwd: dataDir,
    env: {
      ...process.env,
      TRACKER_DATA_DIR: dataDir
    },
    stdio: app.isPackaged ? 'ignore' : 'inherit',
    windowsHide: true
  });

  scraperProcess.once('exit', () => { scraperProcess = null; });
  scraperProcess.once('error', (err) => {
    console.error('[overlay] Scraper failed to start:', err.message);
    scraperProcess = null;
  });
}

function stopScraper() {
  if (!scraperProcess || scraperProcess.killed) return;
  scraperProcess.kill();
}

function createWindows() {
  console.log(`[overlay] Using ${overlayRuntimeLabel} runtime (${overlayRuntimeReason})`);

  launcherWin = new BrowserWindow({
    width: 1200,
    height: 800,
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: ICON_PATH
  });
  
  launcherWin.loadURL(renderStatusPage('Starting MTGA Tracker', 'Launching the local tracker service...')).catch(() => {});

  launcherWin.on('close', (event) => {
    if (!isAppQuitting) {
      event.preventDefault();
      launcherWin.hide();
    }
  });

  overlayWin = new BrowserWindow({
    ...OVERLAY_WINDOW_OPTS,
    // electron-overlay-window will resize this to match MTGA — that's intentional.
    // The HTML page positions the widget panel in the corner; the rest is transparent + click-through.
    width: 1920,
    height: 1080,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: ICON_PATH
  });

  overlayWin.loadURL(renderStatusPage('Starting overlay', 'Launching the local tracker service...')).catch(() => {});

  // Initialize as click-through so we don't block the game immediately
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  // Attach the overlay to the MTGA game window
  if (typeof OverlayController.attachByTitles === 'function') {
    OverlayController.attachByTitles(overlayWin, MTGA_WINDOW_TITLES);
  } else {
    OverlayController.attachByTitle(overlayWin, MTGA_WINDOW_TITLES[0]);
  }

  OverlayController.events.on('attach', () => {
    console.log('[overlay] Attached to MTGA — game window found');
  });

  OverlayController.events.on('detach', () => {
    console.log('[overlay] Detached — MTGA closed or lost');
  });

  OverlayController.events.on('fullscreen', (event) => {
    console.log('[overlay] Fullscreen:', event?.isFullscreen);
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('MTGA Tracker');
  
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open Dashboard',
      click: () => {
        if (launcherWin) {
          launcherWin.show();
          launcherWin.focus();
        }
      }
    },
    {
      label: 'Toggle Overlay (Show/Hide)',
      click: () => {
        if (overlayWin && !overlayWin.isDestroyed()) {
          if (overlayWin.isVisible()) {
            overlayWin.hide();
          } else {
            overlayWin.showInactive();
            overlayWin.setAlwaysOnTop(true, 'screen-saver');
          }
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Tracker',
      click: () => {
        isAppQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    if (launcherWin) {
      launcherWin.show();
      launcherWin.focus();
    }
  });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to run a second instance, we should focus our window.
    if (launcherWin) {
      if (launcherWin.isMinimized()) launcherWin.restore();
      launcherWin.show();
      launcherWin.focus();
    }
  });

  app.whenReady().then(async () => {
    ipcMain.on('app-close', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        if (win === launcherWin) {
          win.hide();
        } else {
          win.close();
        }
      }
    });

    ipcMain.on('app-minimize', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) win.minimize();
    });

    ipcMain.on('app-maximize', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        if (win.isMaximized()) win.restore();
        else win.maximize();
      }
    });

    createWindows();
    createTray();

  let isInteractive = false;
  globalShortcut.register('Alt+Shift+F', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      isInteractive = !isInteractive;
      overlayWin.setIgnoreMouseEvents(!isInteractive, { forward: true });
      if (isInteractive) {
        overlayWin.focus();
        overlayWin.webContents.executeJavaScript('document.body.classList.add("interactive")');
      } else {
        overlayWin.blur();
        overlayWin.webContents.executeJavaScript('document.body.classList.remove("interactive")');
      }
    }
  });

  globalShortcut.register('Alt+Shift+M', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.executeJavaScript('window.toggleMinimize && window.toggleMinimize()');
    }
  });

  globalShortcut.register('Alt+Shift+X', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.executeJavaScript('window.closeOverlay && window.closeOverlay()');
    }
  });

  globalShortcut.register('Alt+Shift+O', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.webContents.executeJavaScript('window.openOverlay && window.openOverlay()');
    }
  });

  globalShortcut.register('Alt+Shift+V', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      if (overlayWin.isVisible()) {
        overlayWin.hide();
      } else {
        overlayWin.showInactive();
        overlayWin.setAlwaysOnTop(true, 'screen-saver');
      }
    }
  });

  try {
    const baseUrl = await startBackend();
    startScraper();

    await Promise.all([
      launcherWin.loadURL(`${baseUrl}/collection`),
      overlayWin.loadURL(`${baseUrl}/overlay`)
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[overlay] Startup failed:', message);
    if (launcherWin && !launcherWin.isDestroyed()) {
      await launcherWin.loadURL(renderStatusPage('Tracker failed to start', message));
    }
  }
});

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('before-quit', () => {
    isAppQuitting = true;
    if (typeof OverlayController.dispose === 'function') {
      OverlayController.dispose();
    }
    stopBackend();
    stopScraper();
  });

  app.on('window-all-closed', () => {
    // Overridden to do nothing since we use a system tray
    // The app will remain open until Quit is clicked in the tray.
  });
}
