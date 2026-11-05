import LegalPage from '@/components/LegalPage';

export const metadata = { title: 'Terms of Use | MinaGuard' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Use" updated="2026-11-03">
      <p>
        These terms cover the MinaGuard web interface operated by zkSecurity, LLC (&quot;zkSecurity&quot;,
        &quot;we&quot;). By using the interface or connecting a wallet to it, you agree to them. If you do not agree,
        do not use the interface.
      </p>

      <h2>Beta software</h2>
      <p>MinaGuard is in beta, including on Mainnet. It may contain bugs, and you could lose funds.</p>

      <h2>You keep custody</h2>
      <p>
        MinaGuard is software for operating your own multisig vaults on the Mina blockchain. We never hold
        your private keys, recovery phrases or funds. We cannot recover access, reverse, cancel or freeze
        any transaction. Transactions on Mina are final.
      </p>
      <p>
        Nothing in the interface is financial, legal or tax advice. We do not act as your broker, agent or
        fiduciary.
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

      <h2>Third-party services</h2>
      <p>
        The interface relies on services we do not control, including the Mina network, its nodes and
        archive services, Auro Wallet and Ledger. We are not responsible for their availability, behavior
        or security.
      </p>

      <h2>Eligibility</h2>
      <p>
        You must be at least 18 and able to enter a binding agreement. You may not use the interface if you
        are subject to sanctions, located in a sanctioned country or region, or acting for someone who is.
      </p>

      <h2>No warranty</h2>
      <p>
        THE INTERFACE AND THE MINAGUARD CONTRACTS ARE PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot;, WITHOUT
        WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING THE IMPLIED WARRANTIES OF MERCHANTABILITY,
        FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT. We do not warrant that the interface will be
        uninterrupted, secure or free of errors. We may change, suspend or stop it at any time.
      </p>

      <h2>Limitation of liability</h2>
      <p>
        TO THE EXTENT THE LAW ALLOWS, ZKSECURITY IS NOT LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
        CONSEQUENTIAL OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF FUNDS, DIGITAL ASSETS, PROFITS OR DATA, ARISING
        FROM YOUR USE OF THE INTERFACE OR THE MINAGUARD CONTRACTS, INCLUDING SOFTWARE BUGS, NETWORK FAILURES,
        LOST KEYS OR SIGNED TRANSACTIONS. OUR TOTAL LIABILITY FOR ANY CLAIM RELATED TO THESE TERMS OR THE
        INTERFACE IS LIMITED TO US$100. Nothing in these terms limits liability that cannot be limited by
        law.
      </p>

      <h2>Open source</h2>
      <p>
        The MinaGuard source code is available on{' '}
        <a href="https://github.com/zksecurity/mina-guard" target="_blank" rel="noopener noreferrer">GitHub</a>{' '}
        under its own license. These terms cover the hosted interface.
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the State of Delaware, without regard to its conflict of
        law rules. Any dispute arising from these terms or the interface will be resolved exclusively in the
        state or federal courts located in Delaware.
      </p>

      <h2>Changes</h2>
      <p>We may update these terms. Continuing to use the interface after an update means you accept it.</p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:hello@zksecurity.xyz">hello@zksecurity.xyz</a>
      </p>
    </LegalPage>
  );
}
