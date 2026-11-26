// -- Refusing to start without Chromium's sandbox -----------------------------
//
// The app treats its pages as untrusted, and Chromium's sandbox is what keeps a
// compromised page away from the user's files. Starting Electron with
// `--no-sandbox` turns that sandbox off for every process.
//
// The AppImage launcher adds `--no-sandbox` by itself when the system blocks
// unprivileged user namespaces, as Ubuntu 24.04 and later do. Without this
// check the app would then start unprotected and give no sign of it.
//
// A packaged build therefore refuses to start with the flag. Two cases stay
// allowed:
// - `bun run dev`, which runs the unpackaged app.
// - The packaging smoke test (e2e/preflight/desktop.ts), which sets
//   ALLOW_UNSANDBOXED_SMOKE_ENV on a build that is not for mainnet.
// A mainnet build has no way around the check.

/** Set to `1` by the packaging smoke test. Ignored by mainnet builds. */
export const ALLOW_UNSANDBOXED_SMOKE_ENV = 'MINAGUARD_E2E_ALLOW_NO_SANDBOX';

export interface SandboxStartInfo {
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `app.commandLine.hasSwitch('no-sandbox')`. */
  noSandbox: boolean;
  /** `BUILD_NETWORK_DOMAIN` from config-store.ts. */
  buildNetworkDomain: string;
  env: Record<string, string | undefined>;
}

/** True when this start must stop before any window or server is created. */
export function refusesUnsandboxedStart(info: SandboxStartInfo): boolean {
  if (!info.noSandbox || !info.isPackaged) return false;
  const smokeTest = info.buildNetworkDomain !== 'mainnet'
    && info.env[ALLOW_UNSANDBOXED_SMOKE_ENV] === '1';
  return !smokeTest;
}

export const UNSANDBOXED_START_TITLE = 'MinaGuard will not start without its sandbox';

export const UNSANDBOXED_START_MESSAGE = [
  'MinaGuard was started with --no-sandbox. That option turns off the browser sandbox, which keeps a compromised page away from your files.',
  'The AppImage adds this option by itself on systems that block unprivileged user namespaces, such as Ubuntu 24.04 and later. On Debian or Ubuntu, install the .deb package instead: it sets up the permission the sandbox needs.',
  'If you added --no-sandbox yourself, start MinaGuard without it.',
].join('\n\n');
