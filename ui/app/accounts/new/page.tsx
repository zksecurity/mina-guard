'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { MAX_OWNERS } from '@/lib/constants';
import { useAppContext } from '@/lib/app-context';
import {
  assertLedgerReady,
  computeCreateChildConfigHash,
  createOnchainProposal,
  deployAndSetupContract,
  generateKeypair,
} from '@/lib/multisigClient';
import { saveAccountName, savePendingSubaccount } from '@/lib/storage';
import { subscribeAddress } from '@/lib/api';
import { resolveIndexerMode } from '@/lib/indexer-mode';

const NETWORKS = [
  { label: 'Testnet', value: 'testnet', networkId: '0', enabled: true },
  { label: 'Devnet (coming soon)', value: 'devnet', networkId: '0', enabled: false },
  { label: 'Mainnet (coming soon)', value: 'mainnet', networkId: '1', enabled: false },
] as const;

export default function CreateAccountWizardPage() {
  return (
    <Suspense>
      <CreateAccountWizard />
    </Suspense>
  );
}

/** Stepped wizard for creating a new MinaGuard account, optionally as a subaccount. */
function CreateAccountWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const parentAddress = searchParams?.get('parent') ?? null;
  const isSubaccount = !!parentAddress;
  const {
    wallet,
    contracts,
    indexerStatus,
    startOperation,
    isOperating,
  } = useAppContext();

  const parentContract = useMemo(
    () => (parentAddress ? contracts.find((c) => c.address === parentAddress) ?? null : null),
    [contracts, parentAddress],
  );

  const [step, setStep] = useState<1 | 2>(1);

  // Step 1 fields
  const [name, setName] = useState('');
  const [networkValue, setNetworkValue] = useState<typeof NETWORKS[number]['value']>('testnet');
  const network = NETWORKS.find((n) => n.value === networkValue) ?? NETWORKS[0];

  // For subaccounts: lock network to the parent's networkId.
  useEffect(() => {
    if (!isSubaccount || !parentContract?.networkId) return;
    const match = NETWORKS.find((n) => n.networkId === parentContract.networkId);
    if (match) setNetworkValue(match.value);
  }, [isSubaccount, parentContract?.networkId]);

  // Step 2 fields
  const [keypair, setKeypair] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [ownerFields, setOwnerFields] = useState<string[]>(['']);
  const [threshold, setThreshold] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const kp = await generateKeypair();
      setKeypair(kp);
    } finally {
      setGenerating(false);
    }
  }, []);

  useEffect(() => {
    if (wallet.connected && !keypair && !generating && step === 2) {
      void generate();
    }
  }, [wallet.connected, keypair, generating, step, generate]);

  useEffect(() => {
    if (wallet.address) setOwnerFields((prev) => (prev[0] ? prev : [wallet.address!]));
  }, [wallet.address]);

  const parsedOwners = useMemo(
    () => ownerFields.map((s) => s.trim()).filter(Boolean),
    [ownerFields],
  );

  const validateStep2 = (): string | null => {
    if (parsedOwners.length === 0) return 'Add at least one owner address.';
    const invalid = parsedOwners.find((addr) => !addr.startsWith('B62') || addr.length < 50);
    if (invalid) return `Invalid address: ${invalid.slice(0, 20)}...`;
    const unique = new Set(parsedOwners);
    if (unique.size !== parsedOwners.length) return 'Duplicate owner addresses.';
    if (parsedOwners.length > MAX_OWNERS) return `Maximum ${MAX_OWNERS} owners allowed.`;
    const t = Number(threshold);
    if (!threshold.trim()) return 'Please choose a threshold.';
    if (!t || t < 1) return 'Threshold must be at least 1.';
    if (t > parsedOwners.length) return `Threshold (${t}) cannot exceed owners (${parsedOwners.length}).`;
    return null;
  };

  const handleDeploy = async () => {
    const error = validateStep2();
    if (error) { setFormError(error); return; }
    if (!wallet.address || !keypair) return;

    setFormError(null);
    const captured = {
      feePayerAddress: wallet.address,
      zkAppPrivateKeyBase58: keypair.privateKey,
      owners: parsedOwners,
      threshold: Number(threshold),
      networkId: network.networkId,
    };
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;
    try {
      await assertLedgerReady(signer);
    } catch (err) {
      void startOperation('Create account', async () => { throw err; });
      return;
    }
    if (name.trim()) saveAccountName(keypair.publicKey, name);
    void startOperation('Building deploy transaction...', async (onProgress) => {
      const result = await deployAndSetupContract(captured, onProgress, signer);
      if (result && resolveIndexerMode(indexerStatus) === 'lite') {
        onProgress('Subscribing indexer…');
        await subscribeAddress(keypair.publicKey);
      }
      return result;
    });
    router.push(`/accounts/${keypair.publicKey}?pending=1`);
  };

  /** Submits a CREATE_CHILD proposal on the parent and stashes deployment state for finalization. */
  const handleProposeSubaccount = async () => {
    const error = validateStep2();
    if (error) { setFormError(error); return; }
    if (!wallet.address || !parentAddress || !parentContract || !keypair) return;
    if (parentContract.configNonce == null || !parentContract.networkId) {
      setFormError('Parent contract not fully indexed yet — try again in a moment.');
      return;
    }

    setFormError(null);
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;
    try {
      await assertLedgerReady(signer);
    } catch (err) {
      void startOperation('Propose subaccount', async () => { throw err; });
      return;
    }

    const childThreshold = Number(threshold);
    const childPrivateKey = keypair.privateKey;
    const childAddress = keypair.publicKey;

    void startOperation('Preparing subaccount proposal…', async (onProgress) => {
      onProgress('Computing child config hash…');
      const { configHash } = await computeCreateChildConfigHash({
        childOwners: parsedOwners,
        childThreshold,
      });

      const proposalHash = await createOnchainProposal({
        contractAddress: parentAddress,
        proposerAddress: wallet.address!,
        configNonce: parentContract.configNonce!,
        networkId: parentContract.networkId!,
        input: {
          txType: 'createChild',
          childAccount: childAddress,
          createChildConfigHash: configHash,
        },
      }, onProgress, signer);

      if (!proposalHash) return null;

      if (name.trim()) saveAccountName(childAddress, name);

      savePendingSubaccount({
        parentAddress,
        childAddress,
        childPrivateKey,
        childOwners: parsedOwners,
        childThreshold,
        childName: name.trim(),
        proposalHash,
        expiryBlock: null,
        createdAt: new Date().toISOString(),
      });

      return `Subaccount proposal submitted. Approve on the parent, then return to finalize deployment.`;
    });

    router.push(`/accounts/${parentAddress}`);
  };

  return (
    <div>
      <div className="p-6 max-w-3xl mx-auto w-full">
        {!wallet.connected ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect a wallet to create an account.</p>
          </div>
        ) : (
          <div>
            <h1 className="text-2xl font-bold mb-2">
              {isSubaccount ? 'Create subaccount' : 'Create new account'}
            </h1>
            {isSubaccount && parentAddress && (
              <p className="text-xs text-safe-text mb-6">
                Subaccount of{' '}
                <Link
                  href={`/accounts/${parentAddress}`}
                  className="text-safe-green hover:underline font-mono"
                >
                  {parentAddress.slice(0, 8)}…{parentAddress.slice(-6)}
                </Link>
                . Parent owners must approve before deployment finalizes.
              </p>
            )}
            {!isSubaccount && <div className="mb-6" />}

            <div className="bg-safe-gray border border-safe-border rounded-xl">
              <div className="flex h-1 bg-safe-border rounded-t-xl overflow-hidden">
                <div className={`flex-1 ${step >= 1 ? 'bg-safe-green' : ''}`} />
                <div className={`flex-1 ${step >= 2 ? 'bg-safe-green' : ''}`} />
              </div>

              <div className="p-6 space-y-5">
                <div className="flex items-center gap-3">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                    step === 1 ? 'bg-safe-green text-safe-dark' : 'bg-safe-dark border border-safe-border text-safe-text'
                  }`}>
                    {step === 1 ? '1' : <CheckIcon />}
                  </div>
                  <div>
                    <h2 className="text-base font-semibold">
                      {step === 1 ? 'Choose name and network' : 'Configure owners and threshold'}
                    </h2>
                    <p className="text-xs text-safe-text">
                      {step === 1
                        ? 'Give the account a local nickname and pick the network to deploy to.'
                        : 'Add signer addresses and the minimum approvals needed to execute a proposal.'}
                    </p>
                  </div>
                </div>

                {step === 1 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-3">
                    <label className="space-y-1">
                      <span className="text-xs text-safe-text flex items-center gap-1 h-5">
                        Name (optional)
                        <span className="relative group">
                          <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-safe-border text-[10px] leading-none text-safe-text cursor-help">?</span>
                          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 transition-all duration-200 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0">
                            <div className="bg-safe-green/70 backdrop-blur-md text-white text-xs font-semibold rounded-lg px-2.5 py-1 shadow-lg whitespace-nowrap">
                              Stored locally in your browser. Only you see it on this device.
                            </div>
                            <svg className="mx-auto -mt-px" width="10" height="6" viewBox="0 0 10 6">
                              <path d="M0 0L5 6L10 0Z" className="fill-safe-green/70" />
                            </svg>
                          </div>
                        </span>
                      </span>
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="My MinaGuard Account"
                        className="w-full bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-safe-green"
                      />
                    </label>
                    <label className="space-y-1">
                      <span className="text-xs text-safe-text flex items-center h-5">Network</span>
                      <select
                        value={networkValue}
                        onChange={(e) => setNetworkValue(e.target.value as typeof networkValue)}
                        disabled={isSubaccount}
                        className="w-full bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-safe-green disabled:opacity-60"
                        title={
                          isSubaccount
                            ? 'Subaccounts inherit the parent network.'
                            : 'Devnet and Mainnet support is coming soon.'
                        }
                      >
                        {NETWORKS.map((n) => (
                          <option key={n.value} value={n.value} disabled={!n.enabled}>
                            {n.label}
                          </option>
                        ))}
                      </select>
                      <span className="text-[10px] text-safe-text">
                        {isSubaccount
                          ? 'Locked to the parent account network.'
                          : 'Only Testnet is available right now.'}
                      </span>
                    </label>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Contract address */}
                    {generating ? (
                      <div className="flex items-center gap-2 py-3">
                        <span className="animate-spin w-4 h-4 border-2 border-safe-green border-t-transparent rounded-full" />
                        <span className="text-sm text-safe-text">Generating keypair...</span>
                      </div>
                    ) : keypair ? (
                      <div className="space-y-1">
                        <p className="text-xs text-safe-text">Contract Address</p>
                        <p className="text-sm font-mono break-all bg-safe-dark border border-safe-border rounded-lg px-3 py-2">
                          {keypair.publicKey}
                        </p>
                        <button onClick={generate} className="text-xs text-safe-green hover:underline">
                          Regenerate
                        </button>
                      </div>
                    ) : null}

                    {/* Owners */}
                    <div className="space-y-2">
                      <span className="text-xs text-safe-text">Owners</span>
                      {ownerFields.map((value, i) => (
                        <div key={i} className="flex gap-2">
                          <input
                            type="text"
                            value={value}
                            onChange={(e) => {
                              const next = [...ownerFields];
                              next[i] = e.target.value;
                              setOwnerFields(next);
                              setFormError(null);
                            }}
                            placeholder={`Owner ${i + 1} address (B62...)`}
                            className="flex-1 bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm font-mono focus:outline-none focus:border-safe-green"
                          />
                          {ownerFields.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setOwnerFields(ownerFields.filter((_, j) => j !== i))}
                              className="text-safe-text hover:text-red-400 px-2 text-lg leading-none"
                            >
                              &times;
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setOwnerFields([...ownerFields, ''])}
                        disabled={ownerFields.length >= MAX_OWNERS}
                        className="text-xs text-safe-green hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                      >
                        + Add owner
                      </button>
                    </div>

                    {/* Threshold */}
                    <label className="space-y-1 block">
                      <span className="text-xs text-safe-text">Threshold</span>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={Math.max(1, parsedOwners.length)}
                          value={threshold}
                          onChange={(e) => { setThreshold(e.target.value); setFormError(null); }}
                          className="w-20 bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:border-safe-green"
                        />
                        <span className="text-sm text-safe-text">out of {parsedOwners.length}</span>
                      </div>
                    </label>

                    {formError && <p className="text-sm text-red-400">{formError}</p>}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between px-6 py-4 border-t border-safe-border">
                {step === 1 ? (
                  <Link
                    href="/"
                    className="flex items-center gap-2 border border-safe-border rounded-lg px-4 py-2 text-sm text-safe-text hover:bg-safe-hover transition-colors"
                  >
                    <ArrowLeft /> Back
                  </Link>
                ) : (
                  <button
                    onClick={() => setStep(1)}
                    className="flex items-center gap-2 border border-safe-border rounded-lg px-4 py-2 text-sm text-safe-text hover:bg-safe-hover transition-colors"
                  >
                    <ArrowLeft /> Back
                  </button>
                )}

                {step === 1 ? (
                  <button
                    onClick={() => setStep(2)}
                    className="bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2 text-sm hover:brightness-110 transition-all"
                  >
                    Next
                  </button>
                ) : isSubaccount ? (
                  <button
                    disabled={isOperating || !parentContract}
                    onClick={handleProposeSubaccount}
                    className="bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2 text-sm hover:brightness-110 transition-all disabled:opacity-60"
                    title={!parentContract ? 'Loading parent contract…' : undefined}
                  >
                    {isOperating ? 'Proposing…' : 'Propose subaccount'}
                  </button>
                ) : (
                  <button
                    disabled={!keypair || isOperating}
                    onClick={handleDeploy}
                    className="bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2 text-sm hover:brightness-110 transition-all disabled:opacity-60"
                  >
                    {isOperating ? 'Deploying…' : 'Deploy account'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ArrowLeft() {
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
    </svg>
  );
}
