'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import ProposalForm from '@/components/ProposalForm';
import {
  CHILD_TX_TYPES,
  LOCAL_TX_TYPES,
  nextAvailableNonce,
  type ContractSummary,
  type NewProposalInput,
  type TxType,
} from '@/lib/types';
import TxTypeIcon from '@/components/TxTypeIcon';
import { createOnchainProposal } from '@/lib/multisigClient';
import { fetchChildren, fetchContract } from '@/lib/api';

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

  // Available tx types: LOCAL on every guard; subaccount actions only on roots.
  const availableTypes = useMemo(
    () => (isRoot ? [...LOCAL_TX_TYPES, ...CHILD_TX_TYPES.filter((t) => t.value !== 'createChild')] : LOCAL_TX_TYPES),
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

  const deleteTargetInitialNonce = (() => {
    if (!deleteMode) return null;
    const parsed = Number(deleteTargetNonce ?? '');
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  })();
  const initialNonce = deleteMode
    ? deleteTargetInitialNonce
    : nextAvailableNonce(currentNonce, proposals);

  const takenNonces = useMemo(
    () =>
      new Set(
        proposals
          .filter((p) => p.status === 'pending')
          .map((p) => Number(p.nonce))
          .filter((n) => Number.isFinite(n)),
      ),
    [proposals],
  );

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
      const proposalHash = await createOnchainProposal({
        contractAddress,
        proposerAddress,
        input: data,
        configNonce,
        networkId,
      }, onProgress, signer);
      createdHash = proposalHash;
      if (!proposalHash) return null;

      return `Proposal created: ${proposalHash}`;
    });
    router.push(createdHash ? `/transactions/${createdHash}?pending=1` : '/transactions');
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
                onSelect={setTxType}
              />
            )}

            <div className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
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
              <ProposalForm
                owners={owners.map((owner) => owner.address)}
                currentThreshold={multisig.threshold ?? 1}
                numOwners={multisig.numOwners ?? owners.length}
                onSubmit={handleSubmit}
                isSubmitting={isOperating}
                txType={txType}
                children={children}
                initialNonce={initialNonce}
                currentNonce={currentNonce}
                takenNonces={takenNonces}
                nonceResetKey={`${multisig.address}:${deleteMode ? deleteTargetHash ?? 'delete' : 'normal'}`}
                deleteMode={deleteMode}
                deleteTargetHash={deleteTargetHash}
                deleteTargetProposal={deleteTargetProposal}
                onExitDeleteMode={handleExitDeleteMode}
              />
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
      <PickerRow label="Account" types={localTypes} selected={selected} onSelect={onSelect} />
      {childTypes.length > 0 && (
        <PickerRow label="Subaccount" types={childTypes} selected={selected} onSelect={onSelect} />
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
