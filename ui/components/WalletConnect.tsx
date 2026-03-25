'use client';

import { useState, useRef, useEffect } from 'react';
import { truncateAddress, type WalletType } from '@/lib/types';
import LedgerConnectModal from './LedgerConnectModal';

const LEDGER_NETWORKS = [
  { label: 'Mainnet', id: 1 },
  { label: 'Devnet', id: 0 },
  { label: 'Testnet', id: 0 },
] as const;

interface WalletConnectProps {
  address: string | null;
  connected: boolean;
  isLoading: boolean;
  auroInstalled: boolean;
  ledgerSupported: boolean;
  walletType: WalletType | null;
  network: string | null;
  onConnect: () => void;
  onConnectAuro: () => void;
  onConnectLedger: (accountIndex?: number) => void;
  onDisconnect: () => void;
  onNetworkChange?: (network: string, ledgerNetworkId: number) => void;
}

export default function WalletConnect({
  address,
  connected,
  isLoading,
  auroInstalled,
  ledgerSupported,
  walletType,
  network,
  onConnect,
  onConnectAuro,
  onConnectLedger,
  onDisconnect,
  onNetworkChange,
}: WalletConnectProps) {
  const [copied, setCopied] = useState(false);
  const [showLedgerModal, setShowLedgerModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  const handleCopy = () => {
    if (!address) return;
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const networkLabel = network
    ? network.charAt(0).toUpperCase() + network.slice(1)
    : 'Unknown';

  if (connected && address) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 bg-safe-gray border border-safe-border rounded-lg px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-safe-green" />
          <span className="text-[10px] text-safe-text uppercase tracking-wider">
            {walletType === 'ledger' ? 'Ledger' : 'Auro'}
          </span>
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
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowMenu((prev) => !prev)}
            className="text-xs text-safe-text hover:text-white transition-colors flex items-center gap-1"
          >
            {networkLabel}
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showMenu && (
            <div className="absolute right-0 top-full mt-1 bg-safe-dark border border-safe-border rounded-lg py-1 min-w-[140px] z-50 shadow-lg">
              {walletType === 'ledger' && onNetworkChange && (
                <>
                  {LEDGER_NETWORKS.map(({ label, id }) => (
                    <button
                      key={label}
                      onClick={() => {
                        onNetworkChange(label.toLowerCase(), id);
                        setShowMenu(false);
                      }}
                      className={`w-full text-left text-xs px-3 py-1.5 transition-colors ${
                        networkLabel === label
                          ? 'text-safe-green'
                          : 'text-safe-text hover:text-white hover:bg-safe-hover'
                      }`}
                    >
                      {label}
                      {networkLabel === label && ' ✓'}
                    </button>
                  ))}
                  <div className="border-t border-safe-border my-1" />
                </>
              )}
              <button
                onClick={() => {
                  setShowMenu(false);
                  onDisconnect();
                }}
                className="w-full text-left text-xs px-3 py-1.5 text-red-400 hover:text-red-300 hover:bg-safe-hover transition-colors"
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Show spinner while connecting
  if (isLoading) {
    return (
      <button
        disabled
        className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold text-sm rounded-lg px-4 py-2.5 opacity-50"
      >
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
      </button>
    );
  }

  // Show wallet selection buttons when both options are available
  if (auroInstalled && ledgerSupported) {
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={onConnectAuro}
          className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold text-sm rounded-lg px-4 py-2.5 hover:brightness-110 transition-all"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          Connect Auro
        </button>
        <button
          onClick={() => setShowLedgerModal(true)}
          className="flex items-center gap-2 bg-safe-gray border border-safe-border text-white font-semibold text-sm rounded-lg px-4 py-2.5 hover:bg-safe-hover transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Connect Ledger
        </button>
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

  // Fallback: single connect button (Auro only or install prompt)
  return (
    <button
      onClick={onConnect}
      className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold text-sm rounded-lg px-4 py-2.5 hover:brightness-110 transition-all"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
      </svg>
      {auroInstalled ? 'Connect Wallet' : 'Install Auro'}
    </button>
  );
}
