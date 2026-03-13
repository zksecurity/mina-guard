'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import ThresholdBadge from '@/components/ThresholdBadge';
import TransactionList from '@/components/TransactionList';
import { truncateAddress, formatMina, type NewProposalInput } from '@/lib/types';
import { setupContract, createProposeTx } from '@/lib/multisigClient';
import { fetchBalance } from '@/lib/api';
import ProposalForm from '@/components/ProposalForm';
import Link from 'next/link';

/** Dashboard overview page for selected contract and latest indexed proposals. */
export default function Dashboard() {
  const {
    wallet,
    multisig,
    owners,
    proposals,
    indexerStatus,
    connect,
    disconnect,
    isLoading,
    auroInstalled,
    isOperating,
    operationLabel,
    operationBanner,
    clearBanner,
    startOperation,
  } = useAppContext();

  const recent = [...proposals].slice(0, 5);

  // Setup Contract modal state
  const [showSetup, setShowSetup] = useState(false);
  const [ownerFields, setOwnerFields] = useState<string[]>(['']);
  const [threshold, setThreshold] = useState('2');
  const [networkId, setNetworkId] = useState('1');
  const [setupError, setSetupError] = useState<string | null>(null);

  // New Proposal modal state
  const [showProposal, setShowProposal] = useState(false);

  // Wallet balance
  const [balance, setBalance] = useState<string | null>(null);

  useEffect(() => {
    if (!wallet.address) return;
    fetchBalance(wallet.address).then((b) => setBalance(b));
  }, [wallet.address]);

  const parsedOwners = useMemo(() => {
    return ownerFields.map((s) => s.trim()).filter(Boolean);
  }, [ownerFields]);

  const validateSetup = (): string | null => {
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

  const handleSetup = () => {
    const error = validateSetup();
    if (error) {
      setSetupError(error);
      return;
    }
    if (!wallet.address || !multisig?.address) return;

    setSetupError(null);
    setShowSetup(false);

    const captured = { address: multisig.address, feePayer: wallet.address, owners: parsedOwners, threshold: Number(threshold), networkId };
    startOperation('Building setup transaction...', (onProgress) =>
      setupContract({
        zkAppAddress: captured.address,
        feePayerAddress: captured.feePayer,
        owners: captured.owners,
        threshold: captured.threshold,
        networkId: captured.networkId,
      }, onProgress)
    );
  };

  const handleProposalSubmit = (data: NewProposalInput) => {
    if (!wallet.address || !multisig) return;

    setShowProposal(false);

    const captured = { contractAddress: multisig.address, proposerAddress: wallet.address };
    startOperation('Building proposal transaction...', (onProgress) =>
      createProposeTx({
        contractAddress: captured.contractAddress,
        proposerAddress: captured.proposerAddress,
        input: data,
      }, onProgress)
    );
  };

  return (
    <div>
      <Header
        title="Dashboard"
        subtitle="Overview of indexed MinaGuard multisig activity"
        walletAddress={wallet.address}
        connected={wallet.connected}
        isLoading={isLoading}
        auroInstalled={auroInstalled}
        onConnect={connect}
        onDisconnect={disconnect}
      />

      <div className="p-6">
        {operationBanner && (
          <div
            className={`flex items-center justify-between rounded-lg px-4 py-3 mb-4 text-sm ${
              operationBanner.type === 'success'
                ? 'bg-safe-green/10 text-safe-green border border-safe-green/30'
                : 'bg-red-500/10 text-red-400 border border-red-500/30'
            }`}
          >
            <span className="font-mono text-xs break-all">{operationBanner.message}</span>
            <button onClick={clearBanner} className="ml-3 shrink-0 hover:opacity-70">
              &times;
            </button>
          </div>
        )}

        {isOperating && (
          <div className="flex items-center gap-2 rounded-lg px-4 py-3 mb-4 text-sm bg-safe-gray border border-safe-border">
            <span className="animate-spin w-4 h-4 border-2 border-safe-green border-t-transparent rounded-full" />
            <span className="text-safe-text">{operationLabel}</span>
          </div>
        )}

        {!wallet.connected ? (
          <ConnectNotice onConnect={connect} auroInstalled={auroInstalled} />
        ) : multisig ? (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Contract</p>
                <p className="text-sm font-mono">{truncateAddress(multisig.address, 10)}</p>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Threshold</p>
                <div className="flex items-center gap-3 mt-2">
                  <ThresholdBadge
                    threshold={multisig.threshold ?? 0}
                    numOwners={multisig.numOwners ?? owners.length}
                    size="lg"
                  />
                  <span className="text-xs text-safe-text">required approvals</span>
                </div>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Wallet Balance</p>
                <p className="text-lg font-semibold mt-1">
                  {balance !== null ? formatMina(balance) : '-'}{' '}
                  <span className="text-sm text-safe-text font-normal">MINA</span>
                </p>
              </div>

              <div className="bg-safe-gray border border-safe-border rounded-xl p-5">
                <p className="text-xs text-safe-text uppercase tracking-wider mb-1">Indexer Status</p>
                <p className="text-sm">
                  {indexerStatus?.running ? 'Running' : 'Stopped'}
                  {indexerStatus?.lastSuccessfulRunAt
                    ? ` · synced ${new Date(indexerStatus.lastSuccessfulRunAt).toLocaleTimeString()}`
                    : ''}
                </p>
                {indexerStatus?.lastError && (
                  <p className="text-xs text-red-400 mt-1 truncate" title={indexerStatus.lastError}>
                    {indexerStatus.lastError}
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowProposal(true)}
                disabled={multisig.ownersRoot == null}
                title={multisig.ownersRoot == null ? 'Run Setup first to initialize the contract' : undefined}
                className="flex items-center gap-2 bg-safe-green text-safe-dark font-semibold rounded-lg px-5 py-2.5 text-sm hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                New Proposal
              </button>
              <button
                onClick={() => setShowSetup(true)}
                disabled={multisig.threshold != null}
                title={multisig.threshold != null ? 'Contract is already set up' : undefined}
                className="flex items-center gap-2 bg-safe-gray border border-safe-border text-white rounded-lg px-5 py-2.5 text-sm hover:bg-safe-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Setup Contract
              </button>
            </div>

            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">Recent Proposals</h3>
                <Link href="/transactions" className="text-xs text-safe-green hover:underline">
                  View all
                </Link>
              </div>
              <TransactionList
                proposals={recent}
                threshold={multisig.threshold ?? 0}
                owners={owners.map((owner) => owner.address)}
                emptyMessage="No proposals indexed yet"
              />
            </div>
          </div>
        ) : (
          <div className="text-center py-20">
            <p className="text-safe-text mb-4">No MinaGuard contracts discovered yet.</p>
            <Link
              href="/deploy"
              className="inline-block bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
            >
              Deploy Contract
            </Link>
          </div>
        )}
      </div>

      {/* Setup Contract Modal */}
      {showSetup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-safe-dark border border-safe-border rounded-xl w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">
                Setup Contract
              </h3>
              <button
                onClick={() => setShowSetup(false)}
                className="text-safe-text hover:text-white text-lg leading-none"
              >
                &times;
              </button>
            </div>

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
                      setSetupError(null);
                    }}
                    placeholder={`Owner ${i + 1} address (B62...)`}
                    className="flex-1 bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm font-mono"
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
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-safe-text">Threshold</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={threshold}
                  onChange={(e) => { setThreshold(e.target.value); setSetupError(null); }}
                  placeholder="Threshold"
                  className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-safe-text">Network ID</span>
                <input
                  type="text"
                  value={networkId}
                  onChange={(e) => { setNetworkId(e.target.value.trim()); setSetupError(null); }}
                  placeholder="Network ID"
                  className="w-full bg-safe-gray border border-safe-border rounded-lg px-4 py-3 text-sm"
                />
              </label>
            </div>

            {setupError && <p className="text-sm text-red-400">{setupError}</p>}

            <button
              disabled={isOperating}
              onClick={handleSetup}
              className="w-full bg-safe-green text-safe-dark font-semibold rounded-lg px-4 py-2.5 text-sm disabled:opacity-60"
            >
              {isOperating ? 'Submitting...' : 'Run Setup'}
            </button>

          </div>
        </div>
      )}

      {/* New Proposal Modal */}
      {showProposal && multisig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-safe-dark border border-safe-border rounded-xl w-full max-w-2xl mx-4 p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold uppercase tracking-wider text-safe-text">
                New Proposal
              </h3>
              <button
                onClick={() => setShowProposal(false)}
                className="text-safe-text hover:text-white text-lg leading-none"
              >
                &times;
              </button>
            </div>
            <ProposalForm
              owners={owners.map((o) => o.address)}
              currentThreshold={multisig.threshold ?? 1}
              numOwners={multisig.numOwners ?? owners.length}
              onSubmit={handleProposalSubmit}
              isSubmitting={isOperating}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Connect-wallet empty state shown when no wallet session is active. */
function ConnectNotice({
  onConnect,
  auroInstalled,
}: {
  onConnect: () => void;
  auroInstalled: boolean;
}) {
  return (
    <div className="text-center py-20">
      <h3 className="text-lg font-semibold mb-2">Connect your wallet</h3>
      <p className="text-sm text-safe-text mb-6 max-w-sm mx-auto">
        Connect your Auro Wallet to create and approve MinaGuard proposals.
      </p>
      <button
        onClick={onConnect}
        className="bg-safe-green text-safe-dark font-semibold rounded-lg px-6 py-3 text-sm hover:brightness-110 transition-all"
      >
        {auroInstalled ? 'Connect Auro Wallet' : 'Install Auro Wallet'}
      </button>
    </div>
  );
}
