'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { useAppContext } from '@/lib/app-context';
import { deployContract, generateKeypair } from '@/lib/multisigClient';

/** Deploy page for initializing new MinaGuard contracts from browser wallet session. */
export default function DeployPage() {
  const router = useRouter();
  const {
    wallet,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
    startOperation,
    isOperating,
  } = useAppContext();

  const [keypair, setKeypair] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [generating, setGenerating] = useState(false);

  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const kp = await generateKeypair();
      setKeypair(kp);
    } finally {
      setGenerating(false);
    }
  }, []);

  useEffect(() => {
    if (wallet.connected && !keypair && !generating) {
      generate();
    }
  }, [wallet.connected, keypair, generating, generate]);

  const handleDeploy = () => {
    if (!wallet.address || !keypair) return;

    const captured = { feePayerAddress: wallet.address, zkAppPrivateKeyBase58: keypair.privateKey };
    startOperation('Building deploy transaction...', (onProgress) =>
      deployContract({
        feePayerAddress: captured.feePayerAddress,
        zkAppPrivateKeyBase58: captured.zkAppPrivateKeyBase58,
      }, onProgress)
    );
    router.push('/');
  };

  return (
    <div>
      <Header
        title="Deploy"
        subtitle="Deploy new MinaGuard contracts"
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6 max-w-3xl space-y-6">
        {!wallet.connected ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect wallet to deploy MinaGuard.</p>
          </div>
        ) : (
          <section className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">Deploy Contract</h3>
            <p className="text-xs text-safe-text">
              A random keypair will be generated for the contract address. Your connected wallet pays the deployment fee.
            </p>

            {generating ? (
              <div className="flex items-center gap-2 py-3">
                <span className="animate-spin w-4 h-4 border-2 border-safe-green border-t-transparent rounded-full" />
                <span className="text-sm text-safe-text">Generating keypair...</span>
              </div>
            ) : keypair ? (
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-safe-text mb-1">Contract Address</p>
                  <p className="text-sm font-mono break-all bg-safe-dark border border-safe-border rounded-lg px-3 py-2">
                    {keypair.publicKey}
                  </p>
                </div>
                <button
                  onClick={generate}
                  className="text-xs text-safe-green hover:underline"
                >
                  Regenerate
                </button>
              </div>
            ) : null}

            <button
              disabled={!keypair || isOperating}
              onClick={handleDeploy}
              className="bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-60"
            >
              Deploy MinaGuard
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
