// afterPack check: refuse to build installers (or publish them) unless the
// unpacked app carries allowed Next.js and Electron versions.
//
// The release workflow's `bun audit` gate reads the lockfile at install time.
// This check reads what electron-builder actually packed, on every platform,
// after the app is unpacked and before installers are made or uploaded.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The lines we ship, from the first release with no known advisory.
// Next.js 15.5.24 fixes GHSA-p293-qw3h-jr36 and GHSA-2xp9-vwfh-vxw4. Moving to
// Next 16 means adding its line here after checking its advisories: 16.3.3, the
// GHSA-p293 fix, is still affected by GHSA-vcvr-r3jv-pc5j. Electron 43.5.0 is
// the first 43.x release with none of the advisories 43.1.0 had (the last one,
// GHSA-qmv3-fv6v-rmhq, was fixed in 43.5.0).
export const ALLOWED_VERSIONS = {
  next: [{ min: '15.5.24', below: '16.0.0' }],
  electron: [{ min: '43.5.0' }],
};

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** True when `version` is a plain release inside one of the allowed ranges; prereleases are refused. */
export function isAllowedVersion(version, ranges) {
  const parsed = parse(version);
  if (!parsed) return false;
  return ranges.some(({ min, below }) =>
    compare(parsed, parse(min)) >= 0 && (!below || compare(parsed, parse(below)) < 0));
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

export default function checkPackagedVersions(context) {
  const standalone = path.join(resourcesDir(context), 'ui-standalone');
  if (!existsSync(standalone)) throw new Error(`No packaged UI found at ${standalone}`);
  const manifests = findPackageManifests(standalone, 'next');
  if (manifests.length !== 1) {
    throw new Error(`Expected exactly one Next.js package in ${standalone}, found ${manifests.length}: ${manifests.join(', ')}`);
  }
  const nextVersion = JSON.parse(readFileSync(manifests[0], 'utf8')).version;
  if (!isAllowedVersion(nextVersion, ALLOWED_VERSIONS.next)) {
    throw new Error(`Packaged Next.js ${nextVersion} is outside the allowed versions (${manifests[0]})`);
  }
  const electronVersion = context.packager.info.framework.version;
  if (!isAllowedVersion(electronVersion, ALLOWED_VERSIONS.electron)) {
    throw new Error(`Packaged Electron ${electronVersion} is outside the allowed versions`);
  }
  console.log(`[afterPack] packaged versions OK: next ${nextVersion}, electron ${electronVersion}`);
}
