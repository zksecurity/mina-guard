import { describe, expect, it } from 'bun:test';
import { ALL_PLATFORMS, getPlatformInfo, signCommand } from '../lib/offline-cli-command';

describe('offline CLI sign command', () => {
  it('names the network and the platform binary on macOS and Linux', () => {
    expect(signCommand(getPlatformInfo('macos-arm64'), 'mainnet', 'execute-1.json')).toBe(
      'MINA_NETWORK_DOMAIN=mainnet MINA_PRIVATE_KEY=EK... ./mina-guard-cli-macos-arm64 execute-1.json > signed.json',
    );
    expect(signCommand(getPlatformInfo('linux-x64'), 'testnet', 'approve-1.json')).toBe(
      'MINA_NETWORK_DOMAIN=testnet MINA_PRIVATE_KEY=EK... ./mina-guard-cli-linux-x64 approve-1.json > signed.json',
    );
  });

  it('uses cmd.exe syntax without trailing spaces on Windows', () => {
    expect(signCommand(getPlatformInfo('windows-x64'), 'mainnet', 'propose-1.json')).toBe(
      'set "MINA_NETWORK_DOMAIN=mainnet" && set "MINA_PRIVATE_KEY=EK..." && ' +
      'mina-guard-cli-windows-x64.exe propose-1.json > signed.json',
    );
  });

  it('matches the release asset names', () => {
    expect(ALL_PLATFORMS.map((p) => p.filename)).toEqual([
      'mina-guard-cli-macos-arm64', 'mina-guard-cli-macos-x64', 'mina-guard-cli-linux-x64',
      'mina-guard-cli-linux-arm64', 'mina-guard-cli-windows-x64.exe',
    ]);
  });

  it('prepares macOS binaries even when no quarantine flag is set', () => {
    expect(getPlatformInfo('macos-arm64').setup).toBe(
      'xattr -d com.apple.quarantine mina-guard-cli-macos-arm64 2>/dev/null; chmod +x mina-guard-cli-macos-arm64',
    );
    expect(getPlatformInfo('windows-x64').setup).toBeNull();
  });
});
