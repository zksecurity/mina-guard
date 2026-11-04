/** Offline CLI binaries per platform and the command that signs a request. */

export interface PlatformInfo {
  id: string;
  os: 'macOS' | 'Linux' | 'Windows';
  arch: string;
  filename: string;
  /** One shell line that prepares the downloaded binary, if any. */
  setup: string | null;
}

export function getPlatformInfo(p: string): PlatformInfo {
  // Windows release assets carry the .exe suffix bun appends at compile time.
  const filename = p.startsWith('windows') ? `mina-guard-cli-${p}.exe` : `mina-guard-cli-${p}`;
  if (p.startsWith('macos')) {
    return {
      id: p, os: 'macOS', arch: p.includes('arm64') ? 'Apple Silicon' : 'Intel', filename,
      // A file unzipped in Terminal has no quarantine flag; ignore that error.
      setup: `xattr -d com.apple.quarantine ${filename} 2>/dev/null; chmod +x ${filename}`,
    };
  }
  if (p.startsWith('linux')) {
    return { id: p, os: 'Linux', arch: p.includes('arm64') ? 'ARM64' : 'x64', filename, setup: `chmod +x ${filename}` };
  }
  return { id: p, os: 'Windows', arch: 'x64', filename, setup: null };
}

export const ALL_PLATFORMS: PlatformInfo[] = [
  getPlatformInfo('macos-arm64'),
  getPlatformInfo('macos-x64'),
  getPlatformInfo('linux-x64'),
  getPlatformInfo('linux-arm64'),
  getPlatformInfo('windows-x64'),
];

/** Best guess from the browser; the user can pick another platform. Browsers
 *  do not report a Mac's CPU, so macOS defaults to Apple Silicon. */
export function detectPlatform(): PlatformInfo {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return getPlatformInfo('windows-x64');
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) {
    return getPlatformInfo(/aarch64|arm64/i.test(ua) ? 'linux-arm64' : 'linux-x64');
  }
  return getPlatformInfo('macos-arm64');
}

/** The command to run on the air-gapped machine. Windows uses cmd.exe, whose
 *  `>` writes the UTF-8 the upload expects; the quoted `set` avoids a trailing
 *  space in the value. */
export function signCommand(platform: PlatformInfo, network: string, bundleName: string): string {
  if (platform.os === 'Windows') {
    return `set "MINA_NETWORK_DOMAIN=${network}" && set "MINA_PRIVATE_KEY=EK..." && ` +
      `${platform.filename} ${bundleName} > signed.json`;
  }
  return `MINA_NETWORK_DOMAIN=${network} MINA_PRIVATE_KEY=EK... ./${platform.filename} ${bundleName} > signed.json`;
}
