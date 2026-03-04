'use client';

import { useMemo, useState } from 'react';
import Header from '@/components/Header';
import { useAppContext } from '@/lib/app-context';
import { deployContract, setupContract } from '@/lib/multisigClient';

/** Deploy and setup page for initializing new MinaGuard contracts from browser wallet session. */
export default function DeployPage() {
  const {
    wallet,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
    refreshMultisig,
  } = useAppContext();

  const [zkAppPrivateKey, setZkAppPrivateKey] = useState('');
  const [existingAddress, setExistingAddress] = useState('');
  const [ownersText, setOwnersText] = useState('');
  const [threshold, setThreshold] = useState('2');
  const [networkId, setNetworkId] = useState('1');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const owners = useMemo(() => {
    return ownersText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }, [ownersText]);

  /** Deploys a fresh MinaGuard contract using in-memory zkApp private key. */
  const handleDeploy = async () => {
    if (!wallet.address || !zkAppPrivateKey) return;

    setIsSubmitting(true);
    setError(null);
    setTxHash(null);

    try {
      const hash = await deployContract({
        feePayerAddress: wallet.address,
        zkAppPrivateKeyBase58: zkAppPrivateKey,
      });
      if (!hash) {
        setError('Deploy transaction failed.');
        return;
      }
      setTxHash(hash);
    } catch (deployError) {
      setError(deployError instanceof Error ? deployError.message : 'Deploy failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  /** Runs one-time setup for a deployed contract with owners, threshold, and network id. */
  const handleSetup = async () => {
    if (!wallet.address || !existingAddress || owners.length === 0) return;

    setIsSubmitting(true);
    setError(null);
    setTxHash(null);

    try {
      const hash = await setupContract({
        zkAppAddress: existingAddress,
        feePayerAddress: wallet.address,
        owners,
        threshold: Number(threshold),
        networkId,
      });
      if (!hash) {
        setError('Setup transaction failed.');
        return;
      }
      setTxHash(hash);
      await refreshMultisig();
    } catch (setupError) {
      setError(setupError instanceof Error ? setupError.message : 'Setup failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div>
      <Header
        title="Deploy / Setup"
        subtitle="Initialize MinaGuard contracts and bootstrap owner sets"
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
            <p className="text-safe-text">Connect wallet to deploy or setup MinaGuard.</p>
          </div>
        ) : (
          <>
            <section className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">Deploy Contract</h3>
              <p className="text-xs text-safe-text">
                zkApp private key is used only in this browser session and never sent to backend.
              </p>
              <input
                type="password"
                value={zkAppPrivateKey}
                onChange={(e) => setZkAppPrivateKey(e.target.value.trim())}
                placeholder="EKF... (zkApp private key)"
                className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono"
              />
              <button
                disabled={isSubmitting || !zkAppPrivateKey}
                onClick={handleDeploy}
                className="bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-60"
              >
                {isSubmitting ? 'Submitting...' : 'Deploy MinaGuard'}
              </button>
            </section>

            <section className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">Setup Contract</h3>
              <input
                type="text"
                value={existingAddress}
                onChange={(e) => setExistingAddress(e.target.value.trim())}
                placeholder="Contract address (B62...)"
                className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono"
              />
              <textarea
                value={ownersText}
                onChange={(e) => setOwnersText(e.target.value)}
                placeholder="One owner address per line"
                rows={6}
                className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  placeholder="Threshold"
                  className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm"
                />
                <input
                  type="text"
                  value={networkId}
                  onChange={(e) => setNetworkId(e.target.value.trim())}
                  placeholder="Network ID"
                  className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm"
                />
              </div>

              <button
                disabled={isSubmitting || !existingAddress || owners.length === 0}
                onClick={handleSetup}
                className="bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2 text-sm disabled:opacity-60"
              >
                {isSubmitting ? 'Submitting...' : 'Run Setup'}
              </button>
            </section>

            {txHash && <p className="text-sm text-safe-green">Submitted tx hash: {txHash}</p>}
            {error && <p className="text-sm text-red-400">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
