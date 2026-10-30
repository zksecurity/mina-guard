/** The account key is a separate authority from the owner voting keys. */
export default function VaultHardForkNotice({ creating = false }: { creating?: boolean }) {
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
          </div>
        </details>
      </section>
    );
  }

  return (
    <div role="alert" className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm text-amber-100 space-y-2">
      <p className="font-semibold">Hard fork recovery and deploy key risk</p>
      <p>
        If a Mina hard fork raises the transaction version, this Vault&apos;s verification-key
        permission can temporarily become authorized by its deploy key signature. Whoever
        holds that key could replace the Vault&apos;s code without owner approval and then
        bypass its owner rules. This also applies to SubVaults.
      </p>
      <p className="font-medium">
        If the fork also breaks the existing Vault proofs and the deploy key was not backed
        up, the Vault may become unusable, with its funds stuck. Owner approval alone
        cannot replace a broken verification key under the current contract rules.
      </p>
      <p>
        Ask the creator whether the deploy key was retained and how it is protected. If you
        do not accept that trust, coordinate with the owners to move funds out before a
        transaction-version upgrade. Move SubVault funds before the root Vault balance.
      </p>
      <p>
        A saved key is not a guaranteed recovery plan. Follow Mina hard fork announcements
        and check the on-chain verification key after any migration. The first applied
        Vault account update after a version upgrade ends the deploy-key fallback.
        Because Vault access needs no authorization, anyone can pay to submit a no-op
        update that ends it. If old proofs no longer work, a compatible verification-key
        migration with the saved deploy key must land first; otherwise the broken key
        may remain installed with no saved-key migration path. If proofs still work,
        use a real proved Vault action to confirm compatibility, not a no-op.
      </p>
    </div>
  );
}
