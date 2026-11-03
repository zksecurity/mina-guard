/**
 * Content-Security-Policy headers for the MinaGuard web app.
 *
 * Every page is sent CONTENT_SECURITY_POLICY. It allows scripts, styles,
 * fonts, images, workers and network requests only from the app's own origin,
 * stops other sites from framing the app, and blocks plugins, <base> tag
 * changes and form posts to other sites. It cannot stop an injected inline
 * script: Next.js writes page data as inline scripts that change on every
 * build, so 'unsafe-inline' stays until the app moves to per-request nonces.
 *
 * Worker scripts are sent WORKER_CONTENT_SECURITY_POLICY, the same policy plus
 * 'unsafe-eval'. o1js runs inside the transaction worker and starts its
 * compiled core with `new Function(...)` (o1js dist/web/index.js), so the
 * worker cannot build, prove or sign anything without it. A browser applies
 * the policy sent with a worker's script, and the worker's own blob workers
 * inherit it, so pages keep the stricter policy.
 *
 * connect-src 'self' is right for mainnet, where the API, Mina node and
 * archive are all served from the app origin. Test, preview and development
 * builds talk to other origins, so their policies add the origins of the
 * configured endpoints.
 *
 * deploy/mainnet-content-integrity.py checks that the public mainnet site
 * sends exactly CONTENT_SECURITY_POLICY, and deploy/tests checks that the
 * two copies stay equal. Keep the value below on one line in double quotes.
 */
export const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";

/** The page policy plus 'unsafe-eval' for o1js. Sent with worker scripts. */
export const WORKER_CONTENT_SECURITY_POLICY = withDirectiveSources(
  CONTENT_SECURITY_POLICY, 'script-src', ["'unsafe-eval'"],
);

/** Endpoint defaults used by the UI when a variable is unset (lib/api.ts, lib/endpoints.ts). */
const ENDPOINT_DEFAULTS = {
  NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3001',
  NEXT_PUBLIC_MINA_ENDPOINT: 'https://api.minascan.io/node/devnet/v1/graphql',
  NEXT_PUBLIC_ARCHIVE_ENDPOINT: 'https://api.minascan.io/archive/devnet/v1/graphql',
};

/** Adds sources to one directive of a policy string. */
function withDirectiveSources(policy, name, sources) {
  if (sources.length === 0) return policy;
  let found = false;
  const directives = policy.split('; ').map((directive) => {
    const [directiveName, ...values] = directive.split(' ');
    if (directiveName !== name) return directive;
    found = true;
    return [directiveName, ...values, ...sources.filter((source) => !values.includes(source))].join(' ');
  });
  if (!found) throw new Error(`Content-Security-Policy has no ${name} directive`);
  return directives.join('; ');
}

/** Origins of the configured API, node and archive endpoints. */
function endpointOrigins(env) {
  const origins = [];
  for (const [name, fallback] of Object.entries(ENDPOINT_DEFAULTS)) {
    const value = env[name] || fallback;
    let origin;
    try {
      origin = new URL(value).origin;
    } catch {
      throw new Error(`${name} is not a valid URL, so the Content-Security-Policy cannot allow it`);
    }
    if (origin === 'null') throw new Error(`${name} has no origin to allow in the Content-Security-Policy`);
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

/**
 * Policies for one build. Mainnet production builds get the exact constants
 * above. Other networks add the configured endpoint origins to connect-src.
 * The development server also allows 'unsafe-eval' on pages, because React
 * and webpack development code use eval.
 *
 * @param {{ env?: Record<string, string | undefined>, dev?: boolean }} [options]
 * @returns {{ page: string, worker: string }}
 */
export function contentSecurityPolicies({ env = process.env, dev = false } = {}) {
  const mainnet = env.NEXT_PUBLIC_MINA_NETWORK === 'mainnet';
  const extraOrigins = mainnet && !dev ? [] : endpointOrigins(env);
  const page = withDirectiveSources(dev ? WORKER_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY, 'connect-src', extraOrigins);
  const worker = withDirectiveSources(WORKER_CONTENT_SECURITY_POLICY, 'connect-src', extraOrigins);
  return { page, worker };
}
