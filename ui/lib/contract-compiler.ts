/** Share compilation across callers; a failed attempt must remain retryable. */
export function createContractCompiler(compile: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(compile).catch((error: unknown) => {
        pending = null;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Contract compilation failed: ${detail}`);
      });
    }
    return pending;
  };
}
