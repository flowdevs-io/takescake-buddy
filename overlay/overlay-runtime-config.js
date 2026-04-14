const OVERLAY_RUNTIME_ENV = 'MTGA_OVERLAY_RUNTIME';

function normalizeOverlayRuntimePreference(value) {
  const normalizedValue = String(value || 'auto').trim().toLowerCase();

  if (normalizedValue === 'native' || normalizedValue === 'fallback') {
    return normalizedValue;
  }

  return 'auto';
}

function getOverlayRuntimeDecision(
  platform = process.platform,
  arch = process.arch,
  preference = process.env[OVERLAY_RUNTIME_ENV]
) {
  const normalizedPreference = normalizeOverlayRuntimePreference(preference);

  if (normalizedPreference === 'native') {
    return {
      mode: 'native',
      reason: `${OVERLAY_RUNTIME_ENV}=native`
    };
  }

  if (normalizedPreference === 'fallback') {
    return {
      mode: 'fallback',
      reason: `${OVERLAY_RUNTIME_ENV}=fallback`
    };
  }

  if (platform === 'win32' && arch === 'arm64') {
    return {
      mode: 'fallback',
      reason: 'Windows ARM64 uses the PowerShell overlay tracker'
    };
  }

  return {
    mode: 'native',
    reason: 'default native overlay runtime'
  };
}

function shouldRebuildNativeOverlay(
  targetArch,
  platform = process.platform,
  preference = process.env[OVERLAY_RUNTIME_ENV]
) {
  return getOverlayRuntimeDecision(platform, targetArch, preference).mode === 'native';
}

module.exports = {
  OVERLAY_RUNTIME_ENV,
  getOverlayRuntimeDecision,
  normalizeOverlayRuntimePreference,
  shouldRebuildNativeOverlay
};
