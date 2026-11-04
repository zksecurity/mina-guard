'use client';

import { useEffect, useRef, useState } from 'react';
import { OFFLINE_MAX_FEE_NANOMINA, OFFLINE_MIN_FEE_NANOMINA } from 'contracts/offline-format';
import type { OfflineSignedTxResponse } from '@/lib/offline-signing';
import { assertOfflineResponseVersion, signedOwnerFeeNanomina } from '@/lib/offline-format';
import { getMinaGuardConfig } from '@/lib/endpoints';
import { assessPreflightRetry } from '@/lib/multisigClient';
import { countNewRecipientSlotsFromSnapshot } from '@/lib/recipient-account-fee';
import { fetchProposal } from '@/lib/api';
import { formatMina } from '@/lib/types';
import { ALL_PLATFORMS, detectPlatform, getPlatformInfo, signCommand, type PlatformInfo } from '@/lib/offline-cli-command';
import { preflightBeforeSend, preflightFailureMessage, withStoreRecovery, PREFLIGHT_CANCELLED, PREFLIGHT_REBUILD } from '@/lib/preflight-flow';

// CLI binaries are published per release by the offline-cli-release workflow
// (binaries + SHA256SUMS + minaguard-vk-hash.txt). There is deliberately NO
// default URL: `releases/latest` resolves repo-wide, and this repo also
// publishes desktop releases — the moment one of those is newest, a `latest`
// URL stops carrying CLI assets (404) and can even split the binary and
// SHA256SUMS links across two releases. The right release is a
// per-deployment choice anyway: pin the one whose minaguard-vk-hash.txt
// matches the deployed contracts, e.g.
// NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL=https://github.com/zksecurity/mina-guard/releases/download/offline-cli-v0.1.0
// When unset, the download section shows setup guidance instead of a link.
const CLI_RELEASE_DOWNLOAD_BASE = process.env.NEXT_PUBLIC_OFFLINE_CLI_RELEASE_URL;

export async function broadcastSignedTx(txJson: string): Promise<string> {
  const query = `mutation($input: SendZkappInput!) { sendZkapp(input: $input) { zkapp { hash } } }`;
  const zkappCommand = JSON.parse(txJson);
  // Resolved at call time so the desktop shell's runtime endpoint override applies.
  const res = await fetch(getMinaGuardConfig().minaEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { input: { zkappCommand } } }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(json.errors.map((e: any) => e.message).join('; '));
  }
  const hash = json.data?.sendZkapp?.zkapp?.hash;
  if (!hash) throw new Error('sendZkapp returned no transaction hash');
  return hash;
}

function CliDownload({ platform, onSelect }: { platform: PlatformInfo; onSelect: (platform: PlatformInfo) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <p className="text-xs text-safe-text">
        Need the CLI?{' '}
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-safe-green hover:underline"
        >
          Download for macOS, Linux or Windows
          <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </p>
      {open && (
        <div className="space-y-3 rounded-lg border border-safe-border bg-safe-dark p-3 text-xs text-safe-text">
          <div className="space-y-2">
            {(['macOS', 'Linux', 'Windows'] as const).map((os) => (
              <div key={os} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-safe-text/60">{os}</span>
                <div className="flex flex-wrap gap-2">
                  {ALL_PLATFORMS.filter((p) => p.os === os).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onSelect(p)}
                      aria-pressed={platform.id === p.id}
                      className={`rounded border px-3 py-1 font-semibold transition-colors ${
                        platform.id === p.id
                          ? 'border-safe-green bg-safe-green/15 text-safe-green'
                          : 'border-safe-border text-safe-text hover:border-safe-green/50'
                      }`}
                    >
                      {p.arch}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {CLI_RELEASE_DOWNLOAD_BASE ? (
            <p>
              <a href={`${CLI_RELEASE_DOWNLOAD_BASE}/${platform.filename}`} className="font-semibold text-safe-green hover:underline">
                Download {platform.filename}
              </a>
              , then check it against{' '}
              <a href={`${CLI_RELEASE_DOWNLOAD_BASE}/SHA256SUMS`} className="underline hover:text-safe-text">SHA256SUMS</a>{' '}
              from the same release before moving it to the air-gapped machine.
            </p>
          ) : (
            <p>
              Download <code className="rounded bg-safe-gray px-1">{platform.filename}</code> from the{' '}
              <a href="https://github.com/zksecurity/mina-guard/releases" target="_blank" rel="noopener noreferrer" className="text-safe-green hover:underline">
                MinaGuard releases page
              </a>.
            </p>
          )}
          {platform.setup && (
            <div className="space-y-1">
              <p>Then make it executable:</p>
              <code className="block break-all rounded bg-safe-gray px-2 py-1.5 font-mono">{platform.setup}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function bundleFilename(action: string, bundle: any): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const addr = bundle?.contractAddress;
  const hash = bundle?.proposal?.proposalHash ?? bundle?.proposalHash;
  const id = hash ? hash.slice(0, 8) : addr ? addr.slice(0, 10) : '';
  return id ? `${action}-${id}-${ts}.json` : `${action}-${ts}.json`;
}

type OfflineAction = 'propose' | 'approve' | 'execute';

interface OfflineSigningFlowProps {
  action: OfflineAction;
  label: string;
  onBuildBundle: () => Promise<unknown>;
  onExported?: (filename: string, fee: number) => void;
}

function extractBundleWarnings(bundle: any): string[] {
  const warnings: string[] = [];

  const feePayerAccount = bundle?.accounts?.[bundle?.feePayerAddress];
  if (!feePayerAccount) {
    warnings.push('Fee payer address has no on-chain account. The transaction will fail.');
  } else {
    const balanceNano = Number(feePayerAccount.balance?.total ?? '0');
    const balanceMina = balanceNano / 1e9;
    if (balanceMina < 1) {
      warnings.push(`Fee payer balance is ${balanceMina.toFixed(2)} MINA — may be insufficient for transaction fees.`);
    }
  }

  if (bundle?.action === 'execute' && bundle?.proposal?.txType === 'transfer' && bundle.receiverAccountExists) {
    const newRecipientSlots = countNewRecipientSlotsFromSnapshot(
      bundle.proposal.receivers ?? [], bundle.receiverAccountExists,
    );
    if (newRecipientSlots > 0) {
      warnings.push(`${newRecipientSlots} recipient slot(s) appear to need account creation funding in this snapshot. The executor pays approximately ${newRecipientSlots} MINA for account creation, plus the transaction fee. Account status can change before broadcast.`);
    }
  }

  return warnings;
}

export function downloadOfflineBundle(action: OfflineAction, bundle: unknown): string {
  const filename = bundleFilename(action, bundle);
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return filename;
}

/** Builds and downloads one offline request, with its warnings and errors. */
export function OfflineSigningFlow({ action, label, onBuildBundle, onExported }: OfflineSigningFlowProps) {
  const [building, setBuilding] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const handleExport = async () => {
    setBuilding(true);
    setExportError(null);
    setWarnings([]);
    try {
      const bundle = await withStoreRecovery(onBuildBundle, true);
      setWarnings(extractBundleWarnings(bundle));
      const fee = (bundle as { fee?: unknown } | null)?.fee;
      if (typeof fee !== 'number' || !Number.isSafeInteger(fee) ||
          fee < OFFLINE_MIN_FEE_NANOMINA || fee > OFFLINE_MAX_FEE_NANOMINA) {
        throw new Error('The offline request has no valid fee. Nothing was exported.');
      }
      const filename = downloadOfflineBundle(action, bundle);
      onExported?.(filename, fee);
    } catch (err) {
      if (!(err instanceof Error && err.message === PREFLIGHT_CANCELLED)) {
        setExportError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={handleExport}
        disabled={building}
        className="px-4 py-2 rounded-lg text-sm font-semibold bg-safe-green text-safe-dark hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {building ? 'Building bundle...' : `Export ${label} Bundle`}
      </button>
      {warnings.length > 0 && (
        <div className="space-y-1">
          {warnings.map((w) => (
            <p key={w} className="text-xs text-amber-400">{w}</p>
          ))}
        </div>
      )}
      {exportError && (
        <p className="text-sm text-red-400">{exportError}</p>
      )}
    </div>
  );
}

type StepState = 'done' | 'current' | 'pending';

function StepMarker({ n, state }: { n: number; state: StepState }) {
  if (state === 'done') {
    return (
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-safe-green text-safe-dark" aria-label={`Step ${n} done`}>
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }
  return (
    <span className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs font-semibold ${
      state === 'current' ? 'border-safe-green text-safe-green' : 'border-safe-border text-safe-text'
    }`}>
      {n}
    </span>
  );
}

function Step({ n, state, title, last, children }: {
  n: number; state: StepState; title: string; last?: boolean; children: React.ReactNode;
}) {
  return (
    <section className={`grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 py-5 ${last ? '' : 'border-b border-safe-border'}`}>
      <StepMarker n={n} state={state} />
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {children}
      </div>
    </section>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the command stays selectable.
    }
  };
  return (
    <div className="relative rounded-lg border border-safe-border bg-safe-dark py-2.5 pl-3 pr-20">
      <code className="block break-all font-mono text-xs leading-relaxed text-safe-text select-all">{command}</code>
      <button
        type="button"
        onClick={copy}
        className="absolute right-2 top-2 rounded border border-safe-border px-2 py-0.5 text-xs text-safe-text hover:border-safe-green/50 hover:text-white"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export interface OfflinePanelAction {
  action: OfflineAction;
  label: string;
  onBuildBundle: () => Promise<unknown>;
}

interface OfflineSigningPanelProps {
  /** Actions the signer can export; the last one is selected first. */
  actions: OfflinePanelAction[];
  onExported?: (action: OfflineAction, filename: string, fee: number) => void;
  upload: Omit<UploadSignedResponseProps, 'onRecreate'> & {
    /** Downloads a fresh request for the same action; returns what it exported. */
    onRecreate?: (response: OfflineSignedTxResponse) => Promise<{ filename: string; fee: number }>;
  };
}

/** Export a request, sign it with the offline CLI, then upload the result. */
export function OfflineSigningPanel({ actions, onExported, upload }: OfflineSigningPanelProps) {
  const [selected, setSelected] = useState<OfflineAction | null>(null);
  const [exports, setExports] = useState<Partial<Record<OfflineAction, { filename: string; fee: number }>>>({});
  // Step 2 signs the most recent download, which a stale-response rebuild can
  // make an action other than the one selected.
  const [latest, setLatest] = useState<OfflineAction | null>(null);
  const [platform, setPlatform] = useState<PlatformInfo>(() => getPlatformInfo('macos-arm64'));
  const [broadcast, setBroadcast] = useState(false);
  useEffect(() => { setPlatform(detectPlatform()); }, []);

  const current = actions.find((a) => a.action === selected) ?? actions.at(-1);
  if (!current) return null;
  const exported = exports[current.action];
  const toSign = latest ? exports[latest] : undefined;
  let network = 'mainnet';
  try { network = getMinaGuardConfig().networkId; } catch { /* The page reports configuration errors. */ }

  const recordExport = (action: OfflineAction, filename: string, fee: number) => {
    setExports((prev) => ({ ...prev, [action]: { filename, fee } }));
    setSelected(action);
    setLatest(action);
    onExported?.(action, filename, fee);
  };

  return (
    <div className="rounded-xl border border-safe-border bg-safe-gray px-5">
      <Step n={1} state={exported ? 'done' : 'current'} title="Export the request">
        {actions.length > 1 && (
          <div className="inline-flex rounded-lg border border-safe-border bg-safe-dark p-0.5" role="group" aria-label="Action to sign">
            {actions.map((a) => (
              <button
                key={a.action}
                type="button"
                onClick={() => setSelected(a.action)}
                aria-pressed={a.action === current.action}
                className={`rounded-md px-4 py-1.5 text-sm transition-colors ${
                  a.action === current.action ? 'bg-safe-green/15 text-safe-green' : 'text-safe-text hover:text-white'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
        <OfflineSigningFlow
          key={current.action}
          action={current.action}
          label={current.label}
          onBuildBundle={current.onBuildBundle}
          onExported={(filename, fee) => recordExport(current.action, filename, fee)}
        />
        {exported && (
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-safe-text">
            <span>Saved <code className="font-mono text-white">{exported.filename}</code></span>
            <span>Fee <span className="text-white">{formatMina(String(exported.fee))} MINA</span>, check it matches in the CLI</span>
          </p>
        )}
      </Step>
      <Step n={2} state={toSign ? 'current' : 'pending'} title="Sign on the air-gapped machine">
        <CopyCommand command={signCommand(platform, network, toSign?.filename ?? `${current.action}-request.json`)} />
        <CliDownload platform={platform} onSelect={setPlatform} />
      </Step>
      <Step n={3} state={broadcast ? 'done' : 'pending'} title="Upload signed.json and broadcast" last>
        <UploadSignedResponse
          {...upload}
          onRecreate={upload.onRecreate && (async (response) => {
            const { filename, fee } = await upload.onRecreate!(response);
            recordExport(response.action, filename, fee);
          })}
          onComplete={(response, txHash, feePayer) => {
            setBroadcast(true);
            upload.onComplete?.(response, txHash, feePayer);
          }}
        />
      </Step>
    </div>
  );
}

interface UploadSignedResponseProps {
  acceptActions: Array<'propose' | 'approve' | 'execute'>;
  /** Fee from a request exported in this page session, when available. */
  expectedFees?: Partial<Record<'propose' | 'approve' | 'execute', number>>;
  /** When set, reject signed responses that target a different contract/vault. */
  expectedContractAddress?: string;
  /** When set, reject signed responses that target a different proposal hash. */
  expectedProposalHash?: string;
  /** Live, online policy check performed immediately before broadcasting. */
  beforeBroadcast?: (response: OfflineSignedTxResponse) => Promise<void>;
  onComplete?: (response: OfflineSignedTxResponse, txHash: string, feePayer: string) => void;
  /** Rebuild the same action after eligibility is refreshed, never a replacement proposal. */
  onRecreate?: (response: OfflineSignedTxResponse) => Promise<void>;
}

export function UploadSignedResponse({
  acceptActions,
  expectedFees,
  expectedContractAddress,
  expectedProposalHash,
  beforeBroadcast,
  onComplete,
  onRecreate,
}: UploadSignedResponseProps) {
  const [broadcasting, setBroadcasting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [recreated, setRecreated] = useState(false);
  const [pending, setPending] = useState<{
    response: OfflineSignedTxResponse;
    txJson: string;
    fee: number;
    feePayer: string;
    matchedExport: boolean;
    config: string;
  } | null>(null);
  const processingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    if (processingRef.current) return;
    processingRef.current = true;
    setRecreated(false);
    setBroadcasting(false);
    setError(null);
    setDone(false);
    setPending(null);
    try {
      const text = await file.text();

      let response: OfflineSignedTxResponse;
      try {
        response = JSON.parse(text);
      } catch {
        throw new Error('File is not valid JSON. Make sure you are uploading the signed output from the CLI, not the original bundle.');
      }

      if (!response || typeof response !== 'object') {
        throw new Error('File does not contain a JSON object.');
      }
      if (response.type !== 'offline-signed-tx') {
        if ('action' in response && 'version' in response && 'contractAddress' in response) {
          throw new Error('This looks like the unsigned bundle, not the signed output. Run the CLI first, then upload the file it produces (stdout → signed.json).');
        }
        throw new Error('Unrecognized file format. Expected the signed JSON output from the offline CLI.');
      }
      assertOfflineResponseVersion(response.version);
      if (!acceptActions.includes(response.action)) {
        throw new Error(`This is a signed "${response.action}" transaction, but this upload expects ${acceptActions.join(' or ')}.`);
      }
      if (!response.transaction) {
        throw new Error('Signed response is missing the transaction field. The CLI may have encountered an error during signing.');
      }

      // Bind the upload to the proposal/vault this page is showing, so a swapped
      // or tampered signed file for a different proposal/contract cannot be
      // broadcast here.
      if (expectedContractAddress && response.contractAddress !== expectedContractAddress) {
        throw new Error(
          `This signed transaction is for a different vault (${response.contractAddress}) ` +
          `than the one open here (${expectedContractAddress}). Not broadcasting.`,
        );
      }
      if (expectedProposalHash && response.proposalHash !== expectedProposalHash) {
        throw new Error(
          `This signed transaction is for a different proposal than the one shown. ` +
          `Expected proposal hash ${expectedProposalHash}, but the file is for ` +
          `${response.proposalHash}. Not broadcasting.`,
        );
      }

      const txJson = typeof response.transaction === 'string'
        ? response.transaction : JSON.stringify(response.transaction);
      let signedTransaction: any;
      try {
        signedTransaction = JSON.parse(txJson);
      } catch {
        throw new Error('Signed response contains an invalid transaction. Not broadcasting.');
      }
      const expectedFee = expectedFees?.[response.action];
      const fee = signedOwnerFeeNanomina(signedTransaction, expectedFee);
      const feePayer = signedTransaction?.feePayer?.body?.publicKey;
      if (typeof feePayer !== 'string' || !feePayer) {
        throw new Error('Signed transaction has no fee payer. Not broadcasting.');
      }
      setPending({ response, txJson, fee, feePayer, matchedExport: expectedFee !== undefined,
        config: JSON.stringify(getMinaGuardConfig()) });
    } catch (err) {
      if (!(err instanceof Error && err.message === PREFLIGHT_CANCELLED)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      processingRef.current = false;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const broadcastReviewed = async () => {
    if (!pending || processingRef.current) return;
    processingRef.current = true;
    const { response, txJson, feePayer } = pending;
    setPending(null);
    setError(null);
    try {
      if (JSON.stringify(getMinaGuardConfig()) !== pending.config) {
        throw new Error('Network changed since the signed file was uploaded. Upload it again on the intended network.');
      }
      signedOwnerFeeNanomina(JSON.parse(txJson), expectedFees?.[response.action]);
      const assess = async () => {
        if (response.action === 'propose') {
          return { status: 'review' as const, message: 'The original proposal request is needed to recreate this transaction. Review the proposal form and export a fresh request.' };
        }
        const proposal = await fetchProposal(response.contractAddress, response.proposalHash);
        if (!proposal) return { status: 'unknown' as const };
        return assessPreflightRetry({ action: response.action, address: response.contractAddress, proposal,
          actor: JSON.parse(txJson)?.feePayer?.body?.publicKey });
      };
      try {
        await preflightBeforeSend(txJson, assess, true, !!onRecreate, () => beforeBroadcast?.(response) ?? Promise.resolve());
      } catch (err) {
        if (err instanceof Error && err.message === PREFLIGHT_REBUILD && onRecreate) {
          const eligible = await assess();
          if (eligible.status !== 'eligible') throw new Error(eligible.message ?? 'This action is no longer verified as eligible. Nothing was exported.');
          await onRecreate(response);
          setRecreated(true);
          return;
        }
        throw err;
      }
      setBroadcasting(true);
      let txHash: string;
      try {
        txHash = await broadcastSignedTx(txJson);
      } catch (err) {
        const msg = preflightFailureMessage(err);
        if (msg.includes('Invalid_signature') || msg.includes('invalid signature')) {
          throw new Error('The Mina node rejected the transaction signature. This usually means the private key used on the air-gapped machine does not match the fee payer address.');
        }
        if (msg.includes('Invalid_proof') || msg.includes('invalid proof')) {
          throw new Error('The Mina node rejected the transaction proof. The contract verification key may have changed since the bundle was exported. Export a fresh bundle and try again.');
        }
        if (msg.includes('Insufficient_fee') || msg.includes('insufficient')) {
          throw new Error('The fee payer account does not have enough MINA to cover the transaction fee.');
        }
        throw new Error(`Broadcast failed: ${msg}`);
      }
      setDone(true);
      onComplete?.(response, txHash, feePayer);
    } catch (err) {
      if (!(err instanceof Error && err.message === PREFLIGHT_CANCELLED)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      processingRef.current = false;
      setBroadcasting(false);
    }
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  };

  return (
    <div className="space-y-3">
      <label
        className={`flex items-center justify-center text-center border-2 border-dashed rounded-lg px-4 py-4 text-sm cursor-pointer transition-colors ${
          dragging
            ? 'border-safe-green bg-safe-green/10 text-safe-green'
            : 'border-safe-border text-safe-text/60 hover:border-safe-green/50 hover:text-safe-text/80'
        }`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {dragging ? 'Drop signed response here' : 'Drop signed .json here or click to upload'}
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          onChange={handleUpload}
          className="hidden"
        />
      </label>
      {pending && (
        <div className="space-y-2 rounded-lg border border-amber-400 p-3 text-sm text-safe-text">
          <p className="font-semibold">Review the signed transaction before broadcast</p>
          <p>Action: {pending.response.action}. Fee payer: <code>{pending.feePayer}</code>.</p>
          <p>Signed transaction fee: {formatMina(String(pending.fee))} MINA.</p>
          {!pending.matchedExport && (
            <p className="text-amber-400">No request fee is available in this page session. Compare this fee with the exported request and offline CLI summary.</p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={broadcastReviewed} className="rounded bg-safe-green px-3 py-1.5 font-semibold text-safe-dark">Broadcast signed transaction</button>
            <button type="button" onClick={() => setPending(null)} className="rounded border border-safe-border px-3 py-1.5">Cancel</button>
          </div>
        </div>
      )}
      {broadcasting && (
        <p className="text-sm text-safe-text">Broadcasting transaction...</p>
      )}
      {recreated && <p className="text-sm text-safe-green">Fresh request downloaded. Sign it on your offline device, then upload the new signed file.</p>}
      {done && (
        <p className="text-sm text-safe-green">Transaction broadcast successfully.</p>
      )}
      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
