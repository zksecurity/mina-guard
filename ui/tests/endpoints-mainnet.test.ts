import { afterEach, describe, expect, it } from 'bun:test';
import { getMinaGuardConfig } from '../lib/endpoints';

const names = [
  'NEXT_PUBLIC_MINA_NETWORK',
  'NEXT_PUBLIC_MINA_ENDPOINT',
  'NEXT_PUBLIC_ARCHIVE_ENDPOINT',
  'NEXT_PUBLIC_MINAGUARD_VK_HASH',
] as const;
const originalEnv = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const originalWindow = globalThis.window;

afterEach(() => {
  for (const name of names) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.window = originalWindow;
});

describe('mainnet endpoint configuration', () => {
  it('does not fall back to devnet endpoints for an incomplete mainnet build', () => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    process.env.NEXT_PUBLIC_MINA_NETWORK = 'mainnet';
    delete process.env.NEXT_PUBLIC_MINA_ENDPOINT;
    delete process.env.NEXT_PUBLIC_ARCHIVE_ENDPOINT;
    delete process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH;
    expect(() => getMinaGuardConfig()).toThrow('Mainnet requires explicit Mina and archive endpoints');
  });

  it('uses explicitly configured mainnet endpoints', () => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    process.env.NEXT_PUBLIC_MINA_NETWORK = 'mainnet';
    process.env.NEXT_PUBLIC_MINA_ENDPOINT = 'https://mina.example/graphql';
    process.env.NEXT_PUBLIC_ARCHIVE_ENDPOINT = 'https://archive.example/graphql';
    process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH = '123';
    expect(getMinaGuardConfig()).toEqual({
      networkId: 'mainnet',
      minaEndpoint: 'https://mina.example/graphql',
      archiveEndpoint: 'https://archive.example/graphql',
    });
  });
});
