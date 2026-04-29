'use client';

import { useRef, useState } from 'react';
import type { OfflineSignedTxResponse } from '@/lib/offline-signing';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
const MINA_ENDPOINT = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? 'http://127.0.0.1:8080/graphql';

async function broadcastSignedTx(txJson: string): Promise<string> {
  const query = `mutation($input: SendZkappInput!) { sendZkapp(input: $input) { zkapp { hash } } }`;
  const zkappCommand = JSON.parse(txJson);
  const res = await fetch(MINA_ENDPOINT, {
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

interface PlatformInfo {
  id: string;
  label: string;
  filename: string;
  setupSteps: string[];
  runCmd: string;
}

function getPlatformInfo(p: string): PlatformInfo {
  const filename = `mina-guard-cli-${p}`;
  if (p.startsWith('macos')) {
    const arch = p.includes('arm64') ? 'Apple Silicon' : 'Intel';
    return {
      id: p, label: `macOS (${arch})`, filename,
      setupSteps: [
        `xattr -d com.apple.quarantine ${filename}`,
        `chmod +x ${filename}`,
      ],
      runCmd: `MINA_PRIVATE_KEY=EK... ./${filename} bundle.json > signed.json`,
    };
  }
  if (p.startsWith('linux')) {
    const arch = p.includes('arm64') ? 'ARM64' : 'x64';
    return {
      id: p, label: `Linux (${arch})`, filename,
      setupSteps: [`chmod +x ${filename}`],
      runCmd: `MINA_PRIVATE_KEY=EK... ./${filename} bundle.json > signed.json`,
    };
  }
  return {
    id: p, label: 'Windows (x64)', filename,
    setupSteps: [],
    runCmd: `set MINA_PRIVATE_KEY=EK... && ${filename} bundle.json > signed.json`,
  };
}

const ALL_PLATFORMS: PlatformInfo[] = [
  getPlatformInfo('macos-arm64'),
  getPlatformInfo('macos-x64'),
  getPlatformInfo('linux-x64'),
  getPlatformInfo('linux-arm64'),
  getPlatformInfo('windows-x64'),
];

export function DownloadCLILink() {
  const [selected, setSelected] = useState<PlatformInfo | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <div className="border border-safe-border rounded-lg p-4 space-y-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm font-semibold text-safe-green hover:underline"
      >
        Instructions
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="space-y-3 text-sm text-safe-text">
          <p className="font-semibold">1. Choose your platform {!selected && <span className="font-normal text-safe-text/50">— select one to see setup steps</span>}</p>
          <div className="space-y-2">
            {(['macOS', 'Linux', 'Windows'] as const).map((os) => {
              const group = ALL_PLATFORMS.filter((p) => p.label.startsWith(os));
              if (group.length === 0) return null;
              return (
                <div key={os} className="flex items-center gap-2">
                  <span className="text-xs text-safe-text/50 w-14 shrink-0">{os}</span>
                  <div className="flex flex-wrap gap-2">
                    {group.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSelected(p)}
                        className={`px-3 py-1.5 rounded border text-xs font-semibold transition-colors ${
                          selected?.id === p.id
                            ? 'bg-safe-green text-safe-dark border-safe-green'
                            : 'border-safe-green text-safe-green hover:bg-safe-green/10'
                        }`}
                      >
                        {p.label.replace(`${os} `, '').replace(/[()]/g, '')}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {selected && (
            <>
              <p className="font-semibold">2. Download the CLI</p>
              <a
                href={`${API_BASE}/api/offline-cli/${selected.id}`}
                download
                className="inline-block px-4 py-2 rounded-lg border border-safe-green text-safe-green text-xs font-semibold hover:bg-safe-green/10 transition-colors"
              >
                Download {selected.filename}
              </a>

              {selected.setupSteps.length > 0 && (
                <>
                  <p className="font-semibold">3. Make it executable</p>
                  <div className="space-y-1">
                    {selected.setupSteps.map((cmd) => (
                      <code key={cmd} className="block text-xs bg-safe-dark px-2 py-1.5 rounded">{cmd}</code>
                    ))}
                  </div>
                </>
              )}

              <p className="font-semibold">{selected.setupSteps.length > 0 ? '4' : '3'}. Export the bundle below and transfer it to the air-gapped machine</p>
              <p className="text-xs text-safe-text/50">The downloaded file will be named <code className="bg-safe-dark px-1 rounded">{'<action>-<id>-<timestamp>.json'}</code> where id is the first 8 characters of the proposal hash (approve/execute) or contract address (propose)</p>

              <p className="font-semibold">{selected.setupSteps.length > 0 ? '5' : '4'}. Sign on the air-gapped machine</p>
              <code className="block text-xs bg-safe-dark px-2 py-1.5 rounded">
                {selected.runCmd}
              </code>

              <p className="font-semibold">{selected.setupSteps.length > 0 ? '6' : '5'}. Transfer <code className="text-xs bg-safe-dark px-1 rounded">signed.json</code> back and upload it below</p>
            </>
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

interface OfflineSigningFlowProps {
  action: 'propose' | 'approve' | 'execute';
  label: string;
  onBuildBundle: () => Promise<unknown>;
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

  if (bundle?.action === 'execute' && bundle.receiverAccountExists) {
    const newAccounts = Object.entries(bundle.receiverAccountExists)
      .filter(([, exists]) => !exists)
      .map(([addr]) => addr);
    if (newAccounts.length > 0) {
      warnings.push(`${newAccounts.length} receiver(s) don't have on-chain accounts. Fee payer needs an extra ${newAccounts.length} MINA for account creation.`);
    }
  }

  return warnings;
}

export function OfflineSigningFlow({ action, label, onBuildBundle }: OfflineSigningFlowProps) {
  const [building, setBuilding] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [exportedFilename, setExportedFilename] = useState<string | null>(null);

  const handleExport = async () => {
    setBuilding(true);
    setExportError(null);
    setWarnings([]);
    setExportedFilename(null);
    try {
      const bundle = await onBuildBundle();
      setWarnings(extractBundleWarnings(bundle));
      const filename = bundleFilename(action, bundle);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      setExportedFilename(filename);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
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
      {exportedFilename && (
        <p className="text-xs text-safe-text/60">
          Exported <code className="bg-safe-dark px-1.5 py-0.5 rounded text-safe-text/80">{exportedFilename}</code>
        </p>
      )}
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

interface UploadSignedResponseProps {
  action: 'propose' | 'approve' | 'execute';
  onComplete?: (response: OfflineSignedTxResponse, txHash: string) => void;
}

export function UploadSignedResponse({ action, onComplete }: UploadSignedResponseProps) {
  const [broadcasting, setBroadcasting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = async (file: File) => {
    setBroadcasting(false);
    setError(null);
    setDone(false);
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
      if (response.version !== 1) {
        throw new Error(`Unsupported signed response version (${response.version}). You may need a newer version of the UI.`);
      }
      if (response.action !== action) {
        throw new Error(`This is a signed "${response.action}" transaction, but this upload expects "${action}".`);
      }
      if (!response.transaction) {
        throw new Error('Signed response is missing the transaction field. The CLI may have encountered an error during signing.');
      }

      setBroadcasting(true);
      const txJson = typeof response.transaction === 'string'
        ? response.transaction : JSON.stringify(response.transaction);
      let txHash: string;
      try {
        txHash = await broadcastSignedTx(txJson);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
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
      onComplete?.(response, txHash);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBroadcasting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
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
        className={`flex items-center justify-center border-2 border-dashed rounded-lg px-4 py-4 text-sm cursor-pointer transition-colors ${
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
      {broadcasting && (
        <p className="text-sm text-safe-text">Broadcasting transaction...</p>
      )}
      {done && (
        <p className="text-sm text-safe-green">Transaction broadcast successfully.</p>
      )}
      {error && (
        <p className="text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
