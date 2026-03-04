/** Default Mina GraphQL endpoint used when no endpoint is provided. */
export const DEFAULT_MINA_ENDPOINT = 'https://api.minascan.io/node/devnet/v1/graphql';

/** Resolves Mina endpoint from explicit arg, env, then devnet default. */
export function resolveMinaEndpoint(explicitEndpoint?: string): string {
  if (explicitEndpoint && explicitEndpoint.trim().length > 0) return explicitEndpoint;

  const fromEnv = process.env.MINA_ENDPOINT;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;

  return DEFAULT_MINA_ENDPOINT;
}

