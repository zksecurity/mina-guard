'use client';

export default function LedgerSigningModal() {
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
          Check Your Ledger
        </h3>

        <p className="text-sm text-safe-text">
          Please review and confirm the transaction on your Ledger device.
        </p>

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
