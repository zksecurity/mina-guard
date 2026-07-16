// afterPack hook: ad-hoc sign the macOS bundle so downloaded (quarantined)
// copies get Gatekeeper's recoverable "Apple could not verify…" prompt instead
// of the dead-end "MinaGuard is damaged and can't be opened".
//
// Why this is needed: electron-builder repacks the prebuilt Electron bundle
// (renames the app, swaps Info.plist, adds the asar), which breaks the bundle
// seal of the ad-hoc signature Electron ships with. With signing disabled
// (mac.identity: null) nothing re-signs the bundle, and a quarantined app with
// a broken seal is reported as "damaged" — right-click → Open does not bypass
// that state (and macOS 15 removed that bypass for unsigned apps entirely).
// Local builds are unaffected because they carry no quarantine attribute,
// which is why CI dry runs never catch it.
//
// Why afterPack and not afterSign: electron-builder >= 24 skips the afterSign
// hook entirely when no signing occurred. afterPack runs before the (skipped)
// sign step, so once real Developer ID signing is added later it simply
// overwrites this ad-hoc signature — the hook stays harmless.
//
// --deep is deprecated for real distribution signing but is the standard
// approach for a flat ad-hoc re-sign of an Electron bundle (it covers the
// nested helpers/frameworks). Do not carry it over to a future Developer ID +
// notarization setup.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
}
