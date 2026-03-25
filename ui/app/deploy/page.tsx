'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Header from '@/components/Header';
import { useAppContext } from '@/lib/app-context';
import { deployAndSetupContract, generateKeypair } from '@/lib/multisigClient';

/** Deploy page for initializing new MinaGuard contracts from browser wallet session. */
export default function DeployPage() {
  const router = useRouter();
  const {
    wallet,
    connect,
    connectAuro,
    connectLedger,
    disconnect,
    isLoading,
    auroInstalled,
    ledgerSupported,
    setWalletNetwork,
    startOperation,
    isOperating,
  } = useAppContext();

  const [keypair, setKeypair] = useState<{ privateKey: string; publicKey: string } | null>(null);
  const [generating, setGenerating] = useState(false);

  // Setup fields
  const [ownerFields, setOwnerFields] = useState<string[]>(['']);
  const [threshold, setThreshold] = useState('1');
  const [networkId, setNetworkId] = useState(wallet.network === 'mainnet' ? '1' : '0');
  const [formError, setFormError] = useState<string | null>(null);

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

  useEffect(() => {
    if (wallet.address) {
      setOwnerFields([wallet.address]);
    }
  }, [wallet.address]);

  const parsedOwners = useMemo(
    () => ownerFields.map((s) => s.trim()).filter(Boolean),
    [ownerFields]
  );

  const validate = (): string | null => {
    if (parsedOwners.length === 0) return 'Add at least one owner address.';
    const invalid = parsedOwners.find((addr) => !addr.startsWith('B62') || addr.length < 50);
    if (invalid) return `Invalid address: ${invalid.slice(0, 20)}...`;
    const unique = new Set(parsedOwners);
    if (unique.size !== parsedOwners.length) return 'Duplicate owner addresses.';
    if (parsedOwners.length > 20) return 'Maximum 20 owners allowed.';
    const t = Number(threshold);
    if (!t || t < 1) return 'Threshold must be at least 1.';
    if (t > parsedOwners.length) return `Threshold (${t}) cannot exceed number of owners (${parsedOwners.length}).`;
    if (!networkId.trim()) return 'Network ID is required.';
    return null;
  };

  const handleDeploy = () => {
    const error = validate();
    if (error) { setFormError(error); return; }
    if (!wallet.address || !keypair) return;

    setFormError(null);
    const captured = {
      feePayerAddress: wallet.address,
      zkAppPrivateKeyBase58: keypair.privateKey,
      owners: parsedOwners,
      threshold: Number(threshold),
      networkId,
    };
    const signer = wallet.type ? { type: wallet.type, ledgerAccountIndex: wallet.ledgerAccountIndex } : undefined;
    void startOperation('Building deploy transaction...', async (onProgress) => {
      return await deployAndSetupContract(captured, onProgress, signer);
    });
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
        ledgerSupported={ledgerSupported}
        walletType={wallet.type}
        onConnect={connect}
        onConnectAuro={connectAuro}
        onConnectLedger={connectLedger}
        onDisconnect={disconnect}
        network={wallet.network}
        onNetworkChange={setWalletNetwork}
      />

      <div className="p-6 max-w-3xl space-y-6">
        {!wallet.connected ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect wallet to deploy MinaGuard.</p>
          </div>
        ) : (
          <section className="bg-safe-gray border border-safe-border rounded-xl p-6 space-y-5">
            <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">Deploy Contract</h3>
            <p className="text-xs text-safe-text">
              A random keypair will be generated for the contract address. Your connected wallet pays the deployment fee.
              The contract will be deployed and initialized in a single transaction.
            </p>

            {/* Contract address */}
            {generating ? (
              <div className="flex items-center gap-2 py-3">
                <span className="animate-spin w-4 h-4 border-2 border-safe-green border-t-transparent rounded-full" />
                <span className="text-sm text-safe-text">Generating keypair...</span>
              </div>
            ) : keypair ? (
              <div className="space-y-1">
                <p className="text-xs text-safe-text">Contract Address</p>
                <p className="text-sm font-mono break-all bg-safe-dark border border-safe-border rounded-lg px-3 py-2">
                  {keypair.publicKey}
                </p>
                <button onClick={generate} className="text-xs text-safe-green hover:underline">
                  Regenerate
                </button>
              </div>
            ) : null}

            {/* Owners */}
            <div className="space-y-2">
              <span className="text-xs text-safe-text">Owners</span>
              {ownerFields.map((value, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => {
                      const next = [...ownerFields];
                      next[i] = e.target.value;
                      setOwnerFields(next);
                      setFormError(null);
                    }}
                    placeholder={`Owner ${i + 1} address (B62...)`}
                    className="flex-1 bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm font-mono"
                  />
                  {ownerFields.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setOwnerFields(ownerFields.filter((_, j) => j !== i))}
                      className="text-safe-text hover:text-red-400 px-2 text-lg leading-none"
                    >
                      &times;
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={() => setOwnerFields([...ownerFields, ''])}
                className="text-xs text-safe-green hover:underline"
              >
                + Add owner
              </button>
            </div>

            {/* Threshold + Network ID */}
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-safe-text">Threshold</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={threshold}
                  onChange={(e) => { setThreshold(e.target.value); setFormError(null); }}
                  className="w-full bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-safe-text">Network ID</span>
                <input
                  type="text"
                  value={networkId}
                  onChange={(e) => { setNetworkId(e.target.value.trim()); setFormError(null); }}
                  className="w-full bg-safe-dark border border-safe-border rounded-lg px-4 py-3 text-sm"
                />
                <p className="text-xs text-safe-text">
                  Mainnet: <code className="font-mono">1</code> · Devnet: <code className="font-mono">0</code> · Testnet: <code className="font-mono">0</code>
                </p>
              </label>
            </div>

            {formError && <p className="text-sm text-red-400">{formError}</p>}

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
