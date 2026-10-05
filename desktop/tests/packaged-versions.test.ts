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

// A fixed date keeps the tests independent of when they run.
const NOW = new Date('2026-10-05T12:00:00Z');

describe('packaged framework versions', () => {
  it('allows only supported Next.js and Electron lines, from their first release without known advisories', () => {
    for (const v of ['16.3.6', '16.3.8', '16.9.0']) expect(isAllowedVersion(v, ALLOWED_VERSIONS.next, NOW)).toBe(true);
    for (const v of ['14.2.35', '15.5.27', '16.3.3', '16.3.5', '17.0.0', '16.3.8-canary.1', '', 'latest']) {
      expect(isAllowedVersion(v, ALLOWED_VERSIONS.next, NOW)).toBe(false);
    }
    for (const v of ['43.5.0', '43.7.6']) expect(isAllowedVersion(v, ALLOWED_VERSIONS.electron, NOW)).toBe(true);
    for (const v of ['43.4.1', '44.0.0']) expect(isAllowedVersion(v, ALLOWED_VERSIONS.electron, NOW)).toBe(false);
  });

  it('refuses a line once its vendor support has ended', () => {
    expect(isAllowedVersion('16.3.8', ALLOWED_VERSIONS.next, new Date('2027-10-21T20:00:00Z'))).toBe(true);
    expect(isAllowedVersion('16.3.8', ALLOWED_VERSIONS.next, new Date('2027-10-22T00:00:01Z'))).toBe(false);
    expect(isAllowedVersion('43.7.6', ALLOWED_VERSIONS.electron, new Date('2027-01-05T20:00:00Z'))).toBe(true);
    expect(isAllowedVersion('43.7.6', ALLOWED_VERSIONS.electron, new Date('2027-01-06T00:00:01Z'))).toBe(false);
  });

  it('accepts a package with one allowed Next.js copy on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(() => checkPackagedVersions(fakeApp(platform, { 'ui/node_modules/next': '16.3.8' }), NOW)).not.toThrow();
    }
  });

  it('refuses a disallowed, missing or duplicated Next.js, and a disallowed Electron', () => {
    expect(() => checkPackagedVersions(fakeApp('win32', { 'ui/node_modules/next': '15.5.27' }), NOW))
      .toThrow('Packaged Next.js 15.5.27 is not an allowed, still-supported release');
    expect(() => checkPackagedVersions(fakeApp('win32', {}), NOW)).toThrow('No packaged UI found');
    expect(() => checkPackagedVersions(fakeApp('win32', { 'ui/node_modules/react': '19.3.0' }), NOW)).toThrow('found 0');
    expect(() => checkPackagedVersions(fakeApp('win32', {
      'ui/node_modules/next': '16.3.8',
      'node_modules/next': '15.5.27',
    }), NOW)).toThrow('found 2');
    expect(() => checkPackagedVersions(fakeApp('linux', { 'ui/node_modules/next': '16.3.8' }, '43.1.0'), NOW))
      .toThrow('Packaged Electron 43.1.0 is not an allowed, still-supported release');
  });
});
