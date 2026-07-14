import { Cache } from "o1js";
import { execSync } from "node:child_process";

/** Compiles MinaGuard and prints its VK hash for the current network.
 *  Set MINA_NETWORK_DOMAIN=mainnet to compile the mainnet VK; otherwise testnet. */
export async function runVkHashCompile(): Promise<void> {
  const network = process.env.MINA_NETWORK_DOMAIN === 'mainnet' ? 'mainnet' : 'testnet';

  // Rebuild from source first — contracts/build is gitignored and can be stale.
  console.log(`Rebuilding contracts (network: ${network})...`);
  execSync('bun run --filter contracts build', { stdio: 'inherit' });

  // Dynamic import AFTER the rebuild so we load the freshly-built output.
  // NETWORK_DOMAIN is evaluated at module load time from MINA_NETWORK_DOMAIN,
  // so the imported module picks up the correct network constant.
  const { MinaGuard } = await import("contracts");
  if (!MinaGuard || typeof MinaGuard.compile !== 'function') {
    throw new Error(
      'Could not load MinaGuard from contracts build output. Rebuild with `bun run --filter contracts build`.'
    );
  }

  console.log(`Compiling MinaGuard to extract ${network} VK hash...`);
  const cache = Cache.FileSystem('./cache');
  const { verificationKey } = await MinaGuard.compile({ cache });
  const hashText = verificationKey?.hash?.toString?.();

  if (!hashText) {
    throw new Error('Failed to read verification key hash from compile output.');
  }

  console.log(`vkHash[${network}]: ${hashText}`);
}
