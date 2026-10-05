import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asAccounts, transactionFeePayer } from '../src/auro/signer.js';

const A = 'B62qkYgXmsk3R65YGNG41Zqu61hf9X1qBktDPzZkkthkSnukbXLPCAY';
const B = 'B62qoG5Yk4iVxpyczUrBNpwtx2xunhL48dydN53A2VjoRwF8NUjtL3';
const zkappCommand = (feePayer: string) => ({ feePayer: { body: { publicKey: feePayer, fee: '100000000' } }, accountUpdates: [] });

describe('transaction signer for the Auro bridge', () => {
  it('reads the fee payer from a JSON string or an object', () => {
    expect(transactionFeePayer({ transaction: JSON.stringify(zkappCommand(A)) })).toBe(A);
    expect(transactionFeePayer({ transaction: zkappCommand(B), feePayer: { memo: 'x' } })).toBe(B);
  });

  it('refuses a transaction without a usable fee payer', () => {
    expect(() => transactionFeePayer({ transaction: '{not json' })).toThrow('not valid JSON');
    expect(() => transactionFeePayer({ transaction: '{}' })).toThrow('no fee payer');
    expect(() => transactionFeePayer(null)).toThrow('no fee payer');
  });

  it('keeps only lists of account strings', () => {
    expect(asAccounts([A])).toEqual([A]);
    for (const bad of [undefined, null, A, [A, 1], { 0: A }]) expect(asAccounts(bad)).toEqual([]);
  });
});

/** Runs the bridge page's own script against a stub browser with Auro set to `activeAccount`. */
async function runBridgePage(method: string, payload: unknown, activeAccount: string) {
  const html = readFileSync(join(import.meta.dir, '..', 'src', 'auro', 'page.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1].trim());
  const script = scripts[scripts.length - 1];
  const sent: unknown[] = [];
  let callback: { id: string; result?: unknown; error?: string } | undefined;
  const element = () => ({ textContent: '', className: '', style: {} as Record<string, string> });
  const elements: Record<string, ReturnType<typeof element>> = {};
  const window = {
    location: { search: '?id=req-1', pathname: `/auro/${method}` },
    addEventListener() {},
    removeEventListener() {},
    mina: {
      requestAccounts: async () => [activeAccount],
      sendTransaction: async (params: unknown) => { sent.push(params); return { hash: 'tx-hash' }; },
      signFields: async () => ({ signature: 'sig' }),
    },
  };
  const document = { getElementById: (id: string) => (elements[id] ??= element()) };
  const fetch = async (url: string, init?: { body?: string }) => {
    if (url.startsWith('/auro/payload')) return { json: async () => payload };
    if (url === '/auro/callback') callback = JSON.parse(init!.body!);
    return { json: async () => ({ ok: true }) };
  };
  await new Function('window', 'document', 'fetch', `return ${script}`)(window, document, fetch);
  return { sent, callback };
}

describe('Auro bridge page', () => {
  const params = { transaction: JSON.stringify(zkappCommand(A)) };

  it('sends when Auro is set to the expected signer, without the extra field', async () => {
    const { sent, callback } = await runBridgePage('sendTransaction', { params, expectedSigner: A }, A);
    expect(sent).toEqual([params]);
    expect(callback).toEqual({ id: 'req-1', result: { hash: 'tx-hash' } });
  });

  it('refuses before Auro sees the transaction when another account is active', async () => {
    const { sent, callback } = await runBridgePage('sendTransaction', { params, expectedSigner: A }, B);
    expect(sent).toEqual([]);
    expect(callback?.error).toContain(`Auro's active account is not ${A}`);
  });

  it('refuses a send that names no expected signer', async () => {
    const { sent, callback } = await runBridgePage('sendTransaction', params, A);
    expect(sent).toEqual([]);
    expect(callback?.error).toContain("Auro's active account is not");
  });

  it('leaves other requests unchanged', async () => {
    const { callback } = await runBridgePage('signFields', { message: ['1'] }, B);
    expect(callback).toEqual({ id: 'req-1', result: { signature: 'sig' } });
  });
});

/** Loads preload.js with a stub `electron` and returns the `window.mina` it exposes. */
function loadPreloadMina(invoke: (channel: string, ...args: unknown[]) => Promise<unknown>) {
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'preload.js'), 'utf8');
  const exposed: Record<string, any> = {};
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { exposed[name] = api; } },
    ipcRenderer: { sendSync: () => ({ networkId: 'testnet' }), invoke },
  };
  new Function('require', source)((name: string) => {
    if (name !== 'electron') throw new Error(`unexpected require ${name}`);
    return electron;
  });
  return exposed.mina;
}

describe('desktop window.mina errors', () => {
  it("shows the bridge's message without Electron's IPC prefix", async () => {
    const mina = loadPreloadMina(async (channel) => {
      throw new Error(`Error invoking remote method '${channel}': Error: Auro's active account is not ${A}`);
    });
    await expect(mina.sendTransaction({})).rejects.toThrow(new RegExp(`^Auro's active account is not ${A}$`));
    await expect(mina.signFields({})).rejects.toThrow(new RegExp(`^Auro's active account is not ${A}$`));
  });

  it('passes results and unprefixed errors through unchanged', async () => {
    expect(await loadPreloadMina(async () => [A]).getAccounts()).toEqual([A]);
    await expect(loadPreloadMina(async () => { throw new Error('User rejected'); }).signMessage({}))
      .rejects.toThrow(/^User rejected$/);
  });
});
