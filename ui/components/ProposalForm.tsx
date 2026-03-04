'use client';

import { useState } from 'react';
import { NewProposalInput, TxType } from '@/lib/types';

interface ProposalFormProps {
  owners: string[];
  currentThreshold: number;
  numOwners: number;
  onSubmit: (data: NewProposalInput) => void;
  isSubmitting: boolean;
}

/** Dynamic proposal form that maps UI inputs to MinaGuard tx type payloads. */
export default function ProposalForm({
  owners,
  currentThreshold,
  numOwners,
  onSubmit,
  isSubmitting,
}: ProposalFormProps) {
  const [txType, setTxType] = useState<TxType>('transfer');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [removeOwnerAddress, setRemoveOwnerAddress] = useState('');
  const [newThreshold, setNewThreshold] = useState(Math.max(1, currentThreshold));
  const [delegate, setDelegate] = useState('');
  const [undelegate, setUndelegate] = useState(false);
  const [expiryBlock, setExpiryBlock] = useState('0');

  /** Emits normalized form payload according to the selected transaction type. */
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    onSubmit({
      txType,
      to: txType === 'transfer' ? to : undefined,
      amount: txType === 'transfer' ? amount : undefined,
      newOwner: txType === 'addOwner' ? newOwner : undefined,
      removeOwnerAddress: txType === 'removeOwner' ? removeOwnerAddress : undefined,
      newThreshold: txType === 'changeThreshold' ? newThreshold : undefined,
      delegate: txType === 'setDelegate' && !undelegate ? delegate : undefined,
      undelegate: txType === 'setDelegate' ? undelegate : undefined,
      expiryBlock: Number(expiryBlock) > 0 ? Number(expiryBlock) : 0,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label className="block text-sm text-safe-text mb-2">Transaction Type</label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: 'transfer', label: 'Send MINA' },
            { value: 'addOwner', label: 'Add Owner' },
            { value: 'removeOwner', label: 'Remove Owner' },
            { value: 'changeThreshold', label: 'Change Threshold' },
            { value: 'setDelegate', label: 'Set Delegate' },
          ].map((type) => (
            <button
              key={type.value}
              type="button"
              onClick={() => setTxType(type.value as TxType)}
              className={`p-3 rounded-lg border text-sm text-left transition-colors ${
                txType === type.value
                  ? 'border-safe-green text-safe-green bg-safe-hover'
                  : 'border-safe-border text-safe-text hover:border-safe-text'
              }`}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>

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
              Removing one owner would break current threshold constraints.
            </p>
          )}
        </div>
      )}

      {txType === 'changeThreshold' && (
        <div>
          <label className="block text-sm text-safe-text mb-2">New Threshold</label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max={Math.max(1, numOwners)}
              value={newThreshold}
              onChange={(e) => setNewThreshold(parseInt(e.target.value, 10))}
              className="flex-1 accent-safe-green"
            />
            <span className="text-2xl font-mono text-safe-green min-w-[3ch] text-center">
              {newThreshold}
            </span>
            <span className="text-sm text-safe-text">of {numOwners} owners</span>
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
