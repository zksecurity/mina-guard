/** The account key is a separate authority from the owner voting keys. */
export default function VaultHardForkNotice({ creating = false }: { creating?: boolean }) {
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
        {creating
          ? 'The creator must choose whether to keep the deploy key for possible recovery. Keeping it means all owners must trust everyone who can access that key. Store it offline and securely; anyone who obtains it may gain this authority after a transaction-version upgrade.'
          : 'Ask the creator whether the deploy key was retained and how it is protected. If you do not accept that trust, coordinate with the owners to move funds out before a transaction-version upgrade. Move SubVault funds before the root Vault balance.'}
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
