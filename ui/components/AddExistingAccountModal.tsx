'use client';

import { useState } from 'react';
import { subscribeAddress } from '@/lib/api';

interface AddExistingAccountModalProps {
  onClose: () => void;
  onSubmitted: (address: string) => void;
}

function validateAddress(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return 'Contract address is required.';
  if (!trimmed.startsWith('B62') || trimmed.length < 50) {
    return 'Invalid Mina address (must start with B62).';
  }
  return null;
}

export default function AddExistingAccountModal({
  onClose,
  onSubmitted,
}: AddExistingAccountModalProps) {
  const [address, setAddress] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const validationError = validateAddress(address);
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setSubmitting(true);
    const trimmed = address.trim();
    const result = await subscribeAddress(trimmed, 0);
    if (result.ok) {
      onSubmitted(trimmed);
    } else {
      setError(result.error ?? 'Failed to subscribe. Try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-safe-dark border border-safe-border rounded-xl w-full max-w-sm mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">
            Add existing account
          </h3>
          <button
            onClick={onClose}
            disabled={submitting}
            className="text-safe-text hover:text-white text-lg leading-none disabled:opacity-50"
          >
            &times;
          </button>
        </div>

        <p className="text-xs text-safe-text">
          Paste a MinaGuard contract address to sync.
        </p>

        <label className="block space-y-1">
          <span className="text-xs text-safe-text">Contract address</span>
          <input
            type="text"
            value={address}
            onChange={(e) => {
              setAddress(e.target.value);
              if (error) setError(null);
            }}
            placeholder="B62..."
            autoFocus
            spellCheck={false}
            disabled={submitting}
            className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono focus:border-safe-green focus:outline-none disabled:opacity-50"
          />
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 bg-safe-gray border border-safe-border text-white font-semibold rounded-lg px-4 py-2.5 text-sm hover:bg-safe-hover transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2.5 text-sm hover:brightness-110 transition-all disabled:opacity-50"
          >
            {submitting ? 'Subscribing…' : 'Add account'}
          </button>
        </div>
      </div>
    </div>
  );
}
