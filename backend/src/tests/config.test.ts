import { afterEach, describe, expect, it } from 'bun:test';
import { loadConfig } from '../config.js';

const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('backend configuration', () => {
  it('normalizes an empty verification-key hash to an unset filter', () => {
    process.env.DATABASE_URL = 'postgresql://localhost/minaguard';
    process.env.MINA_ENDPOINT = 'http://localhost:8080/graphql';
    process.env.ARCHIVE_ENDPOINT = 'http://localhost:8282';
    process.env.MINAGUARD_VK_HASH = '';

    expect(loadConfig().minaguardVkHash).toBeNull();
  });
});
