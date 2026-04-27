'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAppContext } from '@/lib/app-context';
import OwnerList from '@/components/OwnerList';
import ThresholdBadge from '@/components/ThresholdBadge';
import { checkStorageAvailable, clearCompileCache, getCompileCacheSize, setCompileCacheEnabledIDB } from '@/lib/idb-compile-cache';
import { isCompileCacheEnabled, setCompileCacheEnabled } from '@/lib/storage';

/** Settings page for owner set and threshold governance proposal shortcuts. */
export default function SettingsPage() {
  const router = useRouter();
  const { wallet, multisig, owners } = useAppContext();
  const [cacheSize, setCacheSize] = useState<{ entries: number; bytes: number } | null>(null);
  const [cacheEnabled, setCacheEnabled] = useState(() => isCompileCacheEnabled());
  const [storageOk, setStorageOk] = useState<boolean | null>(null);
  const [storageMB, setStorageMB] = useState<number>(0);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    getCompileCacheSize().then(setCacheSize);
    checkStorageAvailable().then(({ available, remainingMB }) => {
      setStorageOk(available);
      setStorageMB(remainingMB);
    });
  }, []);

  const handleToggle = useCallback(async () => {
    const next = !cacheEnabled;
    setToggling(true);
    try {
      setCacheEnabled(next);
      setCompileCacheEnabled(next);
      if (!next) {
        await clearCompileCache();
        await setCompileCacheEnabledIDB(false);
        setCacheSize({ entries: 0, bytes: 0 });
      } else {
        await setCompileCacheEnabledIDB(true);
      }
    } finally {
      setToggling(false);
    }
  }, [cacheEnabled]);

  const activeOwners = owners.map((owner) => owner.address);

  return (
    <div>
      <div className="p-6 max-w-2xl space-y-6">
        {wallet.connected && multisig ? (
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
        ) : (
          <div className="text-center py-20">
            <p className="text-safe-text">Connect wallet to manage contract settings</p>
          </div>
        )}

        <div className="bg-safe-gray border border-safe-border rounded-xl p-6">
          <h3 className="text-sm font-semibold mb-2">Compile Cache</h3>
          <p className="text-xs text-safe-text mb-4">
            Cached prover keys speed up contract compilation after page reloads.
            {cacheEnabled && cacheSize && cacheSize.entries > 0 && (
              <> Currently using {(cacheSize.bytes / 1024 / 1024).toFixed(0)}MB ({cacheSize.entries} entries).</>
            )}
          </p>
          {storageOk === false && !cacheEnabled ? (
            <div className="rounded-lg border border-safe-border bg-safe-bg p-3">
              <p className="text-xs text-safe-text">
                Not enough storage to enable compile caching. At least 1.8 GB of free space is required
                ({storageMB < 1024
                  ? `${storageMB} MB available`
                  : `${(storageMB / 1024).toFixed(1)} GB available`}).
              </p>
              <label className="flex items-center justify-between py-2 mt-2 cursor-not-allowed opacity-50">
                <span className="text-sm">Enable compile caching</span>
                <button
                  role="switch"
                  aria-checked={false}
                  disabled
                  className="relative inline-flex h-6 w-11 items-center rounded-full bg-safe-border cursor-not-allowed"
                >
                  <span className="inline-block h-4 w-4 rounded-full bg-white translate-x-1" />
                </button>
              </label>
            </div>
          ) : (
            <>
              <label className="flex items-center justify-between py-2 cursor-pointer">
                <span className="text-sm">Enable compile caching</span>
                <button
                  role="switch"
                  aria-checked={cacheEnabled}
                  disabled={toggling}
                  onClick={handleToggle}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    cacheEnabled ? 'bg-safe-green' : 'bg-safe-border'
                  } ${toggling ? 'opacity-50' : ''}`}
                >
                  <span
                    className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
                      cacheEnabled ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <p className="text-xs text-safe-text mt-1">
                Disabling will remove any existing cached data.
              </p>
            </>
          )}
        </div>
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
