import LegalPage from '@/components/LegalPage';

export const metadata = { title: 'Privacy Policy | MinaGuard' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="2026-11-03">
      <p>This policy explains what the MinaGuard web interface, operated by zkSecurity, LLC, collects and why.</p>

      <h2>Server logs</h2>
      <p>
        When you load the interface, our servers record your IP address, browser user agent, the addresses
        you request and the time. We use these logs to keep the service secure, prevent abuse and fix
        problems. Load balancer logs are kept for 90 days, host logs for up to 30 days, and rate-limiting
        samples for about 3 hours.
      </p>

      <h2>Public blockchain data</h2>
      <p>
        The interface reads vaults, owners and proposals from the public Mina blockchain, and records the
        transaction hashes you report after signing. This data is public and permanent, and we cannot delete
        it from the blockchain.
      </p>

      <h2>Your browser</h2>
      <p>
        The interface stores your wallet choice, selected vault, the names you give vaults and pending
        transactions in your browser. This data stays on your device. We use no cookies, analytics or
        tracking.
      </p>

      <h2>Bug reports</h2>
      <p>
        The &ldquo;Report a bug&rdquo; links open a GitHub issue form. Opening one sends your app version,
        network, page, wallet type, browser and, from an error message, that error to GitHub to fill in the
        form. You can edit or remove them, and nothing is posted until you submit. Issues are public, and
        GitHub&apos;s privacy policy applies to them.
      </p>

      <h2>Wallets</h2>
      <p>Auro Wallet and Ledger are separate products with their own privacy policies.</p>

      <h2>Who processes the data</h2>
      <p>
        The interface is hosted on Amazon Web Services in the United States. Release files are published on
        GitHub. We do not sell or share your data for marketing.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask us to access or delete log data about you, where the law gives you that right. Contact us
        at <a href="mailto:hello@zksecurity.xyz">hello@zksecurity.xyz</a>.
      </p>

      <h2>Changes</h2>
      <p>We may update this policy and will change the date above when we do.</p>
    </LegalPage>
  );
}
