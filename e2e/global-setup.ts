import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getNetworkConfig, getDevnetAccounts, type TestAccount } from './network-config';

const ROOT = resolve(import.meta.dirname, '..');
const STATE_FILE = resolve(import.meta.dirname, '.e2e-state.json');

// In CI, lightnet/backend/frontend are started externally (GitHub Actions services + steps).
// Locally, we manage the full lifecycle ourselves.
const IS_CI = process.env.CI === 'true';

interface E2eState {
  accounts: TestAccount[];
  backendPid: number;
  frontendPid: number;
}

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[e2e-setup ${ts}] ${msg}`);
}

async function waitForUrl(
  url: string,
  label: string,
  timeoutMs = 120_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        log(`${label} is ready`);
        return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

async function acquireAccount(accountManagerUrl: string): Promise<TestAccount> {
  const res = await fetch(`${accountManagerUrl}/acquire-account`);
  if (!res.ok) {
    throw new Error(
      `Account manager returned ${res.status}: ${await res.text()}`
    );
  }
  const data = (await res.json()) as { pk: string; sk: string };
  return { publicKey: data.pk, privateKey: data.sk };
}

function spawnService(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  label: string
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log(`[${label}] ${line}`);
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log(`[${label}:err] ${line}`);
    }
  });

  child.on('error', (err) => log(`[${label}] spawn error: ${err.message}`));
  return child;
}

async function waitForPortFree(port: number, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = execSync(`lsof -ti:${port} 2>/dev/null || true`, { stdio: 'pipe' }).toString().trim();
      if (!out) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`Warning: port ${port} still in use after ${timeoutMs / 1000}s`);
}

export default async function globalSetup() {
  const config = getNetworkConfig();
  log(`=== E2E Global Setup (${IS_CI ? 'CI' : 'local'}, network=${config.mode}) ===`);

  // -----------------------------------------------------------------------
  // Lightnet — only managed locally; in CI it's a Docker service
  // Skipped entirely when running against devnet.
  // -----------------------------------------------------------------------
  if (config.mode === 'lightnet') {
    if (!IS_CI) {
      log('Stopping any existing lightnet...');
      try {
        execSync('zk lightnet stop', { cwd: ROOT, stdio: 'pipe', timeout: 30_000 });
        log('Previous lightnet stopped');
      } catch {
        log('No existing lightnet to stop');
      }

      log('Starting lightnet (this may take 1-2 minutes)...');
      try {
        execSync('zk lightnet start', {
          cwd: ROOT,
          stdio: 'inherit',
          timeout: 300_000,
        });
      } catch (err) {
        throw new Error(`Failed to start lightnet: ${err}`);
      }
    }

    // Wait for lightnet services (both CI and local)
    log('Waiting for lightnet services...');
    await waitForUrl(
      config.minaEndpoint,
      'Mina daemon',
      60_000
    ).catch(() => {
      log('Daemon GET failed, assuming it is up (GraphQL needs POST)');
    });
    await waitForUrl(config.accountManagerUrl!, 'Account manager', 60_000);
  }

  // -----------------------------------------------------------------------
  // Test accounts
  // -----------------------------------------------------------------------
  let accounts: TestAccount[];

  if (config.mode === 'devnet') {
    log('Loading hardcoded devnet accounts...');
    accounts = getDevnetAccounts();
  } else {
    log('Acquiring 3 funded test accounts from lightnet...');
    accounts = [];
    for (let i = 0; i < 3; i++) {
      const acc = await acquireAccount(config.accountManagerUrl!);
      accounts.push(acc);
    }
  }
  accounts.forEach((a, i) => log(`  Account ${i + 1}: ${a.publicKey}`));

  // -----------------------------------------------------------------------
  // Backend + Frontend — only managed locally; in CI they're started by the workflow
  // -----------------------------------------------------------------------
  let backendPid = 0;
  let frontendPid = 0;

  if (!IS_CI) {
    // Kill stale processes on our ports and wait for them to release
    log('Killing any stale processes on ports 3000 and 4000...');
    try {
      execSync('lsof -ti:3000 | xargs kill -9 2>/dev/null || true', { stdio: 'pipe' });
      execSync('lsof -ti:4000 | xargs kill -9 2>/dev/null || true', { stdio: 'pipe' });
    } catch {
      // fine
    }
    // Wait until ports are actually free
    await waitForPortFree(4000);
    await waitForPortFree(3000);

    // Reset database
    log('Resetting backend database...');
    const dbPath = resolve(ROOT, 'backend/prisma/dev.db');
    if (existsSync(dbPath)) {
      unlinkSync(dbPath);
      log('Deleted existing dev.db');
    }
    execSync('bunx prisma db push', {
      cwd: resolve(ROOT, 'backend'),
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: 'file:./dev.db' },
    });
    log('Database schema pushed');

    // Start backend
    log('Starting backend...');
    const backendEnv: Record<string, string> = {
      INDEX_POLL_INTERVAL_MS: String(config.indexerPollIntervalMs),
      MINA_ENDPOINT: config.minaEndpoint,
      ARCHIVE_ENDPOINT: config.archiveEndpoint,
      DATABASE_URL: 'file:./dev.db',
      PORT: '4000',
    };
    if (config.accountManagerUrl) {
      backendEnv.LIGHTNET_ACCOUNT_MANAGER = config.accountManagerUrl;
    }
    const backendChild = spawnService(
      'bun',
      ['run', 'dev:backend'],
      backendEnv,
      'backend'
    );

    // Start frontend
    log('Starting frontend...');
    const frontendChild = spawnService(
      'bun',
      ['run', 'dev'],
      {
        NEXT_PUBLIC_API_BASE_URL: config.backendUrl,
        NEXT_PUBLIC_MINA_ENDPOINT: config.minaEndpoint,
        NEXT_PUBLIC_ARCHIVE_ENDPOINT: config.archiveEndpoint,
      },
      'frontend'
    );

    backendPid = backendChild.pid!;
    frontendPid = frontendChild.pid!;

    backendChild.unref();
    frontendChild.unref();
  }

  // Wait for services (both CI and local)
  await waitForUrl(`${config.backendUrl}/health`, 'Backend');
  await waitForUrl(config.frontendUrl, 'Frontend');

  // Write state for tests and teardown
  const state: E2eState = {
    accounts,
    backendPid,
    frontendPid,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log('State written to .e2e-state.json');

  log('=== Setup complete ===\n');
}
