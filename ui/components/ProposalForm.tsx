'use client';

import { MAX_OWNERS, MAX_RECEIVERS } from '@/lib/constants';
import { useEffect, useMemo, useState } from 'react';
import { fetchBalance } from '@/lib/api';
import { MEMO_MAX_BYTES, memoByteLength, isValidMemoLength } from '@/lib/memo';
import MemoWarningTooltip from '@/components/MemoWarningTooltip';
import {
  formatMina,
  nextAvailableNonce,
  truncateAddress,
  NewProposalInput,
  TxType,
  EMPTY_PUBKEY_B58,
  type ContractSummary,
  type Proposal,
} from '@/lib/types';
import TransactionCard from '@/components/TransactionCard';

interface ProposalFormProps {
  owners: string[];
  currentThreshold: number;
  numOwners: number;
  onSubmit: (data: NewProposalInput) => void;
  isSubmitting: boolean;
  txType: TxType;
  /** Indexed subaccounts of this guard, used as targets for CHILD_TX_TYPES. */
  children?: ContractSummary[];
  /** Delete-mode only: target's nonce from URL params. Ignored otherwise;
   *  the form derives the default nonce from the active txType's nonce space. */
  initialNonce: number | null;
  /** Parent guard's current executed LOCAL nonce. Only applies to LOCAL
   *  txTypes; REMOTE txTypes read the selected child's parentNonce instead. */
  currentNonce: number | null;
  /** All known proposals on this guard. Used to compute per-nonce-space
   *  collision warnings and next-available defaults. */
  proposals: ReadonlyArray<Proposal>;
  nonceResetKey: string;
  deleteMode?: boolean;
  deleteTargetHash?: string | null;
  deleteTargetProposal?: Proposal | null;
  onExitDeleteMode?: () => void;
}

/** Dynamic proposal form that maps UI inputs to MinaGuard tx type payloads. */
export default function ProposalForm({
  owners,
  currentThreshold,
  numOwners,
  onSubmit,
  isSubmitting,
  txType,
  children = [],
  initialNonce,
  currentNonce,
  proposals,
  nonceResetKey,
  deleteMode = false,
  deleteTargetHash = null,
  deleteTargetProposal = null,
  onExitDeleteMode,
}: ProposalFormProps) {
  // Recipient rows are the source of truth for both transfer + allocateChild.
  // Bulk mode renders a textarea derived from these rows (and parses back on
  // edit); Individual mode binds inputs directly.
  const [recipients, setRecipients] = useState<Array<{ address: string; amount: string }>>([
    { address: '', amount: '' },
  ]);
  const [recipientsMode, setRecipientsMode] = useState<'individual' | 'bulk'>('individual');
  const [bulkText, setBulkText] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [removeOwnerAddress, setRemoveOwnerAddress] = useState('');
  const [newThreshold, setNewThreshold] = useState(Math.max(1, currentThreshold));
  useEffect(() => {
    setNewThreshold(Math.max(1, currentThreshold));
  }, [currentThreshold]);
  const [delegate, setDelegate] = useState('');
  const [undelegate, setUndelegate] = useState(false);
  const [expiryBlock, setExpiryBlock] = useState('0');
  const [memo, setMemo] = useState('');
  const memoBytes = memoByteLength(memo);
  const memoOverLimit = !isValidMemoLength(memo);

  useEffect(() => {
    if (!deleteMode) return;
    setRecipients([{ address: '', amount: '' }]);
    setBulkText('');
    setRecipientsMode('individual');
    setExpiryBlock('0');
  }, [deleteMode]);

  // Subaccount-action fields.
  const [targetChild, setTargetChild] = useState<string>('');
  const [reclaimAmount, setReclaimAmount] = useState('');
  const [destroyConfirm, setDestroyConfirm] = useState(false);

  useEffect(() => {
    if (!targetChild && children.length > 0) setTargetChild(children[0].address);
  }, [children, targetChild]);

  // For enableChildMultiSig: derive the target state as the opposite of the
  // selected child's current `childMultiSigEnabled`. Treat null as enabled
  // (SetupEvent initializes the field to true).
  const selectedChild = children.find((c) => c.address === targetChild) ?? null;
  const currentMultiSigEnabled = selectedChild?.childMultiSigEnabled !== false;
  const enableTarget: 'enable' | 'disable' = currentMultiSigEnabled ? 'disable' : 'enable';

  // Delete-mode shape: LOCAL target → zero-value transfer; REMOTE target →
  // zero-amount reclaim.
  const isRemoteDelete = deleteMode && deleteTargetProposal?.destination === 'remote';
  const effectiveTxType: TxType = deleteMode
    ? (isRemoteDelete ? 'reclaimChild' : 'transfer')
    : txType;

  // LOCAL vs REMOTE nonce space. REMOTE non-create proposals use the target
  // child's `parentNonce` counter; LOCAL proposals use the parent guard's
  // `nonce` counter. createChild uses nonce=0 sentinel (not offered here).
  const isRemoteSpaceTxType =
    effectiveTxType === 'reclaimChild' ||
    effectiveTxType === 'destroyChild' ||
    effectiveTxType === 'enableChildMultiSig';

  // For delete-remote the target child comes from the target proposal (the
  // form's own targetChild dropdown isn't surfaced in delete mode).
  const nonceSpaceChildAddress = isRemoteDelete
    ? (deleteTargetProposal?.childAccount ?? null)
    : (isRemoteSpaceTxType ? targetChild || null : null);
  const nonceSpaceChild = nonceSpaceChildAddress
    ? (children.find((c) => c.address === nonceSpaceChildAddress) ?? null)
    : null;

  const effectiveNonceFloor = isRemoteSpaceTxType
    ? (nonceSpaceChild?.parentNonce ?? null)
    : currentNonce;

  const effectiveSpaceProposals = useMemo(() => {
    if (isRemoteSpaceTxType) {
      return proposals.filter(
        (p) => p.destination === 'remote' && p.childAccount === nonceSpaceChildAddress,
      );
    }
    return proposals.filter((p) => p.destination === 'local');
  }, [proposals, isRemoteSpaceTxType, nonceSpaceChildAddress]);

  const effectiveTakenNonces = useMemo(
    () =>
      new Set(
        effectiveSpaceProposals
          .filter((p) => p.status === 'pending')
          .map((p) => Number(p.nonce))
          .filter((n) => Number.isFinite(n)),
      ),
    [effectiveSpaceProposals],
  );

  const effectiveDefaultNonce = useMemo(() => {
    if (deleteMode) return initialNonce;
    return nextAvailableNonce(effectiveNonceFloor, effectiveSpaceProposals);
  }, [deleteMode, initialNonce, effectiveNonceFloor, effectiveSpaceProposals]);

  const [nonce, setNonce] = useState(
    effectiveDefaultNonce === null ? '' : String(effectiveDefaultNonce),
  );
  const [nonceDirty, setNonceDirty] = useState(false);

  useEffect(() => {
    setNonceDirty(false);
    setNonce(effectiveDefaultNonce === null ? '' : String(effectiveDefaultNonce));
  }, [effectiveDefaultNonce, nonceResetKey]);

  useEffect(() => {
    if (nonceDirty) return;
    setNonce(effectiveDefaultNonce === null ? '' : String(effectiveDefaultNonce));
  }, [effectiveDefaultNonce, nonceDirty]);

  // Fetch the selected child's balance so the reclaim form can show the upper bound.
  const [targetBalance, setTargetBalance] = useState<string | null>(null);
  useEffect(() => {
    if (txType !== 'reclaimChild' || !targetChild) {
      setTargetBalance(null);
      return;
    }
    let cancelled = false;
    setTargetBalance(null);
    fetchBalance(targetChild).then((b) => {
      if (!cancelled) setTargetBalance(b);
    });
    return () => {
      cancelled = true;
    };
  }, [txType, targetChild]);

  const [validationError, setValidationError] = useState<string | null>(null);
  const recipientsParse = useMemo(() => parseRecipients(recipients), [recipients]);
  // Live warning for nonce collisions with pending proposals — non-blocking,
  // matches the delete-mode race-to-execute semantics.
  const nonceCollisionWarning = (() => {
    if (deleteMode) return null;
    const parsed = parseProposalNonce(nonce);
    if (parsed === null) return null;
    if (!effectiveTakenNonces.has(parsed)) return null;
    return parsed;
  })();

  /** Emits normalized form payload according to the selected transaction type. */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    const parsedNonce = parseProposalNonce(nonce);
    if (parsedNonce === null) {
      setValidationError('Nonce must be a positive integer.');
      return;
    }
    // Skip the executed-nonce floor in delete mode: the target proposal's
    // nonce is authoritative. Otherwise the floor depends on txType's nonce
    // space (parent's localNonce for LOCAL, child's parentNonce for REMOTE).
    if (!deleteMode && effectiveNonceFloor !== null && parsedNonce <= effectiveNonceFloor) {
      const floorLabel = isRemoteSpaceTxType
        ? `the selected subaccount's executed remote nonce (${effectiveNonceFloor})`
        : `the current executed nonce (${effectiveNonceFloor})`;
      setValidationError(`Nonce must be greater than ${floorLabel}.`);
      return;
    }
    // Nonce collision with a pending proposal is deliberately allowed — it's
    // the same mechanism as delete-mode (whichever executes first burns the
    // slot and invalidates the other). A non-blocking warning is rendered
    // below the form instead.

    if (effectiveTxType === 'addOwner' && numOwners >= MAX_OWNERS) {
      setValidationError(`Cannot exceed the maximum of ${MAX_OWNERS} owners.`);
      return;
    }
    if (!deleteMode && (txType === 'transfer' || txType === 'allocateChild') && !recipientsParse.ok) {
      setValidationError(
        recipientsParse.topError ?? 'Fix the highlighted recipient rows before submitting.',
      );
      return;
    }
    if (
      !deleteMode &&
      (txType === 'reclaimChild' || txType === 'destroyChild' || txType === 'enableChildMultiSig') &&
      !targetChild
    ) {
      setValidationError('Pick a subaccount to target.');
      return;
    }
    if (!deleteMode && txType === 'reclaimChild') {
      const parsed = parseMinaToNanomina(reclaimAmount);
      if (!parsed) {
        setValidationError('Reclaim amount must be a positive MINA value.');
        return;
      }
      if (targetBalance !== null && BigInt(parsed.nanomina) > BigInt(targetBalance)) {
        setValidationError(`Reclaim amount exceeds subaccount balance (${formatMina(targetBalance)} MINA).`);
        return;
      }
    }
    if (!deleteMode && txType === 'destroyChild' && !destroyConfirm) {
      setValidationError('Confirm the destroy action — this drains the subaccount and disables its multi-sig.');
      return;
    }
    if (effectiveTxType === 'addOwner' && owners.includes(newOwner.trim())) {
      setValidationError('This address is already an owner.');
      return;
    }
    if (effectiveTxType === 'removeOwner' && !owners.includes(removeOwnerAddress.trim())) {
      setValidationError('This address is not a current owner.');
      return;
    }
    if (effectiveTxType === 'removeOwner' && numOwners - 1 < currentThreshold) {
      setValidationError('Reduce the threshold first before removing an owner.');
      return;
    }
    if (
      effectiveTxType === 'changeThreshold'
      && (
        !Number.isInteger(newThreshold)
        || newThreshold < 1
        || newThreshold > Math.max(1, numOwners)
      )
    ) {
      setValidationError(`Threshold must be between 1 and ${Math.max(1, numOwners)}.`);
      return;
    }
    if (effectiveTxType === 'changeThreshold' && newThreshold === currentThreshold) {
      setValidationError('The new threshold is the same as the current one.');
      return;
    }
    if (memoOverLimit) {
      setValidationError(`Memo exceeds ${MEMO_MAX_BYTES} UTF-8 bytes.`);
      return;
    }

    const deleteReceivers = deleteMode && !isRemoteDelete
      ? [{ address: EMPTY_PUBKEY_B58, amount: '0' }]
      : undefined;

    onSubmit({
      txType: effectiveTxType,
      nonce: parsedNonce,
      receivers:
        deleteReceivers ??
        (effectiveTxType === 'transfer' || effectiveTxType === 'allocateChild'
          ? recipientsParse.receivers
          : undefined),
      newOwner: !deleteMode && effectiveTxType === 'addOwner' ? newOwner : undefined,
      removeOwnerAddress: !deleteMode && effectiveTxType === 'removeOwner' ? removeOwnerAddress : undefined,
      newThreshold: !deleteMode && effectiveTxType === 'changeThreshold' ? newThreshold : undefined,
      delegate: !deleteMode && effectiveTxType === 'setDelegate' && !undelegate ? delegate : undefined,
      undelegate: !deleteMode && effectiveTxType === 'setDelegate' ? undelegate : undefined,
      childAccount:
        isRemoteDelete && deleteTargetProposal?.childAccount
          ? deleteTargetProposal.childAccount
          : !deleteMode && (txType === 'reclaimChild' || txType === 'destroyChild' || txType === 'enableChildMultiSig')
            ? targetChild
            : undefined,
      reclaimAmount:
        isRemoteDelete
          ? '0'
          : !deleteMode && txType === 'reclaimChild'
            ? (parseMinaToNanomina(reclaimAmount)?.nanomina ?? '0')
            : undefined,
      childMultiSigEnable:
        !deleteMode && txType === 'enableChildMultiSig' ? enableTarget === 'enable' : undefined,
      expiryBlock: Number(expiryBlock) > 0 ? Number(expiryBlock) : 0,
      memo: memo.length > 0 ? memo : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {deleteMode && (
        <div className="rounded-lg border border-orange-400/30 bg-orange-400/10 px-4 py-4 text-sm text-orange-200 space-y-3">
          <div>
            <p className="font-semibold text-orange-100">Delete pending proposal</p>
            <p className="mt-1 opacity-90">
              This creates a zero-effect proposal with the same nonce, so if it executes first it will invalidate the proposal below.
            </p>
          </div>

          {deleteTargetProposal ? (
            <div className="space-y-2">
              <TransactionCard
                proposal={deleteTargetProposal}
                threshold={currentThreshold}
                owners={owners}
              />
              <p className="text-xs opacity-75 font-mono break-all">
                Nonce {deleteTargetProposal.nonce} · Hash {truncateAddress(deleteTargetProposal.proposalHash, 8)}
              </p>
            </div>
          ) : deleteTargetHash && (
            <p className="text-xs opacity-75 font-mono break-all">
              Hash {deleteTargetHash}
            </p>
          )}

          {onExitDeleteMode && (
            <button
              type="button"
              onClick={onExitDeleteMode}
              className="text-sm font-medium text-orange-100 underline underline-offset-4 hover:opacity-80"
            >
              Back to normal proposal
            </button>
          )}
        </div>
      )}

      <div className="space-y-2">
        <FormInput
          label="Nonce"
          value={nonce}
          onChange={(value) => {
            setNonceDirty(true);
            setNonce(value);
          }}
          placeholder={effectiveDefaultNonce === null ? '1' : String(effectiveDefaultNonce)}
          inputMode="numeric"
          required
        />
        <p className="text-xs text-safe-text">
          {(() => {
            const floorLabel = isRemoteSpaceTxType
              ? 'subaccount’s executed remote nonce'
              : 'contract’s executed nonce';
            if (effectiveNonceFloor === null) {
              return `Use a nonce greater than the ${floorLabel}.`;
            }
            if (effectiveDefaultNonce !== null) {
              return `Next available nonce: ${effectiveDefaultNonce}. Current ${floorLabel}: ${effectiveNonceFloor}.`;
            }
            return `Current ${floorLabel}: ${effectiveNonceFloor}. Use a higher nonce for new proposals.`;
          })()}
        </p>
      </div>

      {!deleteMode && (txType === 'transfer' || txType === 'allocateChild') && (
        <RecipientsBlock
          label={txType === 'allocateChild' ? 'Subaccount allocations' : 'Recipients'}
          recipients={recipients}
          setRecipients={setRecipients}
          recipientsMode={recipientsMode}
          setRecipientsMode={setRecipientsMode}
          bulkText={bulkText}
          setBulkText={setBulkText}
          parse={recipientsParse}
          children={txType === 'allocateChild' ? children : []}
        />
      )}

      {!deleteMode && (txType === 'reclaimChild' || txType === 'destroyChild' || txType === 'enableChildMultiSig') && (
        <div>
          <label className="block text-sm text-safe-text mb-2">Target Subaccount</label>
          {children.length === 0 ? (
            <p className="text-sm text-amber-400">
              No indexed subaccounts to target. Create one first via the parent &rarr; Create Subaccount flow.
            </p>
          ) : (
            <div className="space-y-2">
              {children.map((c) => {
                const selected = targetChild === c.address;
                const accentBorder = txType === 'destroyChild' ? 'border-red-400' : 'border-safe-green';
                const accentBg = txType === 'destroyChild' ? 'bg-red-400/5' : 'bg-safe-green/5';
                const accentDot = txType === 'destroyChild' ? 'bg-red-400' : 'bg-safe-green';
                return (
                  <label
                    key={c.address}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selected ? `${accentBorder} ${accentBg}` : 'border-safe-border hover:border-safe-text'
                    }`}
                  >
                    <input
                      type="radio"
                      name="targetChild"
                      value={c.address}
                      checked={selected}
                      onChange={(e) => setTargetChild(e.target.value)}
                      className="sr-only"
                    />
                    <div
                      className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                        selected ? accentBorder : 'border-safe-border'
                      }`}
                    >
                      {selected && <div className={`w-2 h-2 rounded-full ${accentDot}`} />}
                    </div>
                    <span className="text-sm font-mono text-safe-text truncate">{c.address}</span>
                    {c.childMultiSigEnabled === false && (
                      <span className="ml-auto text-[10px] text-amber-400 shrink-0">multi-sig off</span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!deleteMode && txType === 'reclaimChild' && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-safe-text">Reclaim Amount (MINA)</label>
            <span className="text-xs text-safe-text">
              Available:{' '}
              <span className="font-mono text-safe-green">
                {targetBalance === null ? '…' : `${formatMina(targetBalance)} MINA`}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={reclaimAmount}
              onChange={(e) => setReclaimAmount(e.target.value)}
              placeholder="1.0"
              inputMode="decimal"
              required
              className="flex-1 bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
            />
            <button
              type="button"
              disabled={!targetBalance || targetBalance === '0'}
              onClick={() => {
                if (targetBalance) setReclaimAmount(formatMina(targetBalance));
              }}
              className="text-xs font-semibold uppercase tracking-wider text-safe-green hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline px-2"
            >
              Max
            </button>
          </div>
        </div>
      )}

      {!deleteMode && txType === 'destroyChild' && (
        <div className="space-y-2 rounded-lg border border-red-400/40 bg-red-400/5 px-4 py-3">
          <p className="text-xs text-red-300">
            Destroy drains the subaccount&apos;s full balance to the parent and disables its
            multi-sig. The on-chain account remains but its lifecycle is permanently frozen.
          </p>
          <label className="inline-flex items-center gap-2 text-sm text-safe-text">
            <input
              type="checkbox"
              checked={destroyConfirm}
              onChange={(e) => setDestroyConfirm(e.target.checked)}
            />
            I understand and want to destroy this subaccount.
          </label>
        </div>
      )}

      {!deleteMode && txType === 'enableChildMultiSig' && selectedChild && (
        <div className="space-y-2 rounded-lg border border-safe-border bg-safe-dark/20 px-4 py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-safe-text">Current state</span>
            <span className={`font-semibold ${currentMultiSigEnabled ? 'text-safe-green' : 'text-amber-400'}`}>
              {currentMultiSigEnabled ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-safe-text">Proposed state</span>
            <span className={`font-semibold ${enableTarget === 'enable' ? 'text-safe-green' : 'text-amber-400'}`}>
              {enableTarget === 'enable' ? 'Enabled' : 'Disabled'}
            </span>
          </div>
          <p className="text-xs text-safe-text pt-1">
            {currentMultiSigEnabled
              ? 'Disabling blocks the subaccount from running its own LOCAL proposals (transfers, owner changes, etc.). Parent-authorized lifecycle actions remain available.'
              : 'Enabling restores the subaccount\'s ability to run its own LOCAL proposals.'}
          </p>
        </div>
      )}

      {effectiveTxType === 'addOwner' && (
        <FormInput
          label="New Owner Address"
          value={newOwner}
          onChange={setNewOwner}
          placeholder="B62q..."
          mono
          required
        />
      )}

      {effectiveTxType === 'removeOwner' && (
        <div>
          <label className="block text-sm text-safe-text mb-2">Select Owner to Remove</label>
          <div className="space-y-2">
            {owners.map((owner) => (
              <label
                key={owner}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${removeOwnerAddress === owner
                  ? 'border-red-400 bg-red-400/5'
                  : 'border-safe-border hover:border-safe-text'
                  }`}
              >
                <input
                  type="radio"
                  name="removeOwner"
                  value={owner}
                  checked={removeOwnerAddress === owner}
                  onChange={(e) => setRemoveOwnerAddress(e.target.value)}
                  className="sr-only"
                />
                <div
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${removeOwnerAddress === owner ? 'border-red-400' : 'border-safe-border'
                    }`}
                >
                  {removeOwnerAddress === owner && <div className="w-2 h-2 rounded-full bg-red-400" />}
                </div>
                <span className="text-sm font-mono text-safe-text">{owner}</span>
              </label>
            ))}
          </div>
          {numOwners - 1 < currentThreshold && (
            <p className="text-xs text-red-400 mt-2">
              Cannot remove an owner while it would go below the threshold. Create a &quot;Change Threshold&quot; proposal first.
            </p>
          )}
        </div>
      )}

      {effectiveTxType === 'changeThreshold' && (
        <div>
          <label className="text-sm text-safe-text mb-2 flex items-center gap-1">
            New Threshold
            <span className="relative group">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-safe-border text-[10px] leading-none text-safe-text cursor-help">?</span>
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 transition-all duration-200 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0">
                <div className="bg-safe-green/70 backdrop-blur-md text-white text-xs font-semibold rounded-lg px-2.5 py-1 shadow-lg whitespace-nowrap">
                  Minimum approvals required to execute a proposal.
                </div>
                <svg className="mx-auto -mt-px" width="10" height="6" viewBox="0 0 10 6">
                  <path d="M0 0L5 6L10 0Z" className="fill-safe-green/70" />
                </svg>
              </div>
            </span>
          </label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={Math.max(1, numOwners)}
              value={newThreshold}
              onChange={(e) => {
                const value = e.currentTarget.valueAsNumber;
                if (Number.isNaN(value)) return;
                setNewThreshold(value);
              }}
              className="w-20 bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm"
            />
            <span className="text-sm text-safe-text">out of {numOwners}</span>
          </div>
        </div>
      )}

      {effectiveTxType === 'setDelegate' && (
        <div className="space-y-3">
          <label className="inline-flex items-center gap-2 text-sm text-safe-text">
            <input
              type="checkbox"
              checked={undelegate}
              onChange={(e) => setUndelegate(e.target.checked)}
            />
            Undelegate (set delegate to contract self)
          </label>
          {!undelegate && (
            <FormInput
              label="Delegate Address"
              value={delegate}
              onChange={setDelegate}
              placeholder="B62q..."
              mono
              required
            />
          )}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="flex items-center gap-1 text-sm text-safe-text">
            Memo (optional)
            <MemoWarningTooltip />
          </label>
          <span className={`text-xs ${memoOverLimit ? 'text-red-400' : 'text-safe-text/60'}`}>
            {memoBytes} / {MEMO_MAX_BYTES} bytes
          </span>
        </div>
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          placeholder="Short note committed to the proposal hash"
          className={`w-full bg-safe-gray border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none transition-colors ${
            memoOverLimit
              ? 'border-red-400 focus:border-red-400'
              : 'border-safe-border focus:border-safe-green'
          }`}
        />
      </div>

      <FormInput
        label="Expiry Block (0 = no expiry)"
        value={expiryBlock}
        onChange={setExpiryBlock}
        placeholder="0"
        inputMode="numeric"
      />

      {nonceCollisionWarning && (
        <div className="rounded-lg border border-orange-400/30 bg-orange-400/10 px-4 py-3 text-sm text-orange-200">
          <p className="font-semibold mb-1">Nonce {nonceCollisionWarning} is already in use</p>
          <p className="opacity-90">
            Another pending proposal is queued at this nonce. Submitting will race it — whichever
            executes first burns the nonce and invalidates the other. This is the same mechanism as
            delete-mode.
          </p>
        </div>
      )}

      {validationError && <p className="text-sm text-red-400">{validationError}</p>}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all disabled:opacity-50"
      >
        {isSubmitting ? 'Submitting Proposal...' : (deleteMode ? 'Create Delete Proposal' : 'Submit Proposal')}
      </button>
    </form>
  );
}

/** Renders the recipients block in either Individual (per-row inputs) or
 *  Bulk (textarea) mode. `recipients` is the source of truth; bulk mode just
 *  serializes/parses through `bulkText`. */
function RecipientsBlock({
  label,
  recipients,
  setRecipients,
  recipientsMode,
  setRecipientsMode,
  bulkText,
  setBulkText,
  parse,
  children,
}: {
  label: string;
  recipients: Array<{ address: string; amount: string }>;
  setRecipients: (rows: Array<{ address: string; amount: string }>) => void;
  recipientsMode: 'individual' | 'bulk';
  setRecipientsMode: (mode: 'individual' | 'bulk') => void;
  bulkText: string;
  setBulkText: (text: string) => void;
  parse: RecipientsParseResult;
  children: ContractSummary[];
}) {
  const showAddRow = recipients.length < MAX_RECEIVERS;

  const updateRow = (index: number, patch: Partial<{ address: string; amount: string }>) => {
    setRecipients(recipients.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };
  const addRow = () => {
    if (recipients.length >= MAX_RECEIVERS) return;
    setRecipients([...recipients, { address: '', amount: '' }]);
  };
  const removeRow = (index: number) => {
    if (recipients.length <= 1) return;
    setRecipients(recipients.filter((_, i) => i !== index));
  };

  const switchToBulk = () => {
    setBulkText(serializeRecipients(recipients));
    setRecipientsMode('bulk');
  };
  const switchToIndividual = () => {
    setRecipientsMode('individual');
  };
  const handleBulkChange = (text: string) => {
    setBulkText(text);
    setRecipients(parseBulkRecipients(text));
  };

  const totalDisplay = formatNanominaAsMina(parse.totalAmount);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <label className="block text-sm text-safe-text">{label}</label>
        <div className="inline-flex rounded-lg border border-safe-border overflow-hidden text-xs">
          <button
            type="button"
            onClick={switchToIndividual}
            className={`px-3 py-1 transition-colors ${
              recipientsMode === 'individual'
                ? 'bg-safe-green text-safe-dark font-semibold'
                : 'bg-transparent text-safe-text hover:bg-safe-hover'
            }`}
          >
            Individual
          </button>
          <button
            type="button"
            onClick={switchToBulk}
            className={`px-3 py-1 transition-colors ${
              recipientsMode === 'bulk'
                ? 'bg-safe-green text-safe-dark font-semibold'
                : 'bg-transparent text-safe-text hover:bg-safe-hover'
            }`}
          >
            Bulk
          </button>
        </div>
      </div>

      {recipientsMode === 'individual' ? (
        <div className="space-y-2">
          {recipients.map((row, index) => {
            const validation = parse.rows[index];
            const hasError = validation?.errors.length > 0;
            const hasWarning = !!validation?.warning;
            return (
              <div key={index} className="space-y-1">
                <div className="flex gap-2 items-start">
                  {children.length > 0 ? (
                    <select
                      value={row.address}
                      onChange={(e) => updateRow(index, { address: e.target.value })}
                      className="flex-1 min-w-0 bg-safe-gray border border-safe-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-safe-green"
                    >
                      <option value="">Select subaccount…</option>
                      {children.map((c) => (
                        <option key={c.address} value={c.address}>
                          {c.address.slice(0, 12)}…{c.address.slice(-6)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      value={row.address}
                      onChange={(e) => updateRow(index, { address: e.target.value })}
                      placeholder="B62q..."
                      className="flex-1 min-w-0 bg-safe-gray border border-safe-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green"
                    />
                  )}
                  <input
                    type="text"
                    value={row.amount}
                    onChange={(e) => updateRow(index, { amount: e.target.value })}
                    placeholder="0.00"
                    inputMode="decimal"
                    className="w-32 shrink-0 bg-safe-gray border border-safe-border rounded-lg px-3 py-2 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green"
                  />
                  <button
                    type="button"
                    onClick={() => removeRow(index)}
                    disabled={recipients.length <= 1}
                    title={recipients.length <= 1 ? 'At least one recipient is required.' : 'Remove recipient'}
                    className="shrink-0 px-2 py-2 text-safe-text hover:text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="Remove recipient"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                {hasError && (
                  <p className="text-xs text-red-400 pl-1">{validation.errors.join(' · ')}</p>
                )}
                {!hasError && hasWarning && (
                  <p className="text-xs text-amber-300 pl-1">{validation.warning}</p>
                )}
              </div>
            );
          })}
          {showAddRow && (
            <button
              type="button"
              onClick={addRow}
              className="text-xs font-medium text-safe-green hover:underline"
            >
              + Add recipient
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {children.length > 0 && (
            <div className="rounded-lg border border-safe-border bg-safe-dark/20 px-3 py-2 text-xs space-y-1">
              <p className="text-safe-text">Indexed subaccounts (click to append):</p>
              <ul className="space-y-0.5">
                {children.map((c) => (
                  <li key={c.address}>
                    <button
                      type="button"
                      onClick={() => {
                        const next = bulkText.trim()
                          ? `${bulkText.trim()}\n${c.address},`
                          : `${c.address},`;
                        handleBulkChange(next);
                      }}
                      className="font-mono text-safe-green hover:underline truncate"
                      title={c.address}
                    >
                      {c.address.slice(0, 12)}…{c.address.slice(-6)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <textarea
            value={bulkText}
            onChange={(e) => handleBulkChange(e.target.value)}
            placeholder={`B62q...,1.25\nB62q...,0.5`}
            rows={8}
            className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
          />
          <p className="text-xs text-safe-text">
            One recipient per line as <span className="font-mono">address,amount</span>.
          </p>
          {parse.rows.some((r) => r.errors.length > 0) && (
            <ul className="text-xs text-red-400 space-y-0.5">
              {parse.rows.map((r, i) =>
                r.errors.length > 0 ? (
                  <li key={i}>Line {i + 1}: {r.errors.join(' · ')}</li>
                ) : null,
              )}
            </ul>
          )}
          {parse.rows.some((r) => !r.errors.length && r.warning) && (
            <ul className="text-xs text-amber-300 space-y-0.5">
              {parse.rows.map((r, i) =>
                !r.errors.length && r.warning ? (
                  <li key={i}>Line {i + 1}: {r.warning}</li>
                ) : null,
              )}
            </ul>
          )}
        </div>
      )}

      <div className="rounded-lg border border-safe-border bg-safe-dark/20 px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-safe-text">Parsed recipients</span>
          <span className="font-mono text-safe-green">{parse.recipientCount}/{MAX_RECEIVERS}</span>
        </div>
        <div className="flex items-center justify-between gap-4 mt-2">
          <span className="text-safe-text">Total MINA</span>
          <span className="font-mono text-safe-green">{totalDisplay}</span>
        </div>
        <div className="flex items-center justify-between gap-4 mt-2">
          <span className="text-safe-text">Remaining slots</span>
          <span className="font-mono text-safe-text">
            {Math.max(0, MAX_RECEIVERS - parse.recipientCount)}
          </span>
        </div>
      </div>

      {parse.topError && (
        <p className="text-sm text-red-400">{parse.topError}</p>
      )}
    </div>
  );
}

/** Per-row validation result emitted by `parseRecipients`. Empty rows return
 *  `ok:false` with no `errors` so the UI doesn't yell at users about rows
 *  they haven't filled in yet. */
interface RecipientRowValidation {
  ok: boolean;
  /** Canonical nanomina value when both address and amount validate. */
  nanomina: string | null;
  /** Hard errors (red, block submission). */
  errors: string[];
  /** Soft warning (amber, non-blocking). Currently: amount truncated past 9 decimals. */
  warning: string | null;
}

interface RecipientsParseResult {
  rows: RecipientRowValidation[];
  /** True when at least one row is filled and every filled row validates. */
  ok: boolean;
  /** Submission-ready array, only valid rows. */
  receivers: Array<{ address: string; amount: string }>;
  /** Sum of valid nanomina amounts. */
  totalAmount: string;
  /** Number of valid (submission-ready) rows. */
  recipientCount: number;
  /** Aggregate-level error (e.g. "Add at least one recipient"). Null when
   *  only per-row errors exist; the row-level UI surfaces those. */
  topError: string | null;
}

/** Validates a list of {address, amount} rows. The same logic powers both
 *  Individual (per-row inputs) and Bulk (textarea) modes — the bulk mode
 *  parses lines into rows and then defers to this. */
function parseRecipients(rows: Array<{ address: string; amount: string }>): RecipientsParseResult {
  const isEmpty = (r: { address: string; amount: string }) => !r.address.trim() && !r.amount.trim();
  const filledCount = rows.filter((r) => !isEmpty(r)).length;

  // Detect duplicates among filled rows so we can mark every duplicate row,
  // not just the second occurrence.
  const addressCounts = new Map<string, number>();
  for (const r of rows) {
    const a = r.address.trim();
    if (!a) continue;
    addressCounts.set(a, (addressCounts.get(a) ?? 0) + 1);
  }

  const validations: RecipientRowValidation[] = rows.map((row) => {
    if (isEmpty(row)) return { ok: false, nanomina: null, errors: [], warning: null };

    const address = row.address.trim();
    const amountText = row.amount.trim();
    const errors: string[] = [];
    let warning: string | null = null;
    let nanomina: string | null = null;

    if (!address) errors.push('Address required');
    else if (!/^B62[1-9A-HJ-NP-Za-km-z]+$/.test(address)) errors.push('Invalid Mina address');
    else if ((addressCounts.get(address) ?? 0) > 1) errors.push('Duplicate recipient');

    if (!amountText) errors.push('Amount required');
    else {
      const amt = parseMinaToNanomina(amountText);
      if (!amt) errors.push('Invalid amount');
      else {
        nanomina = amt.nanomina;
        if (amt.truncated) {
          warning = `Will send ${formatNanominaAsMina(amt.nanomina)} MINA (Mina's precision is 9 decimals).`;
        }
      }
    }

    return {
      ok: errors.length === 0 && nanomina !== null,
      nanomina: errors.length === 0 ? nanomina : null,
      errors,
      warning,
    };
  });

  const receivers: Array<{ address: string; amount: string }> = [];
  let total = 0n;
  for (let i = 0; i < rows.length; i++) {
    const v = validations[i];
    if (v.ok && v.nanomina) {
      receivers.push({ address: rows[i].address.trim(), amount: v.nanomina });
      total += BigInt(v.nanomina);
    }
  }

  let topError: string | null = null;
  if (filledCount === 0) topError = 'Add at least one recipient.';
  else if (filledCount > MAX_RECEIVERS) topError = `Too many recipients. The contract limit is ${MAX_RECEIVERS}.`;

  // Aggregate ok: a) at least one filled+valid row, b) no row carries errors,
  // c) no aggregate-level violation.
  const ok =
    topError === null &&
    receivers.length > 0 &&
    validations.every((v, i) => isEmpty(rows[i]) || v.ok);

  return {
    rows: validations,
    ok,
    receivers,
    totalAmount: total.toString(),
    recipientCount: receivers.length,
    topError,
  };
}

/** Serializes recipient rows back to the bulk textarea representation.
 *  Drops empty rows so re-entering bulk mode starts clean. */
function serializeRecipients(rows: Array<{ address: string; amount: string }>): string {
  return rows
    .filter((r) => r.address.trim() || r.amount.trim())
    .map((r) => `${r.address.trim()},${r.amount.trim()}`)
    .join('\n');
}

/** Parses bulk textarea content into recipient rows, preserving partially-
 *  typed input (no early validation) so users don't lose progress mid-edit. */
function parseBulkRecipients(text: string): Array<{ address: string; amount: string }> {
  const lines = text.split('\n');
  const rows = lines.map((line) => {
    const idx = line.indexOf(',');
    if (idx === -1) return { address: line.trim(), amount: '' };
    return { address: line.slice(0, idx).trim(), amount: line.slice(idx + 1).trim() };
  });
  return rows.length > 0 ? rows : [{ address: '', amount: '' }];
}

/** Parses a MINA decimal string to canonical nanomina, truncating past 9
 *  fractional digits (Mina's smallest unit is 1 nanomina = 1e-9 MINA).
 *  Returns null for non-numeric input or values that round to zero. The
 *  `truncated` flag tells the UI to surface a warning. */
function parseMinaToNanomina(value: string): { nanomina: string; truncated: boolean } | null {
  if (!/^\d+(\.\d*)?$/.test(value)) return null;
  const [whole, frac = ''] = value.split('.');
  const truncated = frac.length > 9;
  const fracTrimmed = frac.slice(0, 9).padEnd(9, '0');
  const amount = `${whole}${fracTrimmed}`.replace(/^0+(?=\d)/, '') || '0';
  if (BigInt(amount) === 0n) return null;
  return { nanomina: amount, truncated };
}

function formatNanominaAsMina(value: string): string {
  const normalized = value.replace(/^0+(?=\d)/, '') || '0';
  const whole = normalized.length > 9 ? normalized.slice(0, -9) : '0';
  const frac = normalized.length > 9 ? normalized.slice(-9) : normalized.padStart(9, '0');
  const trimmedFrac = frac.replace(/0+$/, '');
  return trimmedFrac ? `${whole}.${trimmedFrac}` : whole;
}

function parseProposalNonce(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

/** Shared text input primitive for proposal form field sections. */
function FormInput({
  label,
  value,
  onChange,
  placeholder,
  required,
  mono,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
  mono?: boolean;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  return (
    <div>
      <label className="block text-sm text-safe-text mb-2">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        className={`w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors ${mono ? 'font-mono' : ''
          }`}
        required={required}
      />
    </div>
  );
}
