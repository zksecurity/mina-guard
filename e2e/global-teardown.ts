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

  // Kill backend and frontend (only locally — in CI they die with the job)
  if (existsSync(STATE_FILE)) {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    if (!IS_CI) {
      if (state.backendPid) killProcess(state.backendPid, 'backend');
      if (state.frontendPid) killProcess(state.frontendPid, 'frontend');
    }
    unlinkSync(STATE_FILE);
    log('State file cleaned up');
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
  }

  log('=== Teardown complete ===');
}
