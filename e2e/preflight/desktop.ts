/** Smoke the actual Linux package with a fresh profile and loopback fixtures.
 * Run: xvfb-run -a node e2e/preflight/desktop.ts
 * No wallet signatures or chain writes are performed. */
import { chromium, expect } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';

const root = resolve(import.meta.dirname, '../..');
for (const port of [5050, 5051]) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise<void>(resolve => probe.close(() => resolve()));
}
const profile = mkdtempSync(join(tmpdir(), 'mg-packaged-desktop-'));

const fixture = createHttpServer(async (req, res) => {
  const response = await fixtureResponse(new Request(`http://127.0.0.1:5099${req.url}`));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(await response.text());
});
await new Promise<void>((resolve, reject) => { fixture.once('error', reject); fixture.listen(5099, '127.0.0.1', resolve); });
async function fixtureResponse(req: Request) {
  const path = new URL(req.url).pathname;
  const headers = { 'access-control-allow-origin': 'http://127.0.0.1:5050', 'cache-control': 'no-store' };
  if (path === '/graphql') return Response.json({ data: {
    networkID: 'testnet', __typename: 'Query',
    genesisConstants: { genesisTimestamp: '2026-01-01T00:00:00Z' },
    daemonStatus: { consensusConfiguration: { slotDuration: 180000 } }, bestChain: [], account: null,
  } }, { headers: { ...headers, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" } });
  return new Response('Unknown fixture', { status: 404 });
}
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let child: ReturnType<typeof spawn> | undefined;
try {
  child = spawn(join(root, 'desktop/release/linux-unpacked/desktop'), ['--no-sandbox',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`], {
    env: { ...process.env }, stdio: 'inherit',
  });
  const portFile = join(profile, 'DevToolsActivePort');
  await expect.poll(() => existsSync(portFile), { timeout: 30000 }).toBe(true);
  const debugPort = readFileSync(portFile, 'utf8').split('\n')[0];
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const context = browser.contexts()[0];
  await expect.poll(() => context.pages().length, { timeout: 30000 }).toBeGreaterThan(0);
  const setup = context.pages()[0];
  await setup.locator('#mina').fill('http://127.0.0.1:5099/graphql');
  await setup.locator('#archive').fill('http://127.0.0.1:5099/graphql');
  const nextWindow = context.waitForEvent('page', { timeout: 60000 });
  await setup.locator('#save').click();
  const page = await nextWindow;
  await page.waitForURL('http://127.0.0.1:5050/', { timeout: 60000 });
  await expect(page.locator('body')).toContainText('MINAGUARD');
  expect(await (await fetch('http://127.0.0.1:5050/api/contracts')).json()).toEqual([]);
  expect(existsSync(join(profile, 'minaguard.db'))).toBe(true);
  const db = new DatabaseSync(join(profile, 'minaguard.db'), { readOnly: true });
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Contract'").all()).toHaveLength(1);
  db.close();
  // The preflight shares this runtime-configured node and existing CSP allowance.
  const result = await page.evaluate(async () => {
    const config = (window as any).__minaGuardConfig;
    const response = await fetch(config.minaEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ account(publicKey: "fixture") { zkappState } }' }) });
    return { endpoint: config.minaEndpoint, data: await response.json() };
  });
  expect(result.endpoint).toBe('http://127.0.0.1:5099/graphql');
  expect(result.data.data.networkID).toBe('testnet');
  console.log('PASS: packaged Linux startup, native SQLite, runtime node endpoint and CSP access');
} finally {
  if (browser) {
    for (const page of browser.contexts()[0].pages()) await page.close();
    await browser.close();
  }
  if (child && child.exitCode === null) {
    await new Promise<void>(resolve => { const timer = setTimeout(() => child?.kill('SIGTERM'), 10000); child!.once('exit', () => { clearTimeout(timer); resolve(); }); });
  }
  await new Promise<void>(resolve => fixture.close(() => resolve()));
  rmSync(profile, { recursive: true, force: true });
}
