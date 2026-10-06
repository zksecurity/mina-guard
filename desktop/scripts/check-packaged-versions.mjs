// afterPack check: refuse to build installers (or publish them) unless the
// unpacked app carries Next.js and Electron versions that are still supported
// and have no known advisory.
//
// The release workflow's `bun audit` gate reads the lockfile at install time.
// This check reads what electron-builder actually packed, on every platform,
// after the app is unpacked and before installers are made or uploaded.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The lines we ship: each starts at its first release with no known advisory
// and is allowed until its vendor support ends, after which a release fails
// until we move to a supported line and update this list.
// - Next.js 16: 16.3.6 is the first release clear of GHSA-p293-qw3h-jr36,
//   GHSA-2xp9-vwfh-vxw4 and GHSA-vcvr-r3jv-pc5j. 16.x is supported (Active,
//   then Maintenance LTS) until two years after its 2025-10-21 release.
// - Electron 43: 43.5.0 is the first release clear of the advisories 43.1.0
//   had (the last, GHSA-qmv3-fv6v-rmhq, was fixed in 43.5.0). End of life per
//   the Electron release schedule: 2027-01-05.
export const ALLOWED_VERSIONS = {
  next: [{ min: '16.3.6', below: '17.0.0', supportedUntil: '2027-10-21' }],
  electron: [{ min: '43.5.0', below: '44.0.0', supportedUntil: '2027-01-05' }],
};

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * True when `version` is a plain release inside one of the allowed ranges
 * and that line is still supported on `now`. Prereleases are refused.
 */
export function isAllowedVersion(version, ranges, now = new Date()) {
  const parsed = parse(version);
  if (!parsed) return false;
  return ranges.some(({ min, below, supportedUntil }) =>
    compare(parsed, parse(min)) >= 0
    && (!below || compare(parsed, parse(below)) < 0)
    && (!supportedUntil || now.getTime() < Date.parse(`${supportedUntil}T23:59:59Z`)));
}

/** Every `node_modules/<name>/package.json` under `dir`. */
function findPackageManifests(dir, name) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (entry.name === name && path.basename(current) === 'node_modules') {
        const manifest = path.join(child, 'package.json');
        try { if (statSync(manifest).isFile()) found.push(manifest); } catch { /* not a package */ }
      }
      walk(child);
    }
  };
  walk(dir);
  return found;
}

/** Where electron-builder puts `extraResources` for this platform. */
export function resourcesDir(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename;
    return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

export default function checkPackagedVersions(context, now = new Date()) {
  const standalone = path.join(resourcesDir(context), 'ui-standalone');
  if (!existsSync(standalone)) throw new Error(`No packaged UI found at ${standalone}`);
  const manifests = findPackageManifests(standalone, 'next');
  if (manifests.length !== 1) {
    throw new Error(`Expected exactly one Next.js package in ${standalone}, found ${manifests.length}: ${manifests.join(', ')}`);
  }
  const nextVersion = JSON.parse(readFileSync(manifests[0], 'utf8')).version;
  if (!isAllowedVersion(nextVersion, ALLOWED_VERSIONS.next, now)) {
    throw new Error(`Packaged Next.js ${nextVersion} is not an allowed, still-supported release (${manifests[0]})`);
  }
  const electronVersion = context.packager.info.framework.version;
  if (!isAllowedVersion(electronVersion, ALLOWED_VERSIONS.electron, now)) {
    throw new Error(`Packaged Electron ${electronVersion} is not an allowed, still-supported release`);
  }
  console.log(`[afterPack] packaged versions OK: next ${nextVersion}, electron ${electronVersion}`);
}
