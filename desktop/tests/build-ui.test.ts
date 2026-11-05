import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BUILD_NETWORK,
  DESKTOP_BUILD_INPUTS,
  NEXT_ENV_FILES,
  VK_HASH_VAR,
  composeBuildEnv,
  findNextEnvFiles,
  isBuildVariable,
  parseDotEnv,
  readBuildNetworkDomain,
} from '../scripts/build-ui-env.mjs';

const HASH = '11186074123051144955935844547857280472106039209748658876584800516410203862391';

describe('desktop UI build inputs', () => {
  it('bakes a mainnet build with HTTPS endpoints and the loopback backend', () => {
    expect(BUILD_NETWORK).toBe('mainnet');
    expect(DESKTOP_BUILD_INPUTS.NEXT_PUBLIC_MINA_NETWORK).toBe('mainnet');
    expect(DESKTOP_BUILD_INPUTS.NEXT_PUBLIC_API_BASE_URL).toBe('http://127.0.0.1:5050');
    expect(DESKTOP_BUILD_INPUTS.NEXT_PUBLIC_INDEXER_MODE).toBe('lite');
    for (const key of ['NEXT_PUBLIC_MINA_ENDPOINT', 'NEXT_PUBLIC_ARCHIVE_ENDPOINT', 'NEXT_PUBLIC_BLOCK_EXPLORER_URL'] as const) {
      expect(DESKTOP_BUILD_INPUTS[key]).toStartWith('https://');
    }
  });

  it('matches the network the endpoint check enforces', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'config-store.ts'), 'utf8');
    expect(readBuildNetworkDomain(source)).toBe(BUILD_NETWORK);
  });
});

describe('parseDotEnv', () => {
  it('reads KEY=VALUE lines, skipping blanks and comments, and unquotes values', () => {
    const vars = parseDotEnv('# comment\n\nA=1\n  B = two words \nC="quoted=value"\nD=\'x\'\nE=\n');
    expect(vars).toEqual({ A: '1', B: 'two words', C: 'quoted=value', D: 'x', E: '' });
  });

  it('rejects lines that are not assignments', () => {
    expect(() => parseDotEnv('A=1\nnot an assignment\n')).toThrow('line 2');
    expect(() => parseDotEnv('=1')).toThrow('line 1');
    expect(() => parseDotEnv('1A=1')).toThrow('line 1');
  });
});

describe('composeBuildEnv', () => {
  const inherited = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    NEXT_PUBLIC_E2E_TEST: 'true',
    NEXT_PUBLIC_MINA_NETWORK: 'testnet',
    MINA_NETWORK_DOMAIN: 'testnet',
  };

  it('drops inherited build variables and keeps the rest', () => {
    const env = composeBuildEnv({ inherited, dotEnv: {}, vkHash: HASH });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.NEXT_PUBLIC_E2E_TEST).toBeUndefined();
    expect(env.MINA_NETWORK_DOMAIN).toBeUndefined();
  });

  it('drops build variables whatever their letter case, as Windows reads them', () => {
    expect(isBuildVariable('Next_Public_E2E_Test')).toBe(true);
    expect(isBuildVariable('mina_network_domain')).toBe(true);
    expect(isBuildVariable('NEXT_PUBLICX')).toBe(false);
    const env = composeBuildEnv({
      inherited: { Next_Public_E2E_Test: 'true', mina_network_domain: 'testnet', Path: 'C:\\x' },
      dotEnv: {},
      vkHash: HASH,
    });
    expect(env.Next_Public_E2E_Test).toBeUndefined();
    expect(env.mina_network_domain).toBeUndefined();
    expect(env.Path).toBe('C:\\x');
  });

  it('applies the fixed inputs and the VK hash over everything else', () => {
    const env = composeBuildEnv({ inherited, dotEnv: { NEXT_PUBLIC_POLL_INTERVAL_MS: '5000' }, vkHash: HASH });
    for (const [key, value] of Object.entries(DESKTOP_BUILD_INPUTS)) expect(env[key]).toBe(value);
    expect(env[VK_HASH_VAR]).toBe(HASH);
    expect(env.NEXT_PUBLIC_POLL_INTERVAL_MS).toBe('5000');
  });

  it('keeps whatever desktop/.env sets so the validator sees it too', () => {
    const env = composeBuildEnv({ inherited: {}, dotEnv: { NEXT_PUBLIC_E2E_TEST: 'true' }, vkHash: HASH });
    expect(env.NEXT_PUBLIC_E2E_TEST).toBe('true');
  });

  it('refuses a desktop/.env that sets a fixed input, the hash or the domain, in any letter case', () => {
    for (const key of [...Object.keys(DESKTOP_BUILD_INPUTS), VK_HASH_VAR, 'MINA_NETWORK_DOMAIN']) {
      expect(() => composeBuildEnv({ inherited: {}, dotEnv: { [key]: 'x' }, vkHash: HASH })).toThrow(key);
      const lower = key.toLowerCase();
      expect(() => composeBuildEnv({ inherited: {}, dotEnv: { [lower]: 'x' }, vkHash: HASH })).toThrow(lower);
    }
  });

  it('refuses a hash that is not a positive decimal', () => {
    for (const bad of ['', '0', '012', 'abc', 'testnet=1', undefined]) {
      expect(() => composeBuildEnv({ inherited: {}, dotEnv: {}, vkHash: bad as string })).toThrow('hash');
    }
  });
});

describe('findNextEnvFiles', () => {
  it('reports the production-build env files Next would load, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mg-ui-env-'));
    try {
      expect(findNextEnvFiles(dir)).toEqual([]);
      writeFileSync(join(dir, '.env.local.example'), 'A=1\n');
      writeFileSync(join(dir, '.env.development'), 'A=1\n');
      expect(findNextEnvFiles(dir)).toEqual([]);
      for (const name of NEXT_ENV_FILES) writeFileSync(join(dir, name), 'A=1\n');
      expect(findNextEnvFiles(dir)).toEqual([...NEXT_ENV_FILES]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readBuildNetworkDomain', () => {
  it('tolerates type changes, quote styles, comments and line breaks around the declaration', () => {
    const variants = [
      "export const BUILD_NETWORK_DOMAIN: 'mainnet' | 'testnet' = 'mainnet';",
      "export const BUILD_NETWORK_DOMAIN: 'mainnet' | 'testnet' | 'devnet' = 'mainnet'; // released builds",
      "const BUILD_NETWORK_DOMAIN =\n  'mainnet';",
      'export const BUILD_NETWORK_DOMAIN: "mainnet" | "testnet" = "mainnet" as const;',
      "/** uses BUILD_NETWORK_DOMAIN */\nexport const BUILD_NETWORK_DOMAIN = 'mainnet'\n",
    ];
    for (const source of variants) expect(readBuildNetworkDomain(source)).toBe('mainnet');
    expect(readBuildNetworkDomain("export const BUILD_NETWORK_DOMAIN: 'mainnet' | 'testnet' = 'testnet';")).toBe('testnet');
  });

  it('reads the declaration, not a comment that quotes one', () => {
    const source = "// const BUILD_NETWORK_DOMAIN = 'testnet' was the old default\n"
      + " *  const BUILD_NETWORK_DOMAIN = 'devnet'\n"
      + "export const BUILD_NETWORK_DOMAIN: 'mainnet' | 'testnet' = 'mainnet';\n";
    expect(readBuildNetworkDomain(source)).toBe('mainnet');
  });

  it('fails when the declaration is missing', () => {
    expect(() => readBuildNetworkDomain('const OTHER = 1;')).toThrow('BUILD_NETWORK_DOMAIN');
    expect(() => readBuildNetworkDomain("// const BUILD_NETWORK_DOMAIN = 'mainnet'")).toThrow('BUILD_NETWORK_DOMAIN');
  });
});
