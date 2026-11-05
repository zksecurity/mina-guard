import type { IncomingHttpHeaders } from 'node:http';

/**
 * Headers for a UI response the desktop server proxies from the Next server.
 * The window enforces the Content-Security-Policy the desktop server sets from
 * the configured endpoints, so the build's own policy is dropped. Nothing is
 * cached: Next marks its static chunks immutable, and Chromium would keep a
 * cached worker script's policy, for the endpoints configured when it was
 * fetched, after the endpoints change.
 */
export function proxiedUiHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const {
    'content-security-policy': _policy,
    'cache-control': _cacheControl,
    etag: _etag,
    'last-modified': _lastModified,
    ...rest
  } = headers;
  return { ...rest, 'cache-control': 'no-store' };
}
