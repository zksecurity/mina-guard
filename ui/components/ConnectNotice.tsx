'use client';

import { useState } from 'react';
import LedgerConnectModal from './LedgerConnectModal';

interface ConnectNoticeProps {
  onConnectAuro: () => void;
  onConnectLedger: (accountIndex?: number) => void;
  auroInstalled: boolean;
  ledgerSupported: boolean;
  error: string | null;
  onClearError: () => void;
}

/** Connect-wallet empty state shown when no wallet session is active. */
export default function ConnectNotice({
  onConnectAuro,
  onConnectLedger,
  auroInstalled,
  ledgerSupported,
  error,
  onClearError,
}: ConnectNoticeProps) {
  const [showLedgerModal, setShowLedgerModal] = useState(false);

  return (
    <div className="text-center py-20">
      <h3 className="text-lg font-semibold mb-2">Connect your wallet</h3>
      <p className="text-sm text-safe-text mb-6 max-w-sm mx-auto">
        Connect with Auro Wallet or Ledger to create and approve MinaGuard proposals.
      </p>
      {error && (
        <div className="flex items-center justify-center gap-2 mb-4 mx-auto max-w-md rounded-lg px-4 py-3 text-sm bg-red-500/10 text-red-400 border border-red-500/30">
          <span>{error}</span>
          <button onClick={onClearError} className="ml-2 shrink-0 hover:opacity-70">&times;</button>
        </div>
      )}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={onConnectAuro}
          className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {auroInstalled ? 'Connect Auro' : 'Install Auro'}
        </button>
        {ledgerSupported && (
          <button
            onClick={() => setShowLedgerModal(true)}
            className="flex items-center gap-2 bg-safe-gray border border-safe-border text-white font-semibold rounded-lg px-6 py-3 text-sm hover:bg-safe-hover transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            Connect Ledger
          </button>
        )}
      </div>
      {showLedgerModal && (
        <LedgerConnectModal
          onConfirm={(accountIndex) => {
            setShowLedgerModal(false);
            onConnectLedger(accountIndex);
          }}
          onClose={() => setShowLedgerModal(false)}
        />
      )}
    </div>
  );
}
