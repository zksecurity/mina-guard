// ---------------------------------------------------------------------------
// Human-readable bundle summary + interactive sign confirmation.
//
// The offline CLI is the air-gapped operator's last line of defense against a
// tampered or swapped bundle: before any compile/prove/sign work, we render a
// plaintext description of exactly what is about to be signed and (on a real
// terminal) require an explicit y/N confirmation.
//
// Everything here writes to STDERR — stdout must stay pure signed-tx JSON.
//
// Self-contained by convention (mirrors decodeTxMemo / normalizeTxType in
// build-tx.ts): format helpers are duplicated from ui/lib/types.ts rather than
// imported, so the CLI has no dependency on the web app.
// ---------------------------------------------------------------------------

import { openSync, readSync, closeSync } from 'fs';
import {
  normalizeTxType,
  EMPTY_PUBKEY_B58,
  type TxType,
  type OfflineBundle,
  type OfflineProposeBundle,
  type OfflineApproveBundle,
  type OfflineExecuteBundle,
} from './build-tx.js';

// ---------------------------------------------------------------------------
// Format helpers (mirrored from ui/lib/types.ts)
// ---------------------------------------------------------------------------

/** Formats a nanomina string into human-readable MINA decimal text. */
export function formatMina(nanomina: string | null | undefined): string {
  if (!nanomina) return '0';
  let n: bigint;
  try {
    n = BigInt(nanomina);
  } catch {
    return '0';
  }
  const NANO = 1_000_000_000n;
  const whole = n / NANO;
  const frac = n % NANO;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(9, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

const TX_TYPE_LABELS: Record<TxType, string> = {
  transfer: 'Send',
  addOwner: 'Add Owner',
  removeOwner: 'Remove Owner',
  changeThreshold: 'Change Threshold',
  setDelegate: 'Set Delegate',
  createChild: 'Create SubVault',
  allocateChild: 'Allocate to SubVaults',
  reclaimChild: 'Reclaim from SubVault',
  destroyChild: 'Destroy SubVault',
  enableChildMultiSig: 'Toggle SubVault Multi-sig',
};

function actionLabel(rawTxType: string | null | undefined): string {
  const t = normalizeTxType(rawTxType);
  if (t) return TX_TYPE_LABELS[t];
  return rawTxType ? `Unknown (${rawTxType})` : 'Unknown';
}

// ---------------------------------------------------------------------------
// Summary rendering
// ---------------------------------------------------------------------------

interface Receiverish {
  address: string;
  amount: string;
}

/** Non-empty (non-padding) receivers only. */
function realReceivers(receivers: Receiverish[] | undefined | null): Receiverish[] {
  if (!Array.isArray(receivers)) return [];
  return receivers.filter((r) => r && r.address && r.address !== EMPTY_PUBKEY_B58);
}

function totalMina(receivers: Receiverish[]): string {
  let sum = 0n;
  for (const r of receivers) {
    try {
      sum += BigInt(r.amount ?? '0');
    } catch {
      /* ignore malformed amount in the total */
    }
  }
  return formatMina(sum.toString());
}

function line(label: string, value: string | number | null | undefined): string {
  return `  ${label.padEnd(16)}${value ?? ''}`;
}

function renderReceivers(receivers: Receiverish[]): string[] {
  const out: string[] = [];
  const real = realReceivers(receivers);
  if (real.length === 0) {
    out.push(line('Receivers', '(none)'));
    return out;
  }
  out.push(`  Receivers (${real.length}):`);
  for (const r of real) {
    out.push(`    ${r.address}  →  ${formatMina(r.amount)} MINA`);
  }
  out.push(line('Total', `${totalMina(real)} MINA`));
  return out;
}

/** Body lines specific to the tx type, given the resolved field sources. */
function renderBody(
  txType: TxType | null,
  src: {
    receivers?: Receiverish[];
    ownerTarget?: string | null;
    threshold?: string | number | null;
    delegate?: string | null;
    undelegate?: boolean;
    childAddress?: string | null;
    childOwners?: string[] | null;
    childThreshold?: string | number | null;
    reclaimAmount?: string | null;
    enableMultiSig?: boolean | null;
  },
): string[] {
  switch (txType) {
    case 'transfer':
    case 'allocateChild':
      return renderReceivers(src.receivers ?? []);
    case 'addOwner':
      return [line('New owner', src.ownerTarget ?? '(unknown)')];
    case 'removeOwner':
      return [line('Remove owner', src.ownerTarget ?? '(unknown)')];
    case 'changeThreshold':
      return [line('New threshold', src.threshold ?? '(unknown)')];
    case 'setDelegate':
      return src.undelegate
        ? [line('Delegate', 'undelegate (clear)')]
        : [line('Delegate to', src.delegate ?? '(unknown)')];
    case 'createChild': {
      const out = [line('SubVault', src.childAddress ?? '(unknown)')];
      if (src.childOwners && src.childOwners.length) {
        out.push(`  Owners (${src.childOwners.length}):`);
        for (const o of src.childOwners) out.push(`    ${o}`);
      }
      out.push(line('Threshold', src.childThreshold ?? '(unknown)'));
      return out;
    }
    case 'reclaimChild':
      return [
        line('SubVault', src.childAddress ?? '(unknown)'),
        line('Amount', `${formatMina(src.reclaimAmount)} MINA`),
      ];
    case 'destroyChild':
      return [line('SubVault', src.childAddress ?? '(unknown)')];
    case 'enableChildMultiSig':
      return [
        line('SubVault', src.childAddress ?? '(unknown)'),
        line('Multi-sig', src.enableMultiSig ? 'enable' : 'disable'),
      ];
    default:
      return [line('Details', '(unrecognized action type)')];
  }
}

function renderHeader(
  bundle: OfflineBundle,
  rawTxType: string | null | undefined,
  extra: { nonce?: string | number | null; memo?: string | null; proposalHash?: string | null; expirySlot?: string | number | null },
): string[] {
  const out: string[] = [];
  out.push('');
  out.push('========================================================');
  out.push(`  ${bundle.action.toUpperCase()}:  ${actionLabel(rawTxType)}`);
  out.push('========================================================');
  if (bundle.minaNetwork === 'mainnet') {
    out.push('  *** MAINNET — REAL FUNDS AT STAKE ***');
  } else {
    out.push(line('Network', 'testnet'));
  }
  out.push(line('Contract', bundle.contractAddress));
  out.push(line('Fee payer', bundle.feePayerAddress));
  out.push(line('Fee', '0.1 MINA'));
  if (extra.nonce != null && extra.nonce !== '') out.push(line('Nonce', extra.nonce));
  out.push(line('Memo', extra.memo && extra.memo.length ? extra.memo : '(none)'));
  if (extra.proposalHash) out.push(line('Proposal hash', extra.proposalHash));
  if (extra.expirySlot != null && String(extra.expirySlot) !== '' && String(extra.expirySlot) !== '0') {
    out.push(line('Expiry slot', extra.expirySlot));
  }
  return out;
}

/**
 * Renders a human-readable description of what the bundle will sign. Pure and
 * defensive — never throws on malformed input, since this text is the operator's
 * last chance to catch a tampered bundle before signing.
 */
export function renderBundleSummary(bundle: OfflineBundle): string {
  let lines: string[] = [];
  try {
    if (bundle.action === 'propose') {
      const b = bundle as OfflineProposeBundle;
      const input = b.input;
      const txType = normalizeTxType(input.txType);
      lines = renderHeader(b, input.txType, {
        nonce: input.nonce,
        memo: input.memo ?? null,
        expirySlot: input.expirySlot ?? null,
      }).concat(
        renderBody(txType, {
          receivers: input.receivers,
          ownerTarget:
            input.txType === 'addOwner' ? input.newOwner ?? null
              : input.txType === 'removeOwner' ? input.removeOwnerAddress ?? null
              : null,
          threshold: input.newThreshold ?? null,
          delegate: input.delegate ?? null,
          undelegate: input.undelegate,
          childAddress: input.childAccount ?? null,
          childOwners: input.childOwners ?? null,
          childThreshold: input.childThreshold ?? null,
          reclaimAmount: input.reclaimAmount ?? null,
          enableMultiSig: input.childMultiSigEnable ?? null,
        }),
      );
    } else {
      // approve | execute — both read from bundle.proposal. For governance types
      // the target owner/delegate lives in the canonical receivers[0] slot (see
      // buildReceiversForProposal in build-tx.ts), NOT in named fields.
      const b = bundle as OfflineApproveBundle | OfflineExecuteBundle;
      const p = b.proposal;
      const txType = normalizeTxType(p.txType);
      const exec = bundle.action === 'execute' ? (bundle as OfflineExecuteBundle) : null;
      const target0 = realReceivers(p.receivers)[0]?.address ?? null;
      lines = renderHeader(b, p.txType, {
        nonce: p.nonce,
        memo: p.memo ?? null,
        proposalHash: p.proposalHash,
        expirySlot: p.expirySlot ?? null,
      }).concat(
        renderBody(txType, {
          receivers: p.receivers,
          ownerTarget: target0,
          threshold: p.data ?? null,
          delegate: target0,
          undelegate: false,
          childAddress: p.childAccount ?? exec?.childAddress ?? null,
          childOwners: exec?.childOwners ?? null,
          childThreshold: exec?.childThreshold ?? null,
          reclaimAmount: p.data ?? null,
          enableMultiSig: p.data === '1',
        }),
      );
    }
  } catch (err) {
    lines = [
      '',
      '  WARNING: could not fully render this bundle.',
      `  ${err instanceof Error ? err.message : String(err)}`,
      '  Inspect the bundle file manually before signing.',
    ];
  }
  lines.push('========================================================');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

type LogFn = (msg: string) => void;

/** Reads a single line from the controlling terminal (/dev/tty). */
function readLineFromTty(): string | null {
  let fd: number | null = null;
  try {
    fd = openSync('/dev/tty', 'rs');
    const buf = Buffer.alloc(1);
    let input = '';
    while (true) {
      const bytes = readSync(fd, buf, 0, 1, null);
      if (bytes === 0) break; // EOF
      const ch = buf.toString('utf-8', 0, 1);
      if (ch === '\n') break;
      if (ch === '\r') continue;
      input += ch;
    }
    return input;
  } catch {
    return null; // no controlling terminal (e.g. Windows / detached)
  } finally {
    if (fd != null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

/**
 * Prints the summary to stderr and, on a real terminal, requires explicit y/N
 * confirmation. Exits the process (code 1) if the user declines.
 *
 * Non-interactive policy: when no TTY is attached (piped/CI/scripts) or when the
 * caller passes assumeYes, the summary is shown and signing proceeds without a
 * prompt. Only an attached terminal blocks for confirmation.
 */
export function confirmOrExit(
  summary: string,
  opts: { assumeYes: boolean; stderrIsTty: boolean },
  log: LogFn,
): void {
  process.stderr.write(summary + '\n');

  if (opts.assumeYes) {
    log('Confirmation bypassed (--yes / MINA_GUARD_ASSUME_YES).');
    return;
  }
  if (!opts.stderrIsTty) {
    log('No terminal attached — proceeding without interactive confirmation.');
    return;
  }

  process.stderr.write('\nSign this transaction? [y/N]: ');
  const answer = readLineFromTty();
  if (answer == null) {
    // Could not open /dev/tty despite isTTY — fall back to auto-proceed rather
    // than deadlock, but make it visible.
    log('Could not read from terminal — proceeding without confirmation.');
    return;
  }
  const normalized = answer.trim().toLowerCase();
  if (normalized === 'y' || normalized === 'yes') {
    return;
  }
  process.stderr.write('Aborted. No transaction was signed.\n');
  process.exit(1);
}
