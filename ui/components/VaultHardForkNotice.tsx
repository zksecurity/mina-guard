'use client';

import { useState } from 'react';

/** The account key is a separate authority from the owner voting keys. */
export default function VaultHardForkNotice({ creating = false }: { creating?: boolean }) {
  const [closed, setClosed] = useState(false);
  if (creating) {
    return (
      <section aria-labelledby="deploy-key-risk-title" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100 sm:p-5">
        <h2 id="deploy-key-risk-title" className="text-base font-semibold text-amber-50">Save the deploy key?</h2>
        <p className="mt-2 leading-relaxed">
          This key may help recover your Vault after a Mina transaction-version upgrade.
          Anyone with the key could also replace the Vault&apos;s code without owner approval
          after an upgrade, bypassing the owner rules. This applies to Vaults and SubVaults.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-amber-500/25 bg-safe-dark/40 p-3">
            <h3 className="font-semibold text-amber-50">If you save it</h3>
            <p className="mt-1 leading-relaxed">
              Store it securely offline. All owners must trust everyone who can access it.
              Recovery is not guaranteed: after an upgrade, anyone can submit the first
              Vault update and close the window to use the key.
            </p>
          </div>
          <div className="rounded-lg border border-amber-500/25 bg-safe-dark/40 p-3">
            <h3 className="font-semibold text-amber-50">If you don&apos;t save it</h3>
            <p className="mt-1 leading-relaxed">
              You may need to move funds before an upgrade. If the upgrade breaks Vault
              proofs, funds could become stuck. Owner approval alone cannot replace a
              broken verification key under the current contract rules.
            </p>
          </div>
        </div>

        <details className="mt-4 border-t border-amber-500/25 pt-3">
          <summary className="cursor-pointer font-medium text-amber-50 underline decoration-amber-500/50 underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200">
            How recovery works after an upgrade
          </summary>
          <div className="mt-3 space-y-2 leading-relaxed text-amber-100/90">
            <p>
              A transaction-version upgrade can temporarily allow the deploy key to replace
              the Vault&apos;s verification key. The first applied Vault account update ends
              that opportunity. Anyone can pay to submit a no-op update that changes nothing
              visible and ends it, because Vault access needs no authorization.
            </p>
            <p>
              If old proofs no longer work, a compatible verification-key migration with the
              saved deploy key must land before any other Vault update; otherwise the broken
              key may remain installed without a saved-key migration path. If proofs still
              work, use a real proved Vault action to confirm compatibility, not a no-op.
              Follow Mina hard fork announcements and check the on-chain verification key
              after any migration.
            </p>
            <p>
              Remove unprotected key copies from Downloads or cloud sync after moving the
              file to secure offline storage. MinaGuard cannot recover this key.
            </p>
            <a
              href="https://docs.minaprotocol.com/zkapps/tutorials/upgrading-a-zkapp#the-permission-that-decides"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-medium text-amber-50 underline decoration-amber-500/50 underline-offset-4 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200"
            >
              Read Mina’s explanation of transaction versions <span aria-hidden="true">↗</span>
            </a>
          </div>
        </details>
      </section>
    );
  }

  if (closed) {
    return (
      <button type="button" onClick={() => setClosed(false)}
        className="text-sm text-amber-200 underline underline-offset-4 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200">
        Show deploy key warning
      </button>
    );
  }

  return (
    <section aria-labelledby="vault-deploy-key-title" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-100">
      <div className="flex items-start justify-between gap-4">
        <h2 id="vault-deploy-key-title" className="font-semibold text-amber-50">Deploy key and Mina upgrades</h2>
        <button type="button" aria-label="Close deploy key warning" onClick={() => setClosed(true)}
          className="shrink-0 rounded p-1 text-amber-100 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="mt-2 space-y-2 leading-relaxed">
        <p>
          A deploy key is a private key created for the Vault, separate from the owners&apos; wallet keys.
          MinaGuard now offers the creator an optional download when creating a Vault or SubVault;
          it does not keep a copy. Ask the creator whether they saved it and who can access it.
        </p>
        <p>
          After certain Mina upgrades, someone with this key could temporarily change the Vault&apos;s
          code without owner approval and bypass its owner rules. If an upgrade also breaks the
          Vault&apos;s existing proofs and the key was not saved, funds could become stuck; owner
          approval alone cannot replace the broken verification key. These risks also apply to SubVaults.
        </p>
        <p>
          If owners don&apos;t accept the risk, coordinate to move funds before an upgrade. Move
          SubVault funds before the root Vault balance.
        </p>
      </div>
      <details className="mt-3 border-t border-amber-500/25 pt-3">
        <summary className="cursor-pointer font-medium text-amber-50 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-amber-200">
          Why saving the key may not be enough
        </summary>
        <div className="mt-2 space-y-2 leading-relaxed">
          <p>
            A Mina transaction-version upgrade can briefly allow the saved key to replace the
            Vault&apos;s verification key. The first applied Vault update closes that opportunity.
            Anyone can pay to send an update that changes nothing visible and closes it.
          </p>
          <p>
            If old proofs no longer work, a compatible verification-key migration signed with the
            saved key must land before any other Vault update. Otherwise the broken key may remain
            installed with no saved-key recovery path. If proofs still work, use a real
            owner-approved proved Vault action to confirm compatibility, not a no-op. Follow Mina
            hard fork announcements and check the on-chain verification key after any migration.
          </p>
        </div>
      </details>
    </section>
  );
}
