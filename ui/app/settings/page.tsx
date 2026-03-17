'use client';

import { useRouter } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import Header from '@/components/Header';
import OwnerList from '@/components/OwnerList';
import ThresholdBadge from '@/components/ThresholdBadge';

/** Settings page for owner set and threshold governance proposal shortcuts. */
export default function SettingsPage() {
  const router = useRouter();
  const {
    wallet,
    multisig,
    owners,
    connect,
    connectAuro,
    connectLedger,
    disconnect,
    isLoading,
    auroInstalled,
    ledgerSupported,
  } = useAppContext();

  const activeOwners = owners.map((owner) => owner.address);

  return (
    <div>
      <Header
        title="Settings"
        subtitle="Manage owners, threshold, and contract metadata"
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
      />

      <div className="p-6 max-w-2xl space-y-6">
        {!wallet.connected || !multisig ? (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect wallet to manage contract settings</p>
          </div>
        ) : (
          <>
            <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-sm font-semibold">Required Confirmations</h3>
                  <p className="text-xs text-safe-text mt-1">
                    Governance changes are approved by current threshold.
                  </p>
                </div>
                <ThresholdBadge
                  threshold={multisig.threshold ?? 0}
                  numOwners={multisig.numOwners ?? activeOwners.length}
                  size="lg"
                />
              </div>
              <button
                onClick={() => router.push('/transactions/new')}
                className="w-full mt-2 p-2.5 border border-safe-border rounded-lg text-sm text-safe-text hover:text-safe-green hover:border-safe-green transition-colors"
              >
                Create Threshold Proposal
              </button>
            </div>

            <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
              <div className="mb-4">
                <h3 className="text-sm font-semibold">Owners ({activeOwners.length})</h3>
                <p className="text-xs text-safe-text mt-1">
                  Owners can propose, approve, and execute transactions.
                </p>
              </div>
              <OwnerList
                owners={activeOwners}
                currentUser={wallet.address}
                threshold={multisig.threshold ?? 1}
                onAddOwner={() => router.push('/transactions/new')}
                onRemoveOwner={() => router.push('/transactions/new')}
              />
            </div>

            <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
              <h3 className="text-sm font-semibold mb-4">Contract Info</h3>
              <div className="space-y-3">
                <InfoRow label="Contract" value={multisig.address} mono />
                <InfoRow label="Network" value={wallet.network ?? 'Unknown'} />
                <InfoRow label="Network ID" value={multisig.networkId ?? '-'} mono />
                <InfoRow label="Owners Commitment" value={multisig.ownersCommitment ?? '-'} mono />
                <InfoRow label="Config Nonce" value={String(multisig.configNonce ?? '-')} mono />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Label-value row primitive used in settings metadata section. */
function InfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex justify-between items-center py-2 border-b border-safe-border/50 last:border-0">
      <span className="text-sm text-safe-text">{label}</span>
      <span className={`text-sm ${mono ? 'font-mono truncate max-w-[16rem] text-right' : ''}`}>{value}</span>
    </div>
  );
}
