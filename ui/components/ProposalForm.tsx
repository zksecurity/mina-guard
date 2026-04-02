'use client';

import { useState } from 'react';
import { NewProposalInput, TxType } from '@/lib/types';

interface ProposalFormProps {
  owners: string[];
  currentThreshold: number;
  numOwners: number;
  onSubmit: (data: NewProposalInput) => void;
  isSubmitting: boolean;
  txType: TxType;
}

/** Dynamic proposal form that maps UI inputs to MinaGuard tx type payloads. */
export default function ProposalForm({
  owners,
  currentThreshold,
  numOwners,
  onSubmit,
  isSubmitting,
  txType,
}: ProposalFormProps) {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [removeOwnerAddress, setRemoveOwnerAddress] = useState('');
  const [newThreshold, setNewThreshold] = useState<number | string>('');
  const [delegate, setDelegate] = useState('');
  const [undelegate, setUndelegate] = useState(false);
  const [expiryBlock, setExpiryBlock] = useState('0');

  const [validationError, setValidationError] = useState<string | null>(null);

  /** Emits normalized form payload according to the selected transaction type. */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);

    if (txType === 'addOwner' && owners.includes(newOwner.trim())) {
      setValidationError('This address is already an owner.');
      return;
    }
    if (txType === 'removeOwner' && !owners.includes(removeOwnerAddress.trim())) {
      setValidationError('This address is not a current owner.');
      return;
    }
    if (txType === 'removeOwner' && numOwners - 1 < currentThreshold) {
      setValidationError('Reduce the threshold first before removing an owner.');
      return;
    }
    if (txType === 'changeThreshold' && (newThreshold === '' || isNaN(Number(newThreshold)))) {
      setValidationError('Please choose a new threshold.');
      return;
    }
    if (txType === 'changeThreshold' && Number(newThreshold) === currentThreshold) {
      setValidationError('The new threshold is the same as the current one.');
      return;
    }

    onSubmit({
      txType,
      to: txType === 'transfer' ? to : undefined,
      amount: txType === 'transfer' ? amount : undefined,
      newOwner: txType === 'addOwner' ? newOwner : undefined,
      removeOwnerAddress: txType === 'removeOwner' ? removeOwnerAddress : undefined,
      newThreshold: txType === 'changeThreshold' ? Number(newThreshold) : undefined,
      delegate: txType === 'setDelegate' && !undelegate ? delegate : undefined,
      undelegate: txType === 'setDelegate' ? undelegate : undefined,
      expiryBlock: Number(expiryBlock) > 0 ? Number(expiryBlock) : 0,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {txType === 'transfer' && (
        <>
          <FormInput
            label="Recipient Address"
            value={to}
            onChange={setTo}
            placeholder="B62q..."
            mono
            required
          />
          <FormInput
            label="Amount (MINA)"
            value={amount}
            onChange={setAmount}
            placeholder="0.0"
            required
            inputMode="decimal"
          />
        </>
      )}

      {txType === 'addOwner' && (
        <FormInput
          label="New Owner Address"
          value={newOwner}
          onChange={setNewOwner}
          placeholder="B62q..."
          mono
          required
        />
      )}

      {txType === 'removeOwner' && (
        <div>
          <label className="block text-sm text-safe-text mb-2">Select Owner to Remove</label>
          <div className="space-y-2">
            {owners.map((owner) => (
              <label
                key={owner}
                className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                  removeOwnerAddress === owner
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
                  className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                    removeOwnerAddress === owner ? 'border-red-400' : 'border-safe-border'
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

      {txType === 'changeThreshold' && (
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
              onChange={(e) => setNewThreshold(e.target.value === '' ? '' : (parseInt(e.target.value, 10) || ''))}
              className="w-20 bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm"
            />
            <span className="text-sm text-safe-text">out of {numOwners}</span>
          </div>
        </div>
      )}

      {txType === 'setDelegate' && (
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

      <FormInput
        label="Expiry Block (0 = no expiry)"
        value={expiryBlock}
        onChange={setExpiryBlock}
        placeholder="0"
        inputMode="numeric"
      />

      {validationError && <p className="text-sm text-red-400">{validationError}</p>}

      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all disabled:opacity-50"
      >
        {isSubmitting ? 'Submitting Proposal...' : 'Submit Proposal'}
      </button>
    </form>
  );
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
        className={`w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors ${
          mono ? 'font-mono' : ''
        }`}
        required={required}
      />
    </div>
  );
}
