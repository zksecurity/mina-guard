// electron-builder runs this once per platform after unpacking the app and
// before building installers or publishing them. A thrown error stops both.
import checkPackagedVersions from './check-packaged-versions.mjs';
import adhocSign from './adhoc-sign.mjs';

export default async function afterPack(context) {
  checkPackagedVersions(context);
  adhocSign(context);
}
