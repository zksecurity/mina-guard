#!/usr/bin/env bun
import './wasm-shim.js';
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
import { handlePropose, handleApprove, handleExecute } from './build-tx.js';
import type { OfflineBundle } from './build-tx.js';

function log(msg: string) {
  process.stderr.write(`[offline-cli] ${msg}\n`);
}

function fatal(msg: string): never {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

// -- Arg parsing ------------------------------------------------------------

const [bundlePath] = process.argv.slice(2);
const rawKey = process.env.MINA_PRIVATE_KEY;

if (!bundlePath || !rawKey) {
  fatal(
    'Usage: MINA_PRIVATE_KEY=EKE... mina-guard-cli <bundle.json> [> signed.json]\n' +
    '\n' +
    '  bundle.json        Path to the request bundle exported from the Mina Guard UI\n' +
    '  MINA_PRIVATE_KEY   Mina private key (base58, starts with EKE...)\n' +
    '\n' +
    'Output (signed transaction JSON) is written to stdout.\n' +
    'Redirect to a file:  ... mina-guard-cli bundle.json > signed.json',
  );
}

const privateKey: string = rawKey;

// -- Read bundle ------------------------------------------------------------

function readBundle(path: string): OfflineBundle {
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as OfflineBundle;
  } catch (err) {
    fatal(`Error reading bundle: ${err}`);
  }
}

const bundle = readBundle(bundlePath);

if (bundle.version !== 1) {
  fatal(`Unsupported bundle version: ${bundle.version} (expected 1)`);
}

// -- Dispatch ---------------------------------------------------------------

async function main() {
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
