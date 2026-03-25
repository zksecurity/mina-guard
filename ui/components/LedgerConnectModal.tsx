'use client';

import { useState } from 'react';

interface LedgerConnectModalProps {
  onConfirm: (accountIndex: number) => void;
  onClose: () => void;
}

export default function LedgerConnectModal({ onConfirm, onClose }: LedgerConnectModalProps) {
  const [accountIndex, setAccountIndex] = useState(0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-safe-dark border border-safe-border rounded-xl w-full max-w-sm mx-4 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">
            Connect Ledger
          </h3>
          <button
            onClick={onClose}
            className="text-safe-text hover:text-white text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-safe-text">Account Index</span>
          <input
            type="number"
            min={0}
            value={accountIndex}
            onChange={(e) => setAccountIndex(Math.max(0, parseInt(e.target.value, 10) || 0))}
            className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm focus:border-safe-green focus:outline-none"
          />
        </label>

        <div className="flex gap-3 pt-2">
          <button
            onClick={onClose}
            className="flex-1 bg-safe-gray border border-safe-border text-white font-semibold rounded-lg px-4 py-2.5 text-sm hover:bg-safe-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(accountIndex)}
            className="flex-1 bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2.5 text-sm hover:brightness-110 transition-all"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
