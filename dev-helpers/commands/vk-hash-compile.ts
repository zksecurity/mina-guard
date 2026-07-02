import { Cache } from "o1js";
import { execSync } from "node:child_process";

/** Reads MinaGuard verification key hash from local contract compilation output. */
export async function runVkHashCompile(): Promise<void> {
  // The VK is derived from the COMPILED contract. contracts/build is gitignored
  // and is easily stale on a dev machine — it won't reflect contracts/src edits
  // until rebuilt, which would silently yield a VK hash for OLD contract logic.
  // (This was the "Node vs browser VK divergence" red herring: really a stale
  // host build vs a fresh Docker build.) Rebuild from source first so the hash
  // always matches current contracts/src, in every environment.
  console.log('Rebuilding contracts from source so the VK matches current contracts/src...');
  execSync('bun run --filter contracts build', { stdio: 'inherit' });

  // Dynamic import AFTER the rebuild so we load the freshly-built output.
  const { MinaGuard } = await import("contracts");
  if (!MinaGuard || typeof MinaGuard.compile !== 'function') {
    throw new Error(
      'Could not load MinaGuard from contracts build output. Rebuild with `bun run --filter contracts build`.'
    );
  }

  console.log('Compiling MinaGuard to extract verification key hash...');
  const cache = Cache.FileSystem('./cache');
  const { verificationKey } = await MinaGuard.compile({ cache });
  const hashText = verificationKey?.hash?.toString?.();

  if (!hashText) {
    throw new Error('Failed to read verification key hash from compile output.');
  }

  console.log(`vkHash: ${hashText}`);
}
