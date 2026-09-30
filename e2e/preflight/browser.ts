/** Real preflight, UI and online wrappers; wallet/prover/node responses are fixtures. */
import { GUARD_PERMISSION_KINDS } from 'contracts/guard-permission-policy';
import { chromium, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dir, '../..');
const temp = await mkdtemp(join(tmpdir(), 'mg-preflight-'));
const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'fixture.tsx')], target: 'browser', outdir: temp,
  define: { 'process.env': '{}', 'process.env.NODE_ENV': '"test"', 'process.env.NEXT_PUBLIC_E2E_TEST': '"true"',
    'process.env.NEXT_PUBLIC_MINA_ENDPOINT': '"http://preflight.test/graphql"', 'process.env.NEXT_PUBLIC_API_BASE_URL': '"http://preflight.test"',
    'process.env.NEXT_PUBLIC_MINA_NETWORK': '"testnet"', 'process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL': '"https://explorer.test"' },
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, args => ({ path: Bun.resolveSync(args.path, join(root, 'ui')) }));
    b.onResolve({ filter: /^(comlink|mina-signer)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    b.onResolve({ filter: /ledgerWallet$/ }, () => ({ path: 'ledger', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ loader: 'js', contents: args.path === 'comlink'
      ? 'export const proxy=x=>x; export const wrap=()=>window.workerApi;'
      : args.path === 'mina-signer' ? 'export default class Client {}'
      : 'export const signFields=async()=>null; export const signFeePayer=async()=>null; export const checkLedgerReady=async()=>{};' }));
    b.onResolve({ filter: /^@\// }, args => ({ path: Bun.resolveSync(resolve(root, 'ui', args.path.slice(2)), root) }));
  } }] });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const js = await build.outputs[0].text();
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  let rootValue = '1'; let outage = false; let broadcasts = 0;
  await page.addInitScript(() => {
    const w = window as any;
    w.Worker = class { addEventListener() {} };
    w.policies = 0; w.exports = 0; w.completed = 0; w.builds = 0; w.expected = '1'; w.eligibility = { status: 'eligible' };
    w.tx = () => JSON.stringify({ feePayer: { body: { publicKey: 'owner' } }, accountUpdates: [{ body: {
      publicKey: 'vault', tokenId: '1', preconditions: { account: { state: [w.expected], isNew: false } }, update: { appState: [null] },
    } }] });
    w.workerApi = { setConfig() {}, setPreflightCheck(fn: any) { w.check = fn; }, assessRetry: async () => w.eligibility };
    for (const name of ['createOnchainProposal', 'approveProposalOnchain', 'executeProposalOnchain', 'executeSetupChildOnchain', 'executeChildLifecycleOnchain']) {
      w.workerApi[name] = async () => { w.builds++; if (w.storeError) throw new Error(w.storeError); await w.check(w.tx()); w.completed++; return name === 'createOnchainProposal' ? { proposalHash: '42', txHash: 'hash' } : 'Transaction submitted: hash'; };
    }
  });
  await page.route('http://preflight.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/fixture.js"></script>' });
    if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: js });
    if (path === '/graphql') {
      if (route.request().postData()?.includes('sendZkapp')) { broadcasts++; return route.fulfill({ json: { data: { sendZkapp: { zkapp: { hash: 'offline-hash' } } } } }); }
      return route.fulfill({ status: outage ? 503 : 200, json: { data: { account: { zkappState: [rootValue] } } } });
    }
    if (path.endsWith('/security')) return route.fulfill({ json: { accountFound: true, verificationKeyMatches: true, safe: true, permissionKinds: GUARD_PERMISSION_KINDS, permissionMismatches: [] } });
    if (path.includes('/proposals/42')) return route.fulfill({ json: { proposalHash: '42', status: 'pending', executionTxHash: 'confirmed-hash', receivers: [] } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto('http://preflight.test');
  const args = { contractAddress: 'vault', parentAddress: 'vault', childAddress: null, proposerAddress: 'owner', approverAddress: 'owner', executorAddress: 'owner', proposal: { proposalHash: '42' }, input: {}, configNonce: 0 };
  const online = (name = 'approveProposalOnchain') => page.evaluate(async ({ args, name }) => {
    try { await (window as any).online[name](args); return 'sent'; } catch (e) { return (e as Error).message; }
  }, { args, name });
  for (const name of ['createOnchainProposal', 'approveProposalOnchain', 'executeProposalOnchain', 'executeSetupChildOnchain', 'executeChildLifecycleOnchain']) expect(await online(name)).toBe('sent');
  rootValue = '2';
  let attempt = online();
  await expect(page.getByRole('heading', { name: 'The vault changed', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).completed)).toBe(5);
  await page.evaluate(() => { (window as any).expected = '2'; });
  await page.getByRole('button', { name: 'Rebuild transaction', exact: true }).click();
  expect(await attempt).toBe('sent');
  await page.evaluate(() => { (window as any).expected = '1'; (window as any).eligibility = { status: 'executed' }; });
  attempt = online();
  await expect(page.getByRole('heading', { name: 'Proposal already executed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rebuild transaction' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'View execution' })).toHaveAttribute('href', 'https://explorer.test/tx/confirmed-hash?type=zk-tx');
  await page.getByRole('button', { name: 'Dismiss' }).click();
  expect(await attempt).toContain('cancelled');
  for (const message of ['The vault configuration changed and invalidated this proposal.', 'This proposal has expired.', 'This owner has already approved this proposal.']) {
    await page.evaluate(message => { (window as any).eligibility = { status: 'invalid', message }; }, message);
    attempt = online();
    await expect(page.getByRole('heading', { name: 'This action is no longer available' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rebuild transaction' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Dismiss' }).click();
    expect(await attempt).toContain('cancelled');
  }
  outage = true;
  await page.evaluate(() => { (window as any).eligibility = { status: 'eligible' }; });
  const builds = await page.evaluate(() => (window as any).builds);
  attempt = online();
  await expect(page.getByRole('heading', { name: 'Couldn’t check the vault' })).toBeVisible();
  outage = false; rootValue = '1';
  await page.getByRole('button', { name: 'Retry check' }).click();
  expect(await attempt).toBe('sent');
  expect(await page.evaluate(() => (window as any).builds)).toBe(builds + 1);
  rootValue = '2';
  const file = await page.evaluate(() => JSON.stringify({ version: 1, type: 'offline-signed-tx', action: 'execute', contractAddress: 'vault', proposalHash: '42', transaction: (window as any).tx() }));
  await page.locator('input[type=file]').setInputFiles({ name: 'signed.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.getByRole('heading', { name: 'This transaction needs a new proof' })).toBeVisible();
  expect(broadcasts).toBe(0);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export fresh request' }).click();
  expect((await download).suggestedFilename()).toContain('execute');
  await expect(page.getByText('Fresh request downloaded. Sign it on your offline device, then upload the new signed file.')).toBeVisible();
  expect(broadcasts).toBe(0);
  rootValue = '1';
  await page.locator('input[type=file]').setInputFiles({ name: 'signed.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.getByText('Transaction broadcast successfully.')).toBeVisible();
  expect(broadcasts).toBe(1);
  expect(await page.evaluate(() => (window as any).policies)).toBe(2);
  const storeError = "Rebuilt approval map does not match the vault's on-chain approval root. The indexed events do not reproduce this state yet; wait for the indexer to catch up and retry.";
  await page.evaluate(message => { (window as any).storeError = message; }, storeError);
  const completedBeforeStoreRetry = await page.evaluate(() => (window as any).completed);
  attempt = online();
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rebuild transaction' })).toHaveCount(0);
  const storeBuilds = await page.evaluate(() => (window as any).builds);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).builds)).toBe(storeBuilds + 1);
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).completed)).toBe(completedBeforeStoreRetry);
  await page.evaluate(() => { (window as any).storeError = null; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect(await attempt).toBe('sent');
  await page.evaluate(message => { (window as any).storeError = message; }, storeError);
  attempt = online();
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await attempt).toContain('cancelled');
  await page.getByRole('button', { name: 'Export Approve Bundle', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export Approve Bundle', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Export Approve Bundle', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toBeVisible();
  await page.evaluate(() => { (window as any).storeError = null; });
  const retriedExport = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect((await retriedExport).suggestedFilename()).toContain('approve');
  expect(await page.evaluate(() => (window as any).exportBuilds)).toBe(3);
  await page.evaluate(() => { (window as any).storeError = 'Network unavailable'; });
  expect(await online()).toBe('Network unavailable');
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toHaveCount(0);
  await page.evaluate(() => { (window as any).storeError = null; });
  rootValue = '2';
  attempt = online();
  await expect(page.getByRole('heading', { name: 'The vault changed', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).unmount());
  expect(await attempt).toContain('cancelled');
  await page.reload();
  await page.evaluate(message => { (window as any).storeError = message; }, storeError);
  attempt = online();
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toBeVisible();
  const attemptsBeforeNetworkChange = await page.evaluate(() => (window as any).builds);
  await page.evaluate(() => { (window as any).__minaGuardConfig = { networkId: 'mainnet', minaEndpoint: 'http://other.test', archiveEndpoint: 'http://other.test' }; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  expect(await attempt).toContain('Network changed');
  expect(await page.evaluate(() => (window as any).builds)).toBe(attemptsBeforeNetworkChange);
  await page.evaluate(() => { delete (window as any).__minaGuardConfig; });
  attempt = online();
  await expect(page.getByRole('heading', { name: 'Vault data isn’t up to date' })).toBeVisible();
  await page.evaluate(() => (window as any).unmount());
  expect(await attempt).toContain('cancelled');
  expect(errors).toEqual([]);
  console.log('PASS: five online producers, stale stop/rebuild, terminal execution link, connection retry without re-proving, offline stop/export/broadcast, initial store retry/cancel, network-change and navigation cancellation');
} finally { await browser.close(); await rm(temp, { recursive: true, force: true }); }
