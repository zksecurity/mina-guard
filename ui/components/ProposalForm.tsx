'use client';

import { useState } from 'react';
import { TxType } from '@/lib/types';

interface ProposalFormProps {
  owners: string[];
  currentThreshold: number;
  numOwners: number;
  onSubmit: (data: ProposalData) => void;
  isSubmitting: boolean;
}

export interface ProposalData {
  txType: TxType;
  to: string;
  amount: string;
  newOwner?: string;
  removeOwnerAddress?: string;
  newThreshold?: number;
}

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
  const [newThreshold, setNewThreshold] = useState(currentThreshold);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      txType,
      to,
      amount,
      newOwner: txType === 'addOwner' ? newOwner : undefined,
      removeOwnerAddress:
        txType === 'removeOwner' ? removeOwnerAddress : undefined,
      newThreshold:
        txType === 'changeThreshold' ? newThreshold : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Transaction Type Selector */}
      <div>
        <label className="block text-sm text-safe-text mb-2">
          Transaction Type
        </label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { value: 'transfer', label: 'Send MINA' },
            { value: 'addOwner', label: 'Add Owner' },
            { value: 'removeOwner', label: 'Remove Owner' },
            { value: 'changeThreshold', label: 'Change Threshold' },
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

      {/* Transfer Fields */}
      {txType === 'transfer' && (
        <>
          <div>
            <label className="block text-sm text-safe-text mb-2">
              Recipient Address
            </label>
            <input
              type="text"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="B62q..."
              className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
              required
            />
          </div>
          <div>
            <label className="block text-sm text-safe-text mb-2">
              Amount (MINA)
            </label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.0"
              step="0.000000001"
              min="0"
              className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
              required
            />
          </div>
        </>
      )}

      {/* Add Owner Fields */}
      {txType === 'addOwner' && (
        <div>
          <label className="block text-sm text-safe-text mb-2">
            New Owner Address
          </label>
          <input
            type="text"
            value={newOwner}
            onChange={(e) => setNewOwner(e.target.value)}
            placeholder="B62q..."
            className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono placeholder:text-safe-border focus:outline-none focus:border-safe-green transition-colors"
            required
          />
        </div>
      )}

      {/* Remove Owner Fields */}
      {txType === 'removeOwner' && (
        <div>
          <label className="block text-sm text-safe-text mb-2">
            Select Owner to Remove
          </label>
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
                    removeOwnerAddress === owner
                      ? 'border-red-400'
                      : 'border-safe-border'
                  }`}
                >
                  {removeOwnerAddress === owner && (
                    <div className="w-2 h-2 rounded-full bg-red-400" />
                  )}
                </div>
                <span className="text-sm font-mono text-safe-text">
                  {owner}
                </span>
              </label>
            ))}
          </div>
          {numOwners - 1 < currentThreshold && (
            <p className="text-xs text-red-400 mt-2">
              Cannot remove: would go below threshold ({currentThreshold})
            </p>
          )}
        </div>
      )}

      {/* Change Threshold Fields */}
      {txType === 'changeThreshold' && (
        <div>
          <label className="block text-sm text-safe-text mb-2">
            New Threshold
          </label>
          <div className="flex items-center gap-4">
            <input
              type="range"
              min="1"
              max={numOwners}
              value={newThreshold}
              onChange={(e) => setNewThreshold(parseInt(e.target.value))}
              className="flex-1 accent-safe-green"
            />
            <span className="text-2xl font-mono text-safe-green min-w-[3ch] text-center">
              {newThreshold}
            </span>
            <span className="text-sm text-safe-text">
              of {numOwners} owners
            </span>
          </div>
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isSubmitting}
        className="w-full bg-safe-green text-safe-dark font-semibold rounded-lg py-3 text-sm hover:brightness-110 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {isSubmitting ? (
          <>
            <svg
              className="animate-spin h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            Creating Proposal...
          </>
        ) : (
          'Submit Proposal'
        )}
      </button>
    </form>
  );
}
