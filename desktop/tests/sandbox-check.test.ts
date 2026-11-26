import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ALLOW_UNSANDBOXED_SMOKE_ENV,
  refusesUnsandboxedStart,
  type SandboxStartInfo,
} from '../src/sandbox-check.js';

/** A packaged mainnet build started with --no-sandbox, the case the AppImage launcher creates. */
const unsandboxed: SandboxStartInfo = { isPackaged: true, noSandbox: true, buildNetworkDomain: 'mainnet', env: {} };

describe('refusing to start without the sandbox', () => {
  it('starts a packaged build when the sandbox is on', () => {
    expect(refusesUnsandboxedStart({ ...unsandboxed, noSandbox: false })).toBe(false);
  });

  it('refuses a packaged build started with --no-sandbox', () => {
    expect(refusesUnsandboxedStart(unsandboxed)).toBe(true);
    expect(refusesUnsandboxedStart({ ...unsandboxed, buildNetworkDomain: 'testnet' })).toBe(true);
  });

  it('gives a mainnet build no way around the check', () => {
    for (const value of ['1', 'true', '']) {
      expect(refusesUnsandboxedStart({ ...unsandboxed, env: { [ALLOW_UNSANDBOXED_SMOKE_ENV]: value } })).toBe(true);
    }
  });

  it('lets the packaging smoke test run a non-mainnet build without the sandbox', () => {
    const smoke = { ...unsandboxed, buildNetworkDomain: 'testnet' };
    expect(refusesUnsandboxedStart({ ...smoke, env: { [ALLOW_UNSANDBOXED_SMOKE_ENV]: '1' } })).toBe(false);
    for (const value of ['0', 'true', '']) {
      expect(refusesUnsandboxedStart({ ...smoke, env: { [ALLOW_UNSANDBOXED_SMOKE_ENV]: value } })).toBe(true);
    }
  });

  it('leaves the unpackaged dev run alone', () => {
    expect(refusesUnsandboxedStart({ ...unsandboxed, isPackaged: false })).toBe(false);
  });
});

describe('AppImage desktop entry', () => {
  // electron-builder writes `Exec=AppRun --no-sandbox %U` unless executableArgs is set.
  it('passes no arguments, so it cannot turn the sandbox off', () => {
    const manifest = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));
    expect(manifest.build.appImage.executableArgs).toEqual([]);
    expect(manifest.build.linux.executableArgs).toBeUndefined();
  });
});
