'use client';

import { useState, useEffect, useCallback } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001';
const MINA_ENDPOINT = process.env.NEXT_PUBLIC_MINA_ENDPOINT ?? '';
const FAUCET_URL = 'https://faucet.minaprotocol.com';
const LOW_BALANCE_THRESHOLD = 5e9; // 5 MINA in nanomina

interface TestnetFundButtonProps {
  address: string;
  network: string;
  explorerUrl?: string;
}

async function fetchBalance(address: string): Promise<number | null> {
  if (!MINA_ENDPOINT) return null;
  try {
    const res = await fetch(MINA_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ account(publicKey: "${address}") { balance { total } } }`,
      }),
    });
    const json = await res.json();
    const total = json?.data?.account?.balance?.total;
    return total != null ? Number(total) : 0;
  } catch {
    return null;
  }
}

export default function TestnetFundButton({ address, network, explorerUrl }: TestnetFundButtonProps) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [txHash, setTxHash] = useState('');
  const [lowBalance, setLowBalance] = useState(false);

  const checkBalance = useCallback(async () => {
    const balance = await fetchBalance(address);
    setLowBalance(balance !== null && balance < LOW_BALANCE_THRESHOLD);
  }, [address]);

  useEffect(() => {
    checkBalance();
  }, [checkBalance]);

  const handleFund = async () => {
    if (network === 'devnet') {
      window.open(FAUCET_URL, '_blank', 'noopener,noreferrer');
      return;
    }

    setStatus('loading');
    setMessage('');
    setTxHash('');

    try {
      const res = await fetch(`${API_BASE}/api/fund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus('error');
        setMessage(data.error ?? 'Funding failed.');
        return;
      }

      setStatus('success');
      setTxHash(data.txHash ?? '');
      setMessage('Funded!');
      // Re-check balance after a short delay to allow inclusion
      setTimeout(checkBalance, 5000);
    } catch {
      setStatus('error');
      setMessage('Backend unreachable.');
    }
  };

  return (
    <div className="relative">
      <button
        onClick={handleFund}
        disabled={status === 'loading'}
        title={network === 'testnet' ? 'Fund this Vault via lightnet manager' : 'Open Mina faucet'}
        className={`flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-2 transition-all ${
          status === 'loading'
            ? 'bg-safe-gray border border-safe-border text-safe-text opacity-60 cursor-wait'
            : status === 'success'
              ? 'bg-safe-green/15 border border-safe-green/30 text-safe-green'
              : status === 'error'
                ? 'bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/20'
                : lowBalance
                  ? 'bg-red-500/15 border border-red-500/30 text-red-400 hover:bg-red-500/20'
                  : 'bg-safe-gray border border-safe-border text-safe-text hover:text-white hover:bg-safe-hover'
        }`}
      >
        {status === 'loading' ? (
          <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        )}
        {status === 'loading' ? 'Funding...' : 'Fund MINA'}
      </button>
      {message && (
        <div
          className={`absolute top-full right-0 mt-1 text-[10px] whitespace-nowrap px-2 py-1 rounded flex items-center gap-1 ${
            status === 'success' ? 'bg-safe-green/10 text-safe-green' : status === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-safe-gray text-safe-text'
          }`}
        >
          <span>
            {message}
            {txHash && explorerUrl && (
              <>
                {' '}
                <a
                  href={`${explorerUrl}/tx/${txHash}?network=${network ?? ''}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:opacity-70"
                >
                  {txHash.slice(0, 12)}...
                </a>
              </>
            )}
          </span>
          <button
            onClick={() => { setMessage(''); setStatus('idle'); }}
            className="hover:opacity-70"
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
