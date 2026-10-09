#!/usr/bin/env bun
import './wasm-shim.js';
import { isMainThread } from 'worker_threads';

// o1js spawns WASM workers by re-running this binary. In worker mode we must
// import node-backend.js so its !isMainThread block runs (posts ready, then
// blocks in wbg_rayon_start_worker until the thread pool is done). We must
// NOT run CLI code — workers have no CLI args and would print Usage and exit.
if (!isMainThread) {
  await import(
    '../../node_modules/o1js/dist/node/bindings/js/node/node-backend.js'
  );
  process.exit(0);
}
// ---------------------------------------------------------------------------
// mina-guard-cli — air-gapped CLI for building, proving, and signing
// Mina Guard multisig transactions.
//
// Usage:
//   MINA_PRIVATE_KEY=EKE... ./mina-guard-cli <bundle.json> [> signed.json]
//
// Reads a request bundle exported from the Mina Guard web UI, compiles the
// MinaGuard contract, builds a zero-knowledge proof, signs the transaction
// with the supplied private key, and outputs a ready-to-broadcast signed
// transaction JSON to stdout.
//
// Progress / diagnostic messages go to stderr so stdout stays clean JSON.
// ---------------------------------------------------------------------------

import { readFileSync } from 'fs';
import { handlePropose, handleApprove, handleExecute, canonicalizeBundleTxType, assertCreateChildBundleConfig } from './build-tx.js';
import type { OfflineBundle } from './build-tx.js';
import { OFFLINE_REQUEST_VERSION } from 'contracts';
import { renderBundleSummary, confirmOrExit } from './summary.js';
import { escapeTerminalLines } from './terminal-safe.js';
import { handleMigration, renderMigrationSummary, type MigrationBundle } from './migrate-vk.js';

// Messages can quote bundle values, so they are escaped like the summary.
function log(msg: string) {
  process.stderr.write(`[offline-cli] ${escapeTerminalLines(msg)}\n`);
}

function fatal(msg: string): never {
  process.stderr.write(escapeTerminalLines(msg) + '\n');
  process.exit(1);
}

// -- Arg parsing ------------------------------------------------------------

const args = process.argv.slice(2);
const bundlePath = args.find((a) => !a.startsWith('-'));
const assumeYes =
  process.env.MINA_GUARD_ASSUME_YES === '1' ||
  args.includes('--yes') ||
  args.includes('-y');
const rawKey = process.env.MINA_PRIVATE_KEY;

if (!bundlePath || !rawKey) {
  fatal(
    'Usage: MINA_PRIVATE_KEY=EKE... mina-guard-cli <bundle.json> [--yes] [> signed.json]\n' +
    '\n' +
    '  bundle.json        Path to the request bundle exported from the Mina Guard UI\n' +
    '  MINA_PRIVATE_KEY   Mina private key (base58, starts with EKE...); deploy key for migration\n' +
    '  MINA_FEE_PAYER_PRIVATE_KEY  Optional second fee payer key for migration\n' +
    '  --yes, -y          Skip the interactive sign confirmation; required when\n' +
    '                     running without a terminal (also MINA_GUARD_ASSUME_YES=1)\n' +
    '\n' +
    'Output (signed transaction JSON) is written to stdout.\n' +
    'Redirect to a file:  ... mina-guard-cli bundle.json > signed.json',
  );
}

const privateKey: string = rawKey;

// -- Read bundle ------------------------------------------------------------

function readBundle(path: string): OfflineBundle | MigrationBundle {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as OfflineBundle | MigrationBundle;
  } catch (err) {
    fatal(`Error reading bundle: ${err}`);
  }
}

const bundle = readBundle(bundlePath);

if (bundle.version !== OFFLINE_REQUEST_VERSION) {
  fatal(`Unsupported bundle version: ${bundle.version} (expected ${OFFLINE_REQUEST_VERSION}; export a new request with the current UI)`);
}

if (!['propose', 'approve', 'execute', 'migrate-verification-key'].includes(bundle.action)) {
  fatal(`Unknown bundle action: ${JSON.stringify((bundle as { action?: unknown }).action ?? null)}`);
}

// -- Dispatch ---------------------------------------------------------------

async function main() {
  if (bundle.action === 'migrate-verification-key') {
    let summary: string;
    try { summary = renderMigrationSummary(bundle); }
    catch (error) { fatal(`Invalid migration request: ${error instanceof Error ? error.message : String(error)}`); }
    confirmOrExit(summary, { assumeYes }, log);
    const feeKey = process.env.MINA_FEE_PAYER_PRIVATE_KEY ?? privateKey;
    const result = await handleMigration(bundle, privateKey, feeKey, log);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    log('Signed migration transaction written to stdout. Import it into the Vault migration screen.');
    return;
  }
  // Refuse an unknown transaction type before showing anything, and turn a
  // numeric code into its name, so the summary and the builder agree on it.
  // A CREATE_CHILD approval or execution also needs the SubVault owners and
  // threshold it carries, checked against the signed data, before they are shown.
  try {
    canonicalizeBundleTxType(bundle);
    if (bundle.action === 'approve' || bundle.action === 'execute') assertCreateChildBundleConfig(bundle);
  } catch (err) {
    fatal(`${err instanceof Error ? err.message : String(err)}\nAborted. No transaction was signed.`);
  }

  // Show the operator exactly what they are about to sign, and (on a real
  // terminal) require explicit confirmation — before any expensive
  // compile/prove/sign work and before touching the private key.
  const summary = renderBundleSummary(bundle);
  confirmOrExit(summary, { assumeYes }, log);

  let result: unknown;

  switch (bundle.action) {
    case 'propose':
      log('Action: propose');
      result = await handlePropose(bundle, privateKey, log);
      break;
    case 'approve':
      log('Action: approve');
      result = await handleApprove(bundle, privateKey, log);
      break;
    case 'execute':
      log('Action: execute');
      result = await handleExecute(bundle, privateKey, log);
      break;
    default:
      fatal(`Unknown bundle action: ${(bundle as any).action}`);
  }

  // Write clean JSON to stdout
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');

  log('Signed transaction written to stdout.');
  log('Next: copy the output file back to the online machine and upload it in the Mina Guard web UI.');
}

main().catch((err) => {
  fatal(`Fatal error: ${err?.stack ?? err}`);
});
