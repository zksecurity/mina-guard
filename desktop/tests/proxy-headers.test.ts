import { describe, expect, it } from 'bun:test';
import { proxiedUiHeaders } from '../src/proxy-headers.js';

describe('proxied UI headers', () => {
  it('drops the build policy and caching, and keeps the rest', () => {
    expect(proxiedUiHeaders({
      'content-type': 'application/javascript',
      'content-security-policy': "connect-src 'self' https://build.example",
      'cache-control': 'public, max-age=31536000, immutable',
      etag: '"abc"',
      'last-modified': 'Thu, 05 Nov 2026 00:00:00 GMT',
    })).toEqual({ 'content-type': 'application/javascript', 'cache-control': 'no-store' });
  });

  it('adds no-store when the upstream sent no caching headers', () => {
    expect(proxiedUiHeaders({ 'content-type': 'text/html' }))
      .toEqual({ 'content-type': 'text/html', 'cache-control': 'no-store' });
  });
});
