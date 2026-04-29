'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import ProposalForm from '@/components/ProposalForm';
import {
  CHILD_TX_TYPES,
  LOCAL_TX_TYPES,
  type ContractSummary,
  type NewProposalInput,
  type TxType,
} from '@/lib/types';
import TxTypeIcon from '@/components/TxTypeIcon';
import { createOnchainProposal } from '@/lib/multisigClient';
import { assertValidMinaAddress, buildOfflineProposeBundle } from '@/lib/offline-signing';
import { fetchChildren, fetchContract } from '@/lib/api';
import { useContractTxLock } from '@/hooks/useContractTxLock';
import { savePendingTx } from '@/lib/storage';
import { DownloadCLILink, OfflineSigningFlow, UploadSignedResponse } from '@/components/OfflineSigningFlow';

export default function NewTransactionPage() {
  return (
    <Suspense>
      <NewTransactionPageInner />
    </Suspense>
  );
}

function NewTransactionPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const {
    wallet,
    multisig,
    owners,
    proposals,
    isOperating,
    startOperation,
  } = useAppContext();

  const isRoot = !!multisig && !multisig.parent;
  const contractLock = useContractTxLock(multisig?.address ?? null, proposals);

  // Available tx types: LOCAL on every guard; subaccount actions only on roots.
  // CREATE_CHILD is shown on roots so the action is discoverable here, but it
  // routes to the dedicated wizard at /accounts/new (see handleTxTypeSelect)
  // because it needs to generate a child keypair and stash localStorage state
  // that the generic ProposalForm can't produce.
  const availableTypes = useMemo(
    () => (isRoot ? [...LOCAL_TX_TYPES, ...CHILD_TX_TYPES] : LOCAL_TX_TYPES),
    [isRoot],
  );

  const deleteMode = searchParams.get('mode') === 'delete';
  const deleteTargetHash = searchParams.get('targetProposalHash');
  const deleteTargetNonce = searchParams.get('targetNonce');
  const deleteTargetProposal = useMemo(
    () =>
      deleteMode && deleteTargetHash
        ? proposals.find((p) => p.proposalHash === deleteTargetHash) ?? null
        : null,
    [deleteMode, deleteTargetHash, proposals],
  );
  const rawType = searchParams.get('type');
  // CREATE_CHILD is wizard-only — bounce back to /accounts/new.
  useEffect(() => {
    if (!deleteMode && rawType === 'createChild' && multisig) {
      router.replace(`/accounts/new?parent=${multisig.address}`);
    }
  }, [rawType, multisig, router, deleteMode]);

  // Route the CREATE_CHILD chip to the wizard instead of selecting it as the
  // active form txType (the form can't drive that flow). Other types behave
  // like normal — they just toggle the picker.
  const handleTxTypeSelect = useCallback((value: TxType) => {
    if (value === 'createChild' && multisig) {
      router.push(`/accounts/new?parent=${multisig.address}`);
      return;
    }
    setTxType(value);
  }, [multisig, router]);

  // In delete mode the form recomputes effectiveTxType from the target's
  // destination (LOCAL→transfer / REMOTE→reclaimChild), but we still seed a
  // coherent txType so non-form consumers see the shape they'll end up
  // submitting.
  const initialType: TxType = deleteMode
    ? (deleteTargetProposal?.destination === 'remote' ? 'reclaimChild' : 'transfer')
    : availableTypes.some((t) => t.value === rawType)
      ? (rawType as TxType)
      : 'transfer';
  const [txType, setTxType] = useState<TxType>(initialType);
  const [currentNonce, setCurrentNonce] = useState<number | null>(multisig?.nonce ?? null);

  // Delete-mode pins the form's nonce to the target proposal's nonce; the
  // form derives its own default nonce in every other case based on the
  // active txType's nonce space (LOCAL vs REMOTE).
  const initialNonce = deleteMode
    ? (() => {
        const parsed = Number(deleteTargetNonce ?? '');
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
      })()
    : null;

  useEffect(() => {
    setTxType(initialType);
  }, [initialType]);

  useEffect(() => {
    if (!multisig?.address) {
      setCurrentNonce(null);
      return;
    }

    let cancelled = false;
    setCurrentNonce(multisig.nonce ?? null);

    void (async () => {
      const fresh = await fetchContract(multisig.address);
      if (cancelled || !fresh) return;
      setCurrentNonce(fresh.nonce ?? null);
    })();

    return () => {
      cancelled = true;
    };
  }, [multisig?.address, multisig?.nonce]);

  const handleExitDeleteMode = () => {
    router.replace('/transactions/new?type=transfer');
  };

  const [mode, setMode] = useState<'online' | 'offline'>('online');
  const [offlineFeePayerAddress, setOfflineFeePayerAddress] = useState('');
  const getFormInputRef = useRef<(() => NewProposalInput) | null>(null);

  // Children are needed by the form for child-target pickers and allocate hints.
  const [children, setChildren] = useState<ContractSummary[]>([]);
  useEffect(() => {
    if (!multisig?.address || !isRoot) {
      setChildren([]);
      return;
    }
    let cancelled = false;
    fetchChildren(multisig.address).then((list) => {
      if (!cancelled) setChildren(list);
    });
    return () => {
      cancelled = true;
    };
  }, [multisig?.address, isRoot]);

  const handleSubmit = async (data: NewProposalInput) => {
    if (!wallet.address || !multisig) return;

    const contractAddress = multisig.address;
    const proposerAddress = wallet.address;
    const networkId = multisig.networkId ?? '0';
    const fallbackConfigNonce = multisig.configNonce ?? 0;
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;

    let createdHash: string | null = null;
    await startOperation('Submitting proposal on-chain...', async (onProgress) => {
      const fresh = await fetchContract(contractAddress);
      const configNonce = fresh?.configNonce ?? fallbackConfigNonce;
      const result = await createOnchainProposal({
        contractAddress,
        proposerAddress,
        input: data,
        configNonce,
        networkId,
      }, onProgress, signer);
      if (!result) return null;
      createdHash = result.proposalHash;

      const isRemote =
        data.txType === 'createChild' ||
        data.txType === 'reclaimChild' ||
        data.txType === 'destroyChild' ||
        data.txType === 'enableChildMultiSig';
      savePendingTx({
        kind: 'create',
        contractAddress,
        proposalHash: result.proposalHash,
        txHash: result.txHash,
        signerPubkey: proposerAddress,
        createdAt: new Date().toISOString(),
        summary: {
          txType: data.txType,
          nonce: String(data.nonce),
          configNonce: String(configNonce),
          expiryBlock: data.expiryBlock != null ? String(data.expiryBlock) : null,
          destination: isRemote ? 'remote' : 'local',
          childAccount: data.childAccount ?? null,
          receivers: data.receivers ?? [],
        },
      });

      return `Proposal created: ${result.proposalHash}`;
    });
    router.push(createdHash ? `/transactions/${createdHash}` : '/transactions');
  };

  return (
    <div>
      <div className="p-6 max-w-2xl">
        <button
          type="button"
          onClick={() => router.back()}
          className="flex items-center gap-1.5 text-sm text-safe-text/60 hover:text-safe-text mb-4 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back
        </button>
        {!wallet.connected || !multisig ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect your wallet and select a contract to create proposals.</p>
          </div>
        ) : multisig.ownersCommitment == null ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Contract not initialized. Run Setup first before creating proposals.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {!deleteMode && (
              <TxTypePicker
                localTypes={availableTypes.filter((t) => LOCAL_TX_TYPES.some((l) => l.value === t.value))}
                childTypes={availableTypes.filter((t) => CHILD_TX_TYPES.some((c) => c.value === t.value))}
                selected={txType}
                onSelect={handleTxTypeSelect}
              />
            )}

            <div className="bg-safe-gray border border-safe-border rounded-xl overflow-hidden">
              {!deleteMode && (
                <div className="flex border-b border-safe-border">
                  <button
                    type="button"
                    onClick={() => setMode('online')}
                    className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors ${
                      mode === 'online'
                        ? 'text-safe-green border-b-2 border-safe-green'
                        : 'text-safe-text/60 hover:text-safe-text'
                    }`}
                  >
                    Online
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('offline')}
                    className={`flex-1 px-4 py-3 text-sm font-semibold transition-colors ${
                      mode === 'offline'
                        ? 'text-safe-green border-b-2 border-safe-green'
                        : 'text-safe-text/60 hover:text-safe-text'
                    }`}
                  >
                    Offline
                  </button>
                </div>
              )}

              <div className="p-6 space-y-4">
                {!deleteMode && (
                  <p className="text-xs text-safe-text/60">
                    {mode === 'online'
                      ? 'Sign and broadcast directly from your browser wallet or Ledger.'
                      : 'Export a bundle, sign on an air-gapped machine, then upload the signed transaction to broadcast.'}
                  </p>
                )}
                {contractLock.locked && (
                  <div className="rounded-lg px-4 py-3 text-xs bg-amber-500/10 text-amber-200 border border-amber-400/30">
                    {contractLock.reason} New submissions on this contract are blocked until it lands (~3 min).
                  </div>
                )}
                {proposals.some(
                  (p) =>
                    p.status === 'pending' &&
                    p.txType &&
                    ['addOwner', 'removeOwner', 'changeThreshold', 'setDelegate'].includes(p.txType)
                ) && (
                  <div className="rounded-lg px-4 py-3 text-xs bg-yellow-400/10 text-yellow-400 border border-yellow-400/30">
                    There are pending governance proposals. If one executes before this proposal, the config nonce will change and this proposal will be invalidated.
                  </div>
                )}

                {mode === 'offline' && !deleteMode && (
                  <>
                    <div className="space-y-2">
                      <label className="text-sm text-safe-text font-medium">Signer Address (Fee Payer)</label>
                      <input
                        type="text"
                        value={offlineFeePayerAddress}
                        onChange={(e) => setOfflineFeePayerAddress(e.target.value)}
                        placeholder="B62q..."
                        className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
                      />
                      <p className="text-xs text-amber-400">This must be the public key corresponding to the MINA_PRIVATE_KEY used on the air-gapped machine.</p>
                    </div>
                    <DownloadCLILink />
                  </>
                )}

                <ProposalForm
                  owners={owners.map((owner) => owner.address)}
                  currentThreshold={multisig.threshold ?? 1}
                  numOwners={multisig.numOwners ?? owners.length}
                  onSubmit={handleSubmit}
                  isSubmitting={isOperating}
                  submitDisabledReason={contractLock.locked ? contractLock.reason : null}
                  txType={txType}
                  children={children}
                  initialNonce={initialNonce}
                  currentNonce={currentNonce}
                  proposals={proposals}
                  nonceResetKey={`${multisig.address}:${deleteMode ? deleteTargetHash ?? 'delete' : 'normal'}`}
                  deleteMode={deleteMode}
                  deleteTargetHash={deleteTargetHash}
                  deleteTargetProposal={deleteTargetProposal}
                  onExitDeleteMode={handleExitDeleteMode}
                  getFormInputRef={mode === 'offline' ? getFormInputRef : undefined}
                  hideSubmit={mode === 'offline' && !deleteMode}
                />

                {mode === 'offline' && !deleteMode && (
                  <>
                    <OfflineSigningFlow
                      action="propose"
                      label="Propose"
                      onBuildBundle={async () => {
                        assertValidMinaAddress(offlineFeePayerAddress);
                        if (!owners.some((o) => o.address === offlineFeePayerAddress)) {
                          throw new Error('Signer address is not an owner of this multisig');
                        }
                        const input = getFormInputRef.current!();
                        const fresh = await fetchContract(multisig!.address);
                        const configNonce = fresh?.configNonce ?? multisig!.configNonce ?? 0;
                        const networkId = multisig!.networkId ?? '0';
                        return buildOfflineProposeBundle({
                          contractAddress: multisig!.address,
                          feePayerAddress: offlineFeePayerAddress,
                          input,
                          configNonce,
                          networkId,
                        });
                      }}
                    />
                    <UploadSignedResponse
                      action="propose"
                      onComplete={(response, txHash) => {
                        const hash = response.proposalHash;
                        if (hash && multisig) {
                          const input = getFormInputRef.current?.();
                          const isRemote = input && (
                            input.txType === 'reclaimChild' ||
                            input.txType === 'destroyChild' ||
                            input.txType === 'enableChildMultiSig'
                          );
                          savePendingTx({
                            kind: 'create',
                            contractAddress: multisig.address,
                            proposalHash: hash,
                            txHash,
                            signerPubkey: offlineFeePayerAddress,
                            createdAt: new Date().toISOString(),
                            summary: input ? {
                              txType: input.txType,
                              nonce: String(input.nonce),
                              configNonce: String(multisig.configNonce ?? 0),
                              expiryBlock: input.expiryBlock != null ? String(input.expiryBlock) : null,
                              destination: isRemote ? 'remote' : 'local',
                              childAccount: input.childAccount ?? null,
                              receivers: input.receivers ?? [],
                            } : undefined,
                          });
                        }
                        router.push(hash ? `/transactions/${hash}` : '/transactions');
                      }}
                    />
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

interface TxTypePickerProps {
  localTypes: typeof LOCAL_TX_TYPES;
  childTypes: typeof CHILD_TX_TYPES;
  selected: TxType;
  onSelect: (value: TxType) => void;
}

/** Two-row picker: Account actions on top, Subaccount actions below (only on roots). */
function TxTypePicker({ localTypes, childTypes, selected, onSelect }: TxTypePickerProps) {
  return (
    <div className="space-y-3">
      <PickerRow label="Vault" types={localTypes} selected={selected} onSelect={onSelect} />
      {childTypes.length > 0 && (
        <PickerRow label="SubVault" types={childTypes} selected={selected} onSelect={onSelect} />
      )}
    </div>
  );
}

interface PickerRowProps {
  label: string;
  types: typeof LOCAL_TX_TYPES;
  selected: TxType;
  onSelect: (value: TxType) => void;
}

function PickerRow({ label, types, selected, onSelect }: PickerRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-[10px] text-safe-text uppercase tracking-wider shrink-0 w-20">{label}</span>
      <div className="flex flex-wrap gap-2">
        {types.map((type) => (
          <button
            key={type.value}
            type="button"
            onClick={() => onSelect(type.value)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-center transition-all ${
              selected === type.value
                ? 'bg-safe-green text-safe-dark shadow-md shadow-safe-green/20'
                : 'bg-safe-gray border border-safe-border text-safe-text hover:bg-safe-hover hover:text-white'
            }`}
          >
            <TxTypeIcon icon={type.icon} className="w-4 h-4" />
            {type.label}
            {selected === type.value && (
              <span className="w-2 h-2 rounded-full bg-safe-dark/40" />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
