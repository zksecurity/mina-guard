// The rules behind scripts/build-ui.mjs: the fixed desktop build inputs and
// how the caller's environment, desktop/.env and the VK manifest become the one
// environment the UI build runs in. No side effects, so
// desktop/tests/build-ui.test.ts can exercise every rule.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The network this build proves for. Flip together with BUILD_NETWORK_DOMAIN
 *  in src/config-store.ts; scripts/build-ui.mjs refuses when they differ. */
export const BUILD_NETWORK = 'mainnet';

/** Inputs baked into the UI bundle. desktop/.env cannot override them. */
export const DESKTOP_BUILD_INPUTS = Object.freeze({
  NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:5050',
  NEXT_PUBLIC_INDEXER_MODE: 'lite',
  NEXT_PUBLIC_MINA_NETWORK: BUILD_NETWORK,
  NEXT_PUBLIC_MINA_ENDPOINT: 'https://app.minaguard.com/graphql',
  NEXT_PUBLIC_ARCHIVE_ENDPOINT: 'https://app.minaguard.com/archive',
  NEXT_PUBLIC_BLOCK_EXPLORER_URL: 'https://minascan.io/mainnet',
});

export const VK_HASH_VAR = 'NEXT_PUBLIC_MINAGUARD_VK_HASH';
const RESERVED = new Set([...Object.keys(DESKTOP_BUILD_INPUTS), VK_HASH_VAR, 'MINA_NETWORK_DOMAIN']);

/** Files `next build` loads on its own for a production build, outside the
 *  environment assembled here, in rising order of precedence. */
export const NEXT_ENV_FILES = Object.freeze(['.env', '.env.production', '.env.local', '.env.production.local']);

/** Variables the UI build reads. They never come from the caller's environment.
 *  Names are compared case-insensitively because Windows treats them that way. */
export function isBuildVariable(name) {
  const upper = name.toUpperCase();
  return upper.startsWith('NEXT_PUBLIC_') || upper === 'MINA_NETWORK_DOMAIN';
}

/** KEY=VALUE per line. Blank lines and # comments are skipped; one pair of
 *  matching quotes around a value is removed. Anything else is an error. */
export function parseDotEnv(text) {
  const vars = {};
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    const key = eq > 0 ? line.slice(0, eq).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`desktop/.env line ${index + 1}: expected KEY=VALUE`);
    }
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  });
  return vars;
}

/** The exact environment the UI build runs in: the caller's environment minus
 *  every build variable, then desktop/.env, then the fixed inputs and the hash. */
export function composeBuildEnv({ inherited, dotEnv, vkHash }) {
  for (const key of Object.keys(dotEnv)) {
    if (RESERVED.has(key.toUpperCase())) {
      throw new Error(`desktop/.env may not set ${key}; scripts/build-ui-env.mjs fixes it`);
    }
  }
  if (typeof vkHash !== 'string' || !/^[1-9][0-9]*$/.test(vkHash)) {
    throw new Error(`contracts/.vk-hash has no valid ${BUILD_NETWORK} hash (got ${JSON.stringify(vkHash)})`);
  }
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value !== undefined && !isBuildVariable(key)) env[key] = value;
  }
  return Object.assign(env, dotEnv, DESKTOP_BUILD_INPUTS, { [VK_HASH_VAR]: vkHash });
}

/** The Next env files present in the UI package. The build refuses while any
 *  exists, so what the validator saw is what gets baked. */
export function findNextEnvFiles(uiDir) {
  return NEXT_ENV_FILES.filter((name) => existsSync(join(uiDir, name)));
}

/** The value of the `const BUILD_NETWORK_DOMAIN` declaration in
 *  src/config-store.ts, whatever its type annotation, quote style or trailing
 *  comment looks like. Only a declaration at the start of a line counts, so a
 *  comment that quotes one is ignored. */
export function readBuildNetworkDomain(source) {
  const match = source.match(/^[ \t]*(?:export\s+)?const\s+BUILD_NETWORK_DOMAIN\b[^=\n]*=\s*(['"])([a-z]+)\1/m);
  if (!match) throw new Error('const BUILD_NETWORK_DOMAIN not found in src/config-store.ts');
  return match[2];
}
