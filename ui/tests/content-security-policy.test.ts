import { describe, expect, it } from 'bun:test';
import {
  CONTENT_SECURITY_POLICY,
  WORKER_CONTENT_SECURITY_POLICY,
  contentSecurityPolicies,
} from '../content-security-policy.mjs';

const directive = (policy: string, name: string) =>
  policy.split('; ').find((entry) => entry.split(' ')[0] === name);

const mainnet = {
  NEXT_PUBLIC_MINA_NETWORK: 'mainnet',
  NEXT_PUBLIC_API_BASE_URL: 'https://app.minaguard.com',
  NEXT_PUBLIC_MINA_ENDPOINT: 'https://app.minaguard.com/graphql',
  NEXT_PUBLIC_ARCHIVE_ENDPOINT: 'https://app.minaguard.com/archive',
};

describe('Content-Security-Policy', () => {
  it('sends mainnet pages exactly the published policy', () => {
    const { page, worker } = contentSecurityPolicies({ env: mainnet });
    expect(page).toBe(CONTENT_SECURITY_POLICY);
    expect(worker).toBe(WORKER_CONTENT_SECURITY_POLICY);
    expect(directive(page, 'connect-src')).toBe("connect-src 'self'");
    expect(directive(page, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(page).not.toContain("'unsafe-eval'");
  });

  it("adds only 'unsafe-eval' for the o1js worker", () => {
    expect(directive(WORKER_CONTENT_SECURITY_POLICY, 'script-src'))
      .toBe("script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' 'unsafe-eval'");
    expect(WORKER_CONTENT_SECURITY_POLICY.replace(" 'unsafe-eval'", '')).toBe(CONTENT_SECURITY_POLICY);
  });

  it('allows the configured endpoint origins on other networks', () => {
    const { page, worker } = contentSecurityPolicies({ env: {
      NEXT_PUBLIC_MINA_NETWORK: 'testnet',
      NEXT_PUBLIC_API_BASE_URL: 'http://localhost:14000',
      NEXT_PUBLIC_MINA_ENDPOINT: 'http://localhost:18080/graphql',
      NEXT_PUBLIC_ARCHIVE_ENDPOINT: 'http://localhost:18282',
    } });
    const connect = "connect-src 'self' http://localhost:14000 http://localhost:18080 http://localhost:18282";
    expect(directive(page, 'connect-src')).toBe(connect);
    expect(directive(worker, 'connect-src')).toBe(connect);
    expect(page).not.toContain("'unsafe-eval'");
  });

  it('falls back to the same endpoint defaults as the UI', () => {
    const { page } = contentSecurityPolicies({ env: {} });
    expect(directive(page, 'connect-src')).toBe("connect-src 'self' http://localhost:3001 https://api.minascan.io");
  });

  it("lets the development server's pages use eval", () => {
    const { page } = contentSecurityPolicies({ env: mainnet, dev: true });
    expect(directive(page, 'script-src')).toContain("'unsafe-eval'");
    expect(directive(page, 'connect-src')).toBe("connect-src 'self' https://app.minaguard.com");
  });

  it('refuses an endpoint it cannot turn into an origin', () => {
    expect(() => contentSecurityPolicies({ env: { NEXT_PUBLIC_MINA_ENDPOINT: 'not a url' } })).toThrow('not a valid URL');
  });
});
