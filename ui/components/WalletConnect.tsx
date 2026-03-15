'use client';

import { useState } from 'react';
import { truncateAddress } from '@/lib/types';

interface WalletConnectProps {
  address: string | null;
  connected: boolean;
  isLoading: boolean;
  auroInstalled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}

export default function WalletConnect({
  address,
  connected,
  isLoading,
  auroInstalled,
  onConnect,
  onDisconnect,
}: WalletConnectProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (connected && address) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 bg-safe-gray border border-safe-border rounded-lg px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-safe-green" />
          <span className="text-sm font-mono">
            {truncateAddress(address)}
          </span>
          <button
            onClick={handleCopy}
            title="Copy address"
            className="text-safe-text hover:text-white transition-colors ml-1"
          >
            {copied ? (
              <svg className="w-3.5 h-3.5 text-safe-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            )}
          </button>
        </div>
        <button
          onClick={onDisconnect}
          className="text-xs text-safe-text hover:text-white transition-colors"
        >
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={onConnect}
      disabled={isLoading}
      className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold text-sm rounded-lg px-4 py-2.5 hover:brightness-110 transition-all disabled:opacity-50"
    >
      {isLoading ? (
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
          Connecting...
        </>
      ) : (
        <>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          {auroInstalled ? 'Connect Wallet' : 'Install Auro'}
        </>
      )}
    </button>
  );
}
