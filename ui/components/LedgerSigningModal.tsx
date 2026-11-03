'use client';

import type { LedgerSigningContext } from '@/lib/multisigClient';

/**
 * Blocks the page while the Ledger is in use. When signing, MinaGuard sends
 * the device a single 32-byte value (a hash of the approval or of the whole
 * transaction), so the device cannot show recipients, amounts, fee or memo.
 * The modal says so and shows the same hash the device shows, so the user can
 * check that the device is signing what this screen prepared.
 */
export default function LedgerSigningModal({ context = 'signing', hash }: { context?: LedgerSigningContext; hash?: string }) {
  const isConnecting = context === 'connecting';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-safe-dark border border-safe-border rounded-xl w-full max-w-sm mx-4 p-6 space-y-4 text-center">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-full bg-safe-green/10 border border-safe-green/30 flex items-center justify-center animate-pulse">
            <svg className="w-8 h-8 text-safe-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
        </div>

        <h3 className="text-sm font-semibold uppercase tracking-wider text-white">
          {isConnecting ? 'Connecting to Ledger' : 'Check Your Ledger'}
        </h3>

        {isConnecting ? (
          <p className="text-sm text-safe-text">Reading address from your Ledger device...</p>
        ) : (
          <>
            <p className="text-sm text-safe-text">
              Your Ledger shows only a hash, not the recipients, amounts, fee or memo. Check those details on this
              page before you sign. On the device, confirm only if the hash it shows matches the one below.
            </p>
            {hash && (
              <div className="text-left space-y-1">
                <p className="text-xs text-safe-text/70">Hash your Ledger should show:</p>
                <code data-testid="ledger-hash" className="block font-mono text-xs text-white break-all bg-safe-gray border border-safe-border rounded-lg px-3 py-2">
                  {hash}
                </code>
              </div>
            )}
          </>
        )}

        <p className="text-xs text-safe-text/70">
          This may take a few seconds to process.
        </p>

        <div className="flex justify-center pt-2">
          <span className="animate-spin w-5 h-5 border-2 border-safe-green border-t-transparent rounded-full" />
        </div>
      </div>
    </div>
  );
}
