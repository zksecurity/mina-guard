import { MinaGuard } from "contracts"
import { Cache } from "o1js";

/** Reads MinaGuard verification key hash from local contract compilation output. */
export async function runVkHashCompile(): Promise<void> {
  console.log('Compiling MinaGuard to extract verification key hash...');

  if (!MinaGuard || typeof MinaGuard.compile !== 'function') {
    throw new Error(
      'Could not load MinaGuard from contracts build output. Rebuild with `bun run --filter contracts build`.'
    );
  }

  const cache = Cache.FileSystem('./cache');
  const { verificationKey } = await MinaGuard.compile({ cache });
  const hashValue = verificationKey?.hash;
  const hashText = hashValue?.toString?.();

  if (!hashText) {
    throw new Error('Failed to read verification key hash from compile output.');
  }

  console.log(`vkHash: ${hashText}`);
}
