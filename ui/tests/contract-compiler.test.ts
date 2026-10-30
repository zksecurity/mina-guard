import { describe, expect, it } from 'bun:test';
import { createContractCompiler } from '../lib/contract-compiler';

describe('contract compilation', () => {
  it('shares an in-flight and successful compilation', async () => {
    let attempts = 0;
    let finish!: () => void;
    const compile = createContractCompiler(async () => {
      attempts++;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const first = compile();
    const second = compile();
    expect(first).toBe(second);
    await Promise.resolve();
    finish();
    await first;
    await compile();
    expect(attempts).toBe(1);
  });

  it('preserves the failure for every caller and recompiles on retry', async () => {
    let attempts = 0;
    const compile = createContractCompiler(async () => {
      if (++attempts === 1) throw new Error('Verification key mismatch; retry to rebuild');
    });
    const results = await Promise.allSettled([compile(), compile()]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason.message).toBe('Contract compilation failed: Verification key mismatch; retry to rebuild');
      }
    }
    await compile();
    expect(attempts).toBe(2);
  });

  it('reports non-Error failures with the compilation stage', async () => {
    const compile = createContractCompiler(async () => { throw 'WASM could not load'; });
    await expect(compile()).rejects.toThrow('Contract compilation failed: WASM could not load');
  });
});
