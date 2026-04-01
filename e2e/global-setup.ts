import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
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
  /** Whether we stopped a local PostgreSQL and need to restart it in teardown. */
  restoreLocalPg: boolean;
}

// When using lightnet locally, lightnet's bundled PostgreSQL takes over port 5432.
// We create a `minaguard` database inside it and return that URL.
const LIGHTNET_DB_URL = 'postgresql://postgres:postgres@localhost:5432/minaguard';

function requireDatabaseUrl(useLightnetPg: boolean): string {
  if (useLightnetPg) return LIGHTNET_DB_URL;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Check your backend/.env file.');
  return url;
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
  // Track whether we're using lightnet's PostgreSQL (so we can pass it to the backend)
  let useLightnetPg = false;
  // Track whether we stopped a running local PostgreSQL (so teardown can restart it)
  let stoppedLocalPg = false;

  if (config.mode === 'lightnet') {
    if (!IS_CI) {
      log('Stopping any existing lightnet...');
      try {
        execSync('zk lightnet stop', { cwd: ROOT, stdio: 'pipe', timeout: 30_000 });
        log('Previous lightnet stopped');
      } catch {
        log('No existing lightnet to stop');
      }

      // Stop local PostgreSQL so lightnet can bind to port 5432 — but only if it's running
      const localPgRunning = (() => {
        try {
          const out = execSync('lsof -ti:5432 2>/dev/null || true', { stdio: 'pipe' }).toString().trim();
          return out.length > 0;
        } catch { return false; }
      })();

      if (localPgRunning) {
        log('Stopping local PostgreSQL to free port 5432 for lightnet...');
        try {
          execSync('brew services stop postgresql@17', { stdio: 'pipe', timeout: 15_000 });
          stoppedLocalPg = true;
          log('Local PostgreSQL stopped');
        } catch {
          log('No local PostgreSQL to stop (or not managed by brew)');
        }
      } else {
        log('Port 5432 is free — no need to stop local PostgreSQL');
      }
      await waitForPortFree(5432, 15_000);

      log('Starting lightnet (this may take 1-2 minutes)...');
      try {
        execSync('zk lightnet start -o 1000', {
          cwd: ROOT,
          stdio: 'inherit',
          timeout: 300_000,
        });
      } catch (err) {
        // Restart local PostgreSQL before throwing (only if we stopped it)
        if (stoppedLocalPg) {
          try { execSync('brew services start postgresql@17', { stdio: 'pipe' }); } catch {}
        }
        throw new Error(`Failed to start lightnet: ${err}`);
      }

      // Create the minaguard database in lightnet's PostgreSQL
      log('Creating minaguard database in lightnet PostgreSQL...');
      try {
        execSync(
          'docker exec $(docker ps -q --filter ancestor=o1labs/mina-local-network) ' +
            'psql -U postgres -c "CREATE DATABASE minaguard;" 2>/dev/null || true',
          { stdio: 'pipe', timeout: 15_000 },
        );
        log('minaguard database ready');
      } catch {
        log('Warning: could not create minaguard database (may already exist)');
      }
      useLightnetPg = true;
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
    const dbUrl = requireDatabaseUrl(useLightnetPg);
    execSync('bunx prisma db push --force-reset', {
      cwd: resolve(ROOT, 'backend'),
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: dbUrl },
    });
    log(`Database schema pushed (${useLightnetPg ? 'lightnet PG' : 'local PG'})`);

    // -----------------------------------------------------------------------
    // Verification key hash — compile the contract to get the vk hash so
    // the backend indexer only picks up MinaGuard contracts on devnet.
    // Skipped when MINAGUARD_VK_HASH is already set or in lightnet mode.
    // -----------------------------------------------------------------------
    let vkHash = process.env.MINAGUARD_VK_HASH ?? null;
    if (!vkHash && config.mode === 'devnet') {
      log('Compiling MinaGuard contract to extract vk hash (uses cache if available)...');
      try {
        const output = execSync('bun run dev-helpers/cli.ts vk-hash compile', {
          cwd: ROOT,
          stdio: 'pipe',
          timeout: 600_000, // 10 min — first compile is slow
        }).toString();
        const match = output.match(/vkHash:\s*(\S+)/);
        if (match) {
          vkHash = match[1];
          log(`  Extracted vk hash: ${vkHash.slice(0, 20)}...`);
        } else {
          log('  Warning: could not parse vk hash from compile output');
        }
      } catch (err) {
        log(`  Warning: vk hash compilation failed: ${err}`);
      }
    }

    // Start backend
    log('Starting backend...');
    const backendEnv: Record<string, string> = {
      INDEX_POLL_INTERVAL_MS: String(config.indexerPollIntervalMs),
      MINA_ENDPOINT: config.minaEndpoint,
      ARCHIVE_ENDPOINT: config.archiveEndpoint,
      DATABASE_URL: requireDatabaseUrl(useLightnetPg),
      PORT: '4000',
    };
    if (config.accountManagerUrl) {
      backendEnv.LIGHTNET_ACCOUNT_MANAGER = config.accountManagerUrl;
    }
    if (vkHash) {
      backendEnv.MINAGUARD_VK_HASH = vkHash;
    }
    const backendChild = spawnService(
      'bun',
      ['run', '--filter', 'backend', 'dev'],
      backendEnv,
      'backend'
    );

    // Start frontend
    log('Starting frontend...');
    const frontendChild = spawnService(
      'bun',
      ['run', '--filter', 'ui', 'dev'],
      {
        NEXT_PUBLIC_API_BASE_URL: config.backendUrl,
        NEXT_PUBLIC_MINA_ENDPOINT: config.minaEndpoint,
        NEXT_PUBLIC_ARCHIVE_ENDPOINT: config.archiveEndpoint,
        NEXT_PUBLIC_E2E_TEST: 'true',
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
    restoreLocalPg: stoppedLocalPg,
  };
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  log('State written to .e2e-state.json');

  log('=== Setup complete ===\n');
}
