import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import checkPackagedVersions, { ALLOWED_VERSIONS, isAllowedVersion } from '../scripts/check-packaged-versions.mjs';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Builds a fake unpacked app with the given Next.js copies, like electron-builder's appOutDir. */
function fakeApp(platform: 'win32' | 'linux' | 'darwin', nextCopies: Record<string, string>, electron = '43.7.6') {
  const appOutDir = mkdtempSync(path.join(tmpdir(), 'packaged-'));
  dirs.push(appOutDir);
  const resources = platform === 'darwin'
    ? path.join(appOutDir, 'MinaGuard.app', 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
  for (const [relative, version] of Object.entries(nextCopies)) {
    const dir = path.join(resources, 'ui-standalone', relative);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'next', version }));
  }
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: 'MinaGuard' }, info: { framework: { version: electron } } },
  };
}

describe('packaged framework versions', () => {
  it('allows only the Next.js and Electron releases we ship, without known advisories', () => {
    for (const v of ['15.5.24', '15.5.27', '15.9.0']) expect(isAllowedVersion(v, ALLOWED_VERSIONS.next)).toBe(true);
    for (const v of ['14.2.35', '15.5.23', '16.0.0', '16.3.3', '15.5.27-canary.1', '', 'latest']) {
      expect(isAllowedVersion(v, ALLOWED_VERSIONS.next)).toBe(false);
    }
    expect(isAllowedVersion('43.5.0', ALLOWED_VERSIONS.electron)).toBe(true);
    expect(isAllowedVersion('43.7.6', ALLOWED_VERSIONS.electron)).toBe(true);
    expect(isAllowedVersion('43.4.1', ALLOWED_VERSIONS.electron)).toBe(false);
  });

  it('accepts a package with one allowed Next.js copy on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(() => checkPackagedVersions(fakeApp(platform, { 'ui/node_modules/next': '15.5.27' }))).not.toThrow();
    }
  });

  it('refuses a disallowed, missing or duplicated Next.js, and a disallowed Electron', () => {
    expect(() => checkPackagedVersions(fakeApp('win32', { 'ui/node_modules/next': '15.5.23' })))
      .toThrow('Packaged Next.js 15.5.23 is outside the allowed versions');
    expect(() => checkPackagedVersions(fakeApp('win32', {}))).toThrow('No packaged UI found');
    expect(() => checkPackagedVersions(fakeApp('win32', { 'ui/node_modules/react': '19.3.0' }))).toThrow('found 0');
    expect(() => checkPackagedVersions(fakeApp('win32', {
      'ui/node_modules/next': '15.5.27',
      'node_modules/next': '14.2.35',
    }))).toThrow('found 2');
    expect(() => checkPackagedVersions(fakeApp('linux', { 'ui/node_modules/next': '15.5.27' }, '43.1.0')))
      .toThrow('Packaged Electron 43.1.0 is outside the allowed versions');
  });
});
