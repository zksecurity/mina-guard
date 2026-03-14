import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const STATE_FILE = resolve(import.meta.dirname, '.e2e-state.json');
const ACCOUNT_MANAGER = 'http://127.0.0.1:8181';
const BACKEND_URL = 'http://localhost:4000';
const FRONTEND_URL = 'http://localhost:3000';

// In CI, lightnet/backend/frontend are started externally (GitHub Actions services + steps).
// Locally, we manage the full lifecycle ourselves.
const IS_CI = process.env.CI === 'true';

interface TestAccount {
  publicKey: string;
  privateKey: string;
}

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

async function acquireAccount(): Promise<TestAccount> {
  const res = await fetch(`${ACCOUNT_MANAGER}/acquire-account`);
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

export default async function globalSetup() {
  log(`=== E2E Global Setup (${IS_CI ? 'CI' : 'local'}) ===`);

  // -----------------------------------------------------------------------
  // Lightnet — only managed locally; in CI it's a Docker service
  // -----------------------------------------------------------------------
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
    'http://127.0.0.1:8080/graphql',
    'Mina daemon',
    60_000
  ).catch(() => {
    log('Daemon GET failed, assuming it is up (GraphQL needs POST)');
  });
  await waitForUrl(ACCOUNT_MANAGER, 'Account manager', 60_000);

  // -----------------------------------------------------------------------
  // Test accounts
  // -----------------------------------------------------------------------
  log('Acquiring 3 funded test accounts...');
  const accounts: TestAccount[] = [];
  for (let i = 0; i < 3; i++) {
    const acc = await acquireAccount();
    accounts.push(acc);
    log(`  Account ${i + 1}: ${acc.publicKey}`);
  }

  // -----------------------------------------------------------------------
  // Backend + Frontend — only managed locally; in CI they're started by the workflow
  // -----------------------------------------------------------------------
  let backendPid = 0;
  let frontendPid = 0;

  if (!IS_CI) {
    // Kill stale processes on our ports
    log('Killing any stale processes on ports 3000 and 4000...');
    try {
      execSync('lsof -ti:3000 | xargs kill -9 2>/dev/null || true', { stdio: 'pipe' });
      execSync('lsof -ti:4000 | xargs kill -9 2>/dev/null || true', { stdio: 'pipe' });
    } catch {
      // fine
    }

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
    const backendChild = spawnService(
      'bun',
      ['run', 'dev:backend'],
      {
        INDEX_POLL_INTERVAL_MS: '5000',
        MINA_ENDPOINT: 'http://127.0.0.1:8080/graphql',
        ARCHIVE_ENDPOINT: 'http://127.0.0.1:8282',
        LIGHTNET_ACCOUNT_MANAGER: ACCOUNT_MANAGER,
        DATABASE_URL: 'file:./dev.db',
        PORT: '4000',
      },
      'backend'
    );

    // Start frontend
    log('Starting frontend...');
    const frontendChild = spawnService(
      'bun',
      ['run', 'dev'],
      {
        NEXT_PUBLIC_API_BASE_URL: BACKEND_URL,
        NEXT_PUBLIC_MINA_ENDPOINT: 'http://127.0.0.1:8080/graphql',
        NEXT_PUBLIC_ARCHIVE_ENDPOINT: 'http://127.0.0.1:8282',
        NEXT_PUBLIC_SKIP_PROOFS: 'false',
      },
      'frontend'
    );

    backendPid = backendChild.pid!;
    frontendPid = frontendChild.pid!;

    backendChild.unref();
    frontendChild.unref();
  }

  // Wait for services (both CI and local)
  await waitForUrl(`${BACKEND_URL}/health`, 'Backend');
  await waitForUrl(FRONTEND_URL, 'Frontend');

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
