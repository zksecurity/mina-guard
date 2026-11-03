import LegalPage from '@/components/LegalPage';

export const metadata = { title: 'Terms of Use | MinaGuard' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Use" updated="2026-11-03">
      <p>
        These terms cover the MinaGuard web interface operated by zkSecurity. By using the interface or
        connecting a wallet to it, you agree to them. If you do not agree, do not use the interface.
      </p>

      <h2>Beta software</h2>
      <p>MinaGuard is in beta, including on Mainnet. It may contain bugs, and you could lose funds.</p>

      <h2>You keep custody</h2>
      <p>
        MinaGuard is software for operating your own multisig vaults on the Mina blockchain. We never hold
        your private keys, recovery phrases or funds. We cannot recover access, reverse, cancel or freeze
        any transaction. Transactions on Mina are final.
      </p>

      <h2 id="network-upgrades">Mina network upgrades</h2>
      <p>Mina can change its protocol through network upgrades. An upgrade can change how existing vaults behave:</p>
      <ul>
        <li>
          After an upgrade, whoever holds a vault&apos;s deploy key may be able to replace the vault&apos;s
          verification key without the owners&apos; approval. If you do not trust the vault creator with that
          key, move funds out before an upgrade.
        </li>
        <li>
          If an upgrade breaks a vault&apos;s existing proofs and its deploy key was not saved, the vault may
          stop working and its funds may be stuck.
        </li>
      </ul>
      <p>
        MinaGuard does not alert you to upgrades, migrate vaults automatically, or guarantee that a future
        upgrade will be supported.
      </p>

      <h2>Your responsibilities</h2>
      <ul>
        <li>Check every proposal and transaction before you approve or sign it. A Ledger device shows only a hash, not the transaction details.</li>
        <li>Keep your keys, devices and recovery phrases secure.</li>
        <li>Use the interface only where it is legal for you to do so.</li>
      </ul>

      <h2>Eligibility</h2>
      <p>
        You must be at least 18 and able to enter a binding agreement. You may not use the interface if you
        are subject to sanctions, located in a sanctioned country or region, or acting for someone who is.
      </p>

      <h2>No warranty</h2>
      <p>
        The interface is provided as is and as available, without warranties of any kind. We may change,
        suspend or stop it at any time.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        To the extent the law allows, zkSecurity is not liable for any loss arising from your use of the
        interface or the MinaGuard contracts, including software bugs, network failures, lost keys or signed
        transactions. Nothing in these terms limits liability that cannot be limited by law.
      </p>

      <h2>Open source</h2>
      <p>
        The MinaGuard source code is available on{' '}
        <a href="https://github.com/zksecurity/mina-guard" target="_blank" rel="noopener noreferrer">GitHub</a>{' '}
        under its own license. These terms cover the hosted interface.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms. Continuing to use the interface after an update means you accept it.</p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:minaguard@zksecurity.xyz">minaguard@zksecurity.xyz</a>
      </p>
    </LegalPage>
  );
}
