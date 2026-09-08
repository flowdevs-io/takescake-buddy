const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { screen } = require('electron');

const OVERLAY_WINDOW_OPTS = {
  fullscreenable: true,
  skipTaskbar: true,
  frame: false,
  show: false,
  transparent: true,
  resizable: true,
  hasShadow: true
};

function encodePowerShellCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function escapePowerShellLiteral(value) {
  return String(value).replace(/'/g, "''");
}

function parseStateLine(line) {
  const parts = String(line || '').trim().split('\t');
  if (parts.length !== 8) {
    return null;
  }

  const numericParts = parts.slice(3).map((part) => Number.parseInt(part, 10));
  if (numericParts.some((value) => Number.isNaN(value))) {
    return null;
  }

  const [x, y, width, height, isFullscreenNumeric] = numericParts;

  return {
    found: parts[0] === '1',
    isFocused: parts[1] === '1',
    isMinimized: parts[2] === '1',
    x,
    y,
    width,
    height,
    isFullscreen: isFullscreenNumeric === 1
  };
}

function sameBounds(left, right) {
  return !!left &&
    !!right &&
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height;
}

function buildPowerShellMonitorScript(windowTitles) {
  const serializedTitles = windowTitles.map((title) => `'${escapePowerShellLiteral(title)}'`).join(', ');

  return `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public struct RECT
{
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public struct POINT
{
    public int X;
    public int Y;
}

public struct MONITORINFO
{
    public uint cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
}

public static class OverlayWin32
{
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLengthW(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint dwFlags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll")]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    [DllImport("user32.dll")]
    private static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO lpmi);

    private static bool IsMatchingWindowTitle(string title, string[] candidateTitles)
    {
        if (string.IsNullOrWhiteSpace(title)) return false;

        foreach (var candidateTitle in candidateTitles)
        {
            if (String.Equals(title, candidateTitle, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            if (candidateTitle.Length >= 4 && title.IndexOf(candidateTitle, StringComparison.OrdinalIgnoreCase) >= 0)
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsMatchingProcess(IntPtr hWnd)
    {
        uint pid;
        GetWindowThreadProcessId(hWnd, out pid);
        if (pid == 0) return false;
        try {
            var proc = System.Diagnostics.Process.GetProcessById((int)pid);
            if (proc.ProcessName.IndexOf("MTGA", StringComparison.OrdinalIgnoreCase) >= 0) {
                return true;
            }
        } catch {}
        return false;
    }

    private static IntPtr FindWindowByTitle(string[] candidateTitles)
    {
        IntPtr foundWindow = IntPtr.Zero;

        EnumWindowsProc evaluateWindow = (hWnd, _lParam) =>
        {
            if (!IsWindowVisible(hWnd))
            {
                return true;
            }

            int titleLength = GetWindowTextLengthW(hWnd);
            if (titleLength > 0)
            {
                var titleBuilder = new StringBuilder(titleLength + 1);
                if (GetWindowTextW(hWnd, titleBuilder, titleBuilder.Capacity) > 0)
                {
                    if (IsMatchingWindowTitle(titleBuilder.ToString(), candidateTitles))
                    {
                        foundWindow = hWnd;
                        return false;
                    }
                }
            }

            // Fallback: check if window belongs to MTGA process with reasonable dimensions
            if (IsMatchingProcess(hWnd))
            {
                RECT r;
                if (GetClientRect(hWnd, out r) && (r.Right - r.Left) > 300)
                {
                    foundWindow = hWnd;
                    return false;
                }
            }

            return true;
        };

        // Try standard desktop enumeration first
        EnumWindows(evaluateWindow, IntPtr.Zero);

        // If not found in current desktop, check Default user desktop
        if (foundWindow == IntPtr.Zero)
        {
            IntPtr hDesktop = OpenDesktop("Default", 0, false, 0x01FF);
            if (hDesktop != IntPtr.Zero)
            {
                EnumDesktopWindows(hDesktop, evaluateWindow, IntPtr.Zero);
                CloseDesktop(hDesktop);
            }
        }

        return foundWindow;
    }

    private static bool IsFullscreen(IntPtr hWnd)
    {
        RECT windowRect;
        if (!GetWindowRect(hWnd, out windowRect))
        {
            return false;
        }

        IntPtr monitor = MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST);
        if (monitor == IntPtr.Zero)
        {
            return false;
        }

        var monitorInfo = new MONITORINFO();
        monitorInfo.cbSize = (uint)Marshal.SizeOf(typeof(MONITORINFO));
        if (!GetMonitorInfoW(monitor, ref monitorInfo))
        {
            return false;
        }

        return Math.Abs(windowRect.Left - monitorInfo.rcMonitor.Left) <= 1 &&
            Math.Abs(windowRect.Top - monitorInfo.rcMonitor.Top) <= 1 &&
            Math.Abs(windowRect.Right - monitorInfo.rcMonitor.Right) <= 1 &&
            Math.Abs(windowRect.Bottom - monitorInfo.rcMonitor.Bottom) <= 1;
    }

    public static string FindState(string[] candidateTitles)
    {
        IntPtr hWnd = FindWindowByTitle(candidateTitles);
        if (hWnd == IntPtr.Zero)
        {
            return "0\\t0\\t0\\t0\\t0\\t0\\t0\\t0";
        }

        bool isFocused = GetForegroundWindow() == hWnd;
        bool isMinimized = IsIconic(hWnd);

        RECT clientRect;
        POINT clientPoint = new POINT { X = 0, Y = 0 };
        int width = 0;
        int height = 0;

        if (GetClientRect(hWnd, out clientRect) && ClientToScreen(hWnd, ref clientPoint))
        {
            width = clientRect.Right - clientRect.Left;
            height = clientRect.Bottom - clientRect.Top;
        }

        if (width <= 0 || height <= 0)
        {
            RECT windowRect;
            if (GetWindowRect(hWnd, out windowRect))
            {
                clientPoint.X = windowRect.Left;
                clientPoint.Y = windowRect.Top;
                width = windowRect.Right - windowRect.Left;
                height = windowRect.Bottom - windowRect.Top;
            }
        }

        bool isFullscreen = IsFullscreen(hWnd);

        return String.Format(
            "{0}\\t{1}\\t{2}\\t{3}\\t{4}\\t{5}\\t{6}\\t{7}",
            1,
            isFocused ? 1 : 0,
            isMinimized ? 1 : 0,
            clientPoint.X,
            clientPoint.Y,
            width,
            height,
            isFullscreen ? 1 : 0
        );
    }
}
"@

$windowTitles = @(${serializedTitles})
$lastState = $null

while ($true) {
    try {
        $state = [OverlayWin32]::FindState($windowTitles)
    } catch {
        $state = "0\`t0\`t0\`t0\`t0\`t0\`t0\`t0"
    }

    if ($state -ne $lastState) {
        [Console]::Out.WriteLine($state)
        $lastState = $state
    }

    Start-Sleep -Milliseconds 125
}
`.trim();
}

class WindowsOverlayFallbackController {
  constructor() {
    this.isInitialized = false;
    this.targetBounds = { x: 0, y: 0, width: 0, height: 0 };
    this.targetHasFocus = false;
    this.lastIsFullscreen = false;
    this.isAttached = false;
    this.pinned = true;
    this.focusNext = undefined;
    this.electronWindow = null;
    this.monitorProcess = null;
    this.monitorOutput = null;
    this.monitorTitles = [];
    this.events = new EventEmitter();

    this.events.on('attach', (event) => {
      this.targetHasFocus = event.isFocused;
      this.targetBounds = {
        x: event.x,
        y: event.y,
        width: event.width,
        height: event.height
      };

      if (!this.electronWindow) {
        return;
      }

      this.electronWindow.setIgnoreMouseEvents(true, { forward: true });
      this.handleFullscreen(event.isFullscreen);
      this.updateOverlayBounds();

      if (event.isFocused || this.pinned) {
        this.electronWindow.showInactive();
        this.electronWindow.setAlwaysOnTop(true, 'screen-saver');
      } else {
        this.electronWindow.hide();
      }
    });

    this.events.on('moveresize', (event) => {
      this.targetBounds = {
        x: event.x,
        y: event.y,
        width: event.width,
        height: event.height
      };
      this.updateOverlayBounds();
    });

    this.events.on('focus', () => {
      this.focusNext = undefined;
      this.targetHasFocus = true;

      if (!this.electronWindow) {
        return;
      }

      this.electronWindow.setIgnoreMouseEvents(true, { forward: true });
      if (!this.electronWindow.isVisible()) {
        this.electronWindow.showInactive();
      }
      this.electronWindow.setAlwaysOnTop(true, 'screen-saver');
    });

    this.events.on('blur', () => {
      this.targetHasFocus = false;
      if (!this.pinned && this.electronWindow && this.focusNext !== 'overlay' && !this.electronWindow.isFocused()) {
        this.electronWindow.hide();
      }
    });

    this.events.on('detach', () => {
      this.targetHasFocus = false;
      if (this.electronWindow) {
        this.electronWindow.hide();
      }
    });

    this.events.on('fullscreen', (event) => {
      this.handleFullscreen(event.isFullscreen);
    });
  }

  updateOverlayBounds() {
    if (!this.electronWindow) {
      return;
    }

    if (this.targetBounds.width === 0 || this.targetBounds.height === 0) {
      return;
    }

    let dipBounds = screen.screenToDipRect(this.electronWindow, this.targetBounds);
    this.electronWindow.setBounds(dipBounds);

    dipBounds = screen.screenToDipRect(this.electronWindow, this.targetBounds);
    this.electronWindow.setBounds(dipBounds);
  }

  handleFullscreen(isFullscreen) {
    this.lastIsFullscreen = !!isFullscreen;
  }

  attachByTitles(electronWindow, targetWindowTitles, _options = {}) {
    if (this.isInitialized) {
      throw new Error('Library can be initialized only once.');
    }

    this.isInitialized = true;
    this.electronWindow = electronWindow;
    this.monitorTitles = [...targetWindowTitles];

    this.electronWindow.on('blur', () => {
      if (!this.targetHasFocus && this.focusNext !== 'target') {
        this.electronWindow.hide();
      }
    });

    this.electronWindow.on('focus', () => {
      this.focusNext = undefined;
    });

    this.startMonitor();
  }

  attachByTitle(electronWindow, targetWindowTitle, options = {}) {
    this.attachByTitles(electronWindow, [targetWindowTitle], options);
  }

  activateOverlay() {
    if (!this.electronWindow) {
      throw new Error('You are using the library in tracking mode');
    }

    this.focusNext = 'overlay';
    this.electronWindow.setIgnoreMouseEvents(false);
    this.electronWindow.focus();
  }

  focusTarget() {
    this.focusNext = 'target';
    this.electronWindow?.setIgnoreMouseEvents(true, { forward: true });
  }

  dispose() {
    if (this.monitorOutput) {
      this.monitorOutput.close();
      this.monitorOutput = null;
    }

    if (this.monitorProcess) {
      this.monitorProcess.kill();
      this.monitorProcess = null;
    }
  }

  startMonitor() {
    const script = buildPowerShellMonitorScript(this.monitorTitles);

    this.monitorProcess = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShellCommand(script)],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );

    this.monitorOutput = readline.createInterface({
      input: this.monitorProcess.stdout
    });

    this.monitorOutput.on('line', (line) => {
      const nextState = parseStateLine(line);
      if (!nextState) {
        return;
      }

      this.applyState(nextState);
    });

    this.monitorProcess.stderr.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text) {
        console.warn(`[overlay:fallback] ${text}`);
      }
    });

    this.monitorProcess.once('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        console.warn(`[overlay:fallback] PowerShell tracker exited (code=${code}, signal=${signal})`);
      }

      if (this.isAttached) {
        this.isAttached = false;
        this.events.emit('detach', {});
      }
    });
  }

  applyState(nextState) {
    const hasUsableBounds = nextState.width > 0 && nextState.height > 0;
    const shouldBeAttached = nextState.found && !nextState.isMinimized && hasUsableBounds;
    const nextBounds = {
      x: nextState.x,
      y: nextState.y,
      width: nextState.width,
      height: nextState.height
    };

    if (!shouldBeAttached) {
      if (this.isAttached) {
        if (this.targetHasFocus) {
          this.events.emit('blur', {});
        }

        this.isAttached = false;
        this.targetHasFocus = false;
        this.events.emit('detach', {});
      }

      return;
    }

    if (!this.isAttached) {
      this.isAttached = true;
      this.lastIsFullscreen = nextState.isFullscreen;
      this.events.emit('attach', {
        ...nextBounds,
        isFullscreen: nextState.isFullscreen,
        isFocused: nextState.isFocused
      });
    } else {
      if (!sameBounds(this.targetBounds, nextBounds)) {
        this.events.emit('moveresize', nextBounds);
      }

      if (this.lastIsFullscreen !== nextState.isFullscreen) {
        this.lastIsFullscreen = nextState.isFullscreen;
        this.events.emit('fullscreen', {
          ...nextBounds,
          isFullscreen: nextState.isFullscreen
        });
      }
    }

    if (nextState.isFocused && !this.targetHasFocus) {
      this.events.emit('focus', nextBounds);
      return;
    }

    if (!nextState.isFocused && this.targetHasFocus) {
      this.events.emit('blur', nextBounds);
    }
  }
}

module.exports = {
  OVERLAY_WINDOW_OPTS,
  OverlayController: new WindowsOverlayFallbackController(),
  buildPowerShellMonitorScript
};
