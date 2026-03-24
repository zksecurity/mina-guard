import { execSync } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getNetworkConfig } from './network-config';

const ROOT = resolve(import.meta.dirname, '..');
const STATE_FILE = resolve(import.meta.dirname, '.e2e-state.json');
const IS_CI = process.env.CI === 'true';

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[e2e-teardown ${ts}] ${msg}`);
}

function killProcess(pid: number, label: string) {
  try {
    process.kill(-pid, 'SIGTERM');
    log(`Sent SIGTERM to ${label} (pgid ${pid})`);
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      log(`Sent SIGTERM to ${label} (pid ${pid})`);
    } catch {
      log(`${label} (pid ${pid}) already exited`);
    }
  }
}

export default async function globalTeardown() {
  log(`=== E2E Global Teardown (${IS_CI ? 'CI' : 'local'}) ===`);

  // Read state file once (before deleting it)
  let state: Record<string, unknown> | null = null;
  if (existsSync(STATE_FILE)) {
    state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    unlinkSync(STATE_FILE);
    log('State file cleaned up');
  }

  // Kill backend and frontend (only locally — in CI they die with the job)
  if (state && !IS_CI) {
    if (state.backendPid) killProcess(state.backendPid as number, 'backend');
    if (state.frontendPid) killProcess(state.frontendPid as number, 'frontend');
  }

  // Stop lightnet (only locally and only when using lightnet mode)
  if (!IS_CI && getNetworkConfig().mode === 'lightnet') {
    log('Stopping lightnet...');
    try {
      execSync('zk lightnet stop', { cwd: ROOT, stdio: 'pipe', timeout: 30_000 });
      log('Lightnet stopped');
    } catch {
      log('Lightnet stop failed or was not running');
    }

    // Restart local PostgreSQL only if we stopped it during setup
    if (state?.restoreLocalPg) {
      log('Restarting local PostgreSQL...');
      try {
        execSync('brew services start postgresql@17', { stdio: 'pipe', timeout: 15_000 });
        log('Local PostgreSQL restarted');
      } catch {
        log('Warning: could not restart local PostgreSQL — run "brew services start postgresql@17" manually');
      }
    }
  }

  log('=== Teardown complete ===');
}
