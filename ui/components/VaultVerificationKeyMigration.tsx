'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchVaultSecurityStatus, type VaultSecurityStatus } from '@/lib/api';
import { buildOfflineMigrationBundle, type OfflineMigrationBundle, type OfflineMigrationResponse } from '@/lib/offline-signing';
import { assertMigrationResponse } from '@/lib/vk-migration-validation';
import { broadcastSignedTx } from '@/components/OfflineSigningFlow';
import { GUARD_SET_VERIFICATION_KEY_TXN_VERSION } from 'contracts/guard-permission-policy';
import { getMinaGuardConfig } from '@/lib/endpoints';
import Link from 'next/link';

function eligible(status: VaultSecurityStatus | null): boolean {
  return Boolean(status?.accountFound && status.verificationKeyHash && status.setVerificationKeyTxnVersion &&
    /^\d+$/.test(status.setVerificationKeyTxnVersion) &&
    BigInt(status.setVerificationKeyTxnVersion) < BigInt(GUARD_SET_VERIFICATION_KEY_TXN_VERSION) &&
    status.permissionKinds.setVerificationKey === 'Impossible' &&
    status.permissionMismatches.every((name) => name === 'setVerificationKey'));
}

function downloadRequest(bundle: OfflineMigrationBundle) {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `minaguard-vk-migration-${bundle.contractAddress}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VaultVerificationKeyMigration({ address, walletAddress }: { address: string; walletAddress: string | null }) {
  const [status, setStatus] = useState<VaultSecurityStatus | null>(null);
  const [feePayer, setFeePayer] = useState(walletAddress ?? '');
  const [request, setRequest] = useState<OfflineMigrationBundle | null>(null);
  const [exportConfig, setExportConfig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetHash = process.env.NEXT_PUBLIC_MINAGUARD_VK_HASH?.trim() ?? '';

  const refresh = useCallback(async () => {
    const next = await fetchVaultSecurityStatus(address);
    setStatus(next);
    return next;
  }, [address]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (walletAddress) setFeePayer(walletAddress); }, [walletAddress]);

  const verify = useCallback(async () => {
    const next = await refresh();
    if (next?.safe && next.verificationKeyHash === targetHash &&
        next.setVerificationKeyTxnVersion === GUARD_SET_VERIFICATION_KEY_TXN_VERSION) {
      setVerified(true);
      return true;
    }
    return false;
  }, [refresh, targetHash]);

  const sameVk = status?.verificationKeyHash === targetHash;
  if (!targetHash || (!eligible(status) && !txHash && !verified)) return null;
  if (sameVk && !txHash) return (
    <section className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 space-y-3 text-sm" aria-label="Transaction version update">
      <h2 className="font-semibold">Transaction version update — VK unchanged</h2>
      {verified ? (
        <p role="status">The Mina node now reports the current transaction version, the reviewed VK hash, and canonical permissions.</p>
      ) : <>
        <p>This Vault records transaction version <code>{status?.setVerificationKeyTxnVersion}</code>, while this release expects <code>{GUARD_SET_VERIFICATION_KEY_TXN_VERSION}</code>. Its installed verification key already matches this release. The deploy-key signature fallback remains possible until the Vault receives an accepted account update.</p>
        <p>An ordinary proved Vault action, such as an owner-authorized proposal, can update the stored version if Mina accepts its existing proof. The app allows that action with this matching VK and canonical permission kinds. No deploy key or verification-key replacement is needed.</p>
        <p>Any fee payer can submit a no-op Vault update without the deploy key because Vault access needs no authorization. The first applied Vault update ends the fallback even if the VK stays unchanged. Use a real proved Vault action to confirm proof compatibility, not a no-op. If Mina rejects the proof, stop and obtain fork-specific guidance and a reviewed compatible replacement VK release before using the saved deploy key.</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/transactions/new" className="rounded bg-amber-500 px-3 py-2 text-black">Create a Vault proposal</Link>
          <button type="button" disabled={busy} className="rounded border border-amber-500 px-3 py-2 disabled:opacity-50" onClick={async () => {
            setBusy(true); setError(null);
            try { if (!(await verify())) setError('The node still reports the older transaction version. Check after the proved action is accepted.'); }
            finally { setBusy(false); }
          }}>Check on-chain version</button>
        </div>
      </>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </section>
  );
  return (
    <section className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 space-y-3 text-sm" aria-label="Verification key migration">
      <h2 className="font-semibold">Verification-key migration</h2>
      <p>This Vault records transaction version <code>{status?.setVerificationKeyTxnVersion ?? '?'}</code>; this reviewed release expects <code>{GUARD_SET_VERIFICATION_KEY_TXN_VERSION}</code>. The deploy key can replace the installed verification key during Mina&apos;s version fallback. This action bypasses owner voting. Confirm the release and key hash with every owner before proceeding.</p>
      <p><strong>Migration must land before any other Vault account update.</strong> Any fee payer can submit a no-op update without the deploy key because Vault access needs no authorization. That update refreshes the stored version and ends the saved-key migration path, even if the installed VK cannot prove on the upgraded network.</p>
      <dl className="font-mono text-xs break-all space-y-1">
        <div>Installed VK: {status?.verificationKeyHash ?? '?'}</div>
        <div>Replacement VK: {targetHash}</div>
      </dl>
      <p><strong>A MinaGuard maintainer must publish a fork-compatible offline CLI release before you can migrate.</strong> This page cannot confirm that such a release exists or that the CLI binary you run is authentic. Independently verify the MinaGuard CLI (<code>mina-guard-cli</code>), its SHA256SUMS, and its per-network VK hash before using the saved deploy key. The CLI checks its compiled VK against the replacement hash above, but that hash check does not authenticate the binary. Keep the deploy key on the offline machine.</p>
      {!txHash && <>
        <label className="block">Offline fee payer address
          <input className="block mt-1 w-full rounded border border-safe-border bg-safe-dark p-2 font-mono text-xs" value={feePayer} onChange={(event) => setFeePayer(event.target.value.trim())} />
        </label>
        <button type="button" disabled={busy} className="rounded bg-amber-500 px-3 py-2 text-black disabled:opacity-50" onClick={async () => {
          setBusy(true); setError(null);
          try {
            const next = await buildOfflineMigrationBundle(address, feePayer);
            setRequest(next);
            setExportConfig(JSON.stringify(getMinaGuardConfig()));
            downloadRequest(next);
          } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
          finally { setBusy(false); }
        }}>Export migration request</button>
        {request && <div className="space-y-2">
          <p>On the offline machine, run the verified CLI with <code>MINA_PRIVATE_KEY</code> set to the saved deploy key and <code>MINA_FEE_PAYER_PRIVATE_KEY</code> set to the fee payer key. Review its summary before signing. Import the resulting signed JSON here.</p>
          <input type="file" accept="application/json,.json" aria-label="Import signed migration response" onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setBusy(true); setError(null);
            try {
              const response = JSON.parse(await file.text()) as OfflineMigrationResponse;
              if (!exportConfig || JSON.stringify(getMinaGuardConfig()) !== exportConfig) {
                throw new Error('Network configuration changed after export. Prepare a new migration request.');
              }
              const txJson = assertMigrationResponse(response, request);
              const current = await refresh();
              if (!eligible(current) || current?.verificationKeyHash !== request.sourceVerificationKeyHash ||
                  current.setVerificationKeyTxnVersion !== request.sourceTxnVersion) {
                throw new Error('Vault state changed after export. Prepare a new migration request.');
              }
              const hash = await broadcastSignedTx(txJson);
              setTxHash(hash);
              setRequest(null);
            } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
            finally { setBusy(false); event.target.value = ''; }
          }} />
        </div>}
      </>}
      {txHash && <div className="space-y-2">
        <p>Submitted transaction: <code className="break-all">{txHash}</code></p>
        <button type="button" disabled={busy || verified} className="rounded border border-amber-500 px-3 py-2 disabled:opacity-50" onClick={async () => {
          setBusy(true); setError(null);
          try { if (!(await verify())) setError('The node has not yet confirmed the replacement VK and current transaction version. Check again after inclusion.'); }
          finally { setBusy(false); }
        }}>Verify on chain</button>
        {verified && <p role="status">Node confirmed the reviewed VK hash, current transaction version, and canonical permissions.</p>}
      </div>}
      {error && <p role="alert" className="text-red-400">{error}</p>}
    </section>
  );
}
