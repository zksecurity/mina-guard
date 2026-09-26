import { Cache } from "o1js";
import { execSync } from "node:child_process";
import { resolveNetworkDomain } from '../../contracts/src/network-domain.ts';

/** Compiles MinaGuard and prints its VK hash for an explicitly selected network. */
export async function runVkHashCompile(): Promise<void> {
  const network = resolveNetworkDomain(
    process.env.NEXT_PUBLIC_MINA_NETWORK,
    process.env.MINA_NETWORK_DOMAIN,
  );

  // Rebuild from source first — contracts/build is gitignored and can be stale.
  console.log(`Rebuilding contracts (network: ${network})...`);
  execSync('bun run --filter contracts build', { stdio: 'inherit' });

  // Dynamic import AFTER the rebuild so we load the freshly-built output.
  // NETWORK_DOMAIN is evaluated at module load time from the selected env var,
  // so the imported module picks up the correct network constant.
  const { MinaGuard } = await import("contracts");
  if (!MinaGuard || typeof MinaGuard.compile !== 'function') {
    throw new Error(
      'Could not load MinaGuard from contracts build output. Rebuild with `bun run --filter contracts build`.'
    );
  }

  console.log(`Compiling MinaGuard to extract ${network} VK hash...`);
  const cache = Cache.FileSystem('./cache');
  // A cached artifact can be stale when a circuit change alters constant
  // AccountUpdate output without changing the cache's constraint digest.
  // Hash verification must compile the current source, never certify a
  // previously cached verification key.
  const { verificationKey } = await MinaGuard.compile({
    cache,
    forceRecompile: true,
  });
  const hashText = verificationKey?.hash?.toString?.();

  if (!hashText) {
    throw new Error('Failed to read verification key hash from compile output.');
  }

  console.log(`vkHash[${network}]: ${hashText}`);
}
