'use client';

import { useEffect, useState, type ReactNode } from 'react';

// -- In-page table of contents (mirrors the section ids below) ---------------
const NAV = [
  {
    group: 'Start here',
    items: [
      { id: 'overview', label: 'Overview' },
      { id: 'how', label: 'How it works' },
      { id: 'terms', label: 'Key terms' },
    ],
  },
  {
    group: 'Your first Vault',
    items: [
      { id: 'create', label: 'Create a Vault' },
      { id: 'flow', label: 'Propose, approve, execute' },
    ],
  },
  {
    group: 'Going further',
    items: [
      { id: 'actions', label: 'What you can do' },
      { id: 'subvaults', label: 'SubVaults' },
      { id: 'offline', label: 'Air-gapped signing' },
    ],
  },
  {
    group: 'Reference',
    items: [
      { id: 'warnings', label: 'Reading the warnings' },
      { id: 'wallets', label: 'Wallets and networks' },
    ],
  },
];

// -- Small presentational helpers -------------------------------------------
function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-xs uppercase tracking-[0.2em] text-safe-green">{children}</p>
  );
}

/** Inline emphasis for a defined term: accent-underlined, not italic. */
function Em({ children }: { children: ReactNode }) {
  return <em className="not-italic text-white border-b border-safe-green/40">{children}</em>;
}

/** Monospace token for a UI label or literal. */
function Tok({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[0.8em] bg-safe-dark border border-safe-border rounded px-1.5 py-0.5 text-white whitespace-nowrap">
      {children}
    </code>
  );
}

const CHIP_TONE: Record<string, string> = {
  plain: 'border-safe-border text-safe-text bg-safe-dark',
  accent: 'border-safe-green/30 text-safe-green bg-safe-green/10',
  config: 'border-amber-400/30 text-amber-400 bg-amber-400/10',
  danger: 'border-red-500/30 text-red-400 bg-red-400/10',
};
function Chip({ tone = 'plain', children }: { tone?: string; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center font-mono text-[0.68rem] rounded-full px-2.5 py-0.5 border ${CHIP_TONE[tone] ?? CHIP_TONE.plain}`}>
      {children}
    </span>
  );
}

function Section({ id, eyebrow, title, intro, children }: {
  id: string; eyebrow: string; title: string; intro?: ReactNode; children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="mb-6">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="mt-2 text-2xl md:text-[1.9rem] font-bold tracking-tight text-white [text-wrap:balance]">{title}</h2>
      </div>
      {intro && <p className="mb-6 text-safe-text leading-relaxed max-w-[68ch]">{intro}</p>}
      {children}
    </section>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="relative pl-14 py-4 border-b border-safe-border last:border-0">
      <span className="absolute left-0 top-4 grid place-items-center w-9 h-9 rounded-lg font-mono font-semibold text-sm bg-safe-green/10 text-safe-green border border-safe-green/30">
        {n}
      </span>
      <h4 className="font-semibold text-white">{title}</h4>
      <div className="mt-1 text-sm text-safe-text leading-relaxed max-w-[64ch] space-y-2.5">{children}</div>
    </li>
  );
}

function ActionCard({ code, title, desc, chips }: {
  code: string; title: string; desc: ReactNode; chips: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 bg-safe-gray border border-safe-border rounded-xl p-4 card-hover">
      <a
        href={`/guide/action-${code}.png`}
        target="_blank"
        rel="noopener noreferrer"
        title="Open full screenshot"
        className="block rounded-lg overflow-hidden border border-safe-border bg-safe-dark"
      >
        <img
          src={`/guide/action-${code}.png`}
          alt={`${title} form`}
          loading="lazy"
          className="w-full h-32 object-cover object-top"
        />
      </a>
      <span className="font-mono text-[0.66rem] text-safe-text/70">{code}</span>
      <h4 className="font-semibold text-white">{title}</h4>
      <p className="text-sm text-safe-text leading-relaxed flex-1">{desc}</p>
      <div className="flex flex-wrap gap-1.5">{chips}</div>
    </div>
  );
}

/** Full-width labelled screenshot; the image links to its full resolution. */
function Figure({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  return (
    <figure className="mt-5 rounded-xl border border-safe-border overflow-hidden bg-safe-dark">
      <a href={src} target="_blank" rel="noopener noreferrer" className="block">
        <img src={src} alt={alt} loading="lazy" className="w-full block" />
      </a>
      {caption && (
        <figcaption className="px-4 py-2.5 text-xs text-safe-text border-t border-safe-border">{caption}</figcaption>
      )}
    </figure>
  );
}

function Term({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="bg-safe-gray border border-safe-border rounded-lg p-5">
      <dt className="font-mono font-semibold text-safe-green">{term}</dt>
      <dd className="mt-2 text-sm text-safe-text leading-relaxed">{children}</dd>
    </div>
  );
}

function Warn({ tone, sev, title, children }: {
  tone: 'red' | 'amber'; sev: string; title: string; children: ReactNode;
}) {
  const edge = tone === 'red' ? 'border-l-red-500' : 'border-l-amber-400';
  const sevColor = tone === 'red' ? 'text-red-400' : 'text-amber-400';
  return (
    <div className={`grid grid-cols-[auto_minmax(0,1fr)] gap-4 bg-safe-gray border border-safe-border border-l-[3px] ${edge} rounded-lg p-4`}>
      <span className={`font-mono text-[0.62rem] uppercase tracking-wider font-semibold pt-0.5 whitespace-nowrap ${sevColor}`}>{sev}</span>
      <div>
        <div className="font-semibold text-white text-[0.95rem]">{title}</div>
        <div className="mt-1 text-sm text-safe-text leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

// -- Page -------------------------------------------------------------------
export default function GuidePage() {
  const [active, setActive] = useState('overview');

  useEffect(() => {
    document.title = 'Guide · MinaGuard';
    const ids = NAV.flatMap((g) => g.items.map((i) => i.id));
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) obs.observe(el);
    });
    return () => obs.disconnect();
  }, []);

  return (
    <div className="px-6 md:px-10 py-10 md:py-14">
      <div className="mx-auto max-w-6xl xl:grid xl:grid-cols-[minmax(0,1fr)_216px] xl:gap-14">
        {/* ---------- CONTENT ---------- */}
        <div className="max-w-3xl space-y-16 md:space-y-20">
          {/* HERO / OVERVIEW */}
          <section id="overview" className="scroll-mt-24">
            <Eyebrow>MinaGuard · User Guide</Eyebrow>
            <h1 className="mt-4 text-4xl md:text-5xl font-bold tracking-tight text-white [text-wrap:balance] leading-[1.1]">
A multi-sig wallet, <span className="text-safe-green">enforced on-chain.</span>
            </h1>
            <p className="mt-5 text-lg text-safe-text leading-relaxed max-w-[70ch]">
              MinaGuard is a multi-sig wallet on the Mina blockchain. Funds move only when the required
              number of owners approve, and the chain enforces this with a zero-knowledge proof. No
              server or individual owner can move funds alone.
            </p>
            <p className="mt-4 text-safe-text leading-relaxed max-w-[70ch]">
              This guide covers the core terminology, the propose, approve, and execute lifecycle, and
              the steps to create and operate a vault.
            </p>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              {[
                ['Control', 'N-of-M approval'],
                ['Enforced by', 'On-chain proof'],
                ['Sign with', 'Auro, Ledger, or offline'],
              ].map(([k, v]) => (
                <div key={k} className="bg-safe-gray border border-safe-border rounded-xl p-4">
                  <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-safe-text/70">{k}</p>
                  <p className="mt-1.5 font-semibold text-white">{v}</p>
                </div>
              ))}
            </div>

            <a
              href="#create"
              className="group mt-6 inline-flex items-center gap-3 bg-safe-orange/10 border border-safe-orange/30 rounded-xl px-4 py-3 text-white transition-colors hover:border-safe-orange"
            >
              <span className="font-mono text-[0.64rem] uppercase tracking-[0.14em] text-safe-orange">Start here</span>
              <span className="font-semibold">Create a Vault</span>
              <svg className="w-4 h-4 text-safe-orange transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </a>

            <Figure
              src="/guide/vault-detail.png"
              alt="A MinaGuard vault dashboard"
              caption="A vault's dashboard: owners, threshold, SubVaults, and recent proposals."
            />
          </section>

          {/* HOW IT WORKS */}
          <Section
            id="how"
            eyebrow="Start here"
            title="The propose, approve, execute lifecycle"
            intro={<>Every action follows the same three stages. Nothing is committed on-chain until the final stage.</>}
          >
            <div className="relative">
              <div className="absolute left-[21px] top-3 bottom-6 w-0.5 bg-safe-green/30" aria-hidden="true" />
              {[
                { n: 1, t: 'Propose', who: 'Any owner', d: <>An owner drafts and signs the action, which is recorded as a <Em>proposal</Em>. Proposing counts as the proposer&apos;s first approval.</> },
                { n: 2, t: 'Approve', who: 'Owners, until the threshold is met', d: <>The remaining owners review and approve the proposal. Approvals are tracked as <Em>confirmations</Em>.</> },
                { n: 3, t: 'Execute', who: 'Any party', d: <>When confirmations reach the <Em>threshold</Em>, the proposal is executed: the proof is submitted on-chain and the change takes effect. Any party can execute; only reaching the threshold matters.</> },
              ].map((node) => (
                <div key={node.n} className="relative flex gap-4 pb-7 last:pb-0">
                  <div className="relative z-10 grid place-items-center w-11 h-11 shrink-0 rounded-full font-mono font-semibold bg-safe-dark text-safe-green border-2 border-safe-green">
                    {node.n}
                  </div>
                  <div className="pt-1">
                    <h4 className="text-lg font-semibold text-white">{node.t}</h4>
                    <p className="mt-1.5 text-safe-text leading-relaxed max-w-[60ch]">{node.d}</p>
                    <div className="mt-2.5"><Chip tone="accent">{node.who}</Chip></div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 flex gap-3.5 bg-safe-green/10 border border-safe-green/30 rounded-xl p-4">
              <svg className="w-6 h-6 shrink-0 text-safe-green" fill="none" viewBox="0 0 24 24">
                <path d="M12 2.2 20 5.1v6.2c0 4.9-3.4 8.6-8 10.5-4.6-1.9-8-5.6-8-10.5V5.1L12 2.2Z" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
                <path d="m8.3 12.1 2.6 2.6 4.8-5.2" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="text-sm text-white leading-relaxed">
                Owners sign a proposal <b className="text-safe-green">hash</b>, not a readable form. This is
                known as blind signing. Before signing, MinaGuard recomputes the hash from on-chain state
                and verifies it matches, so the app&apos;s display corresponds to what is signed.
              </p>
            </div>
          </Section>

          {/* KEY TERMS */}
          <Section
            id="terms"
            eyebrow="Start here"
            title="Key terms"
            intro={<>The application uses a small, consistent vocabulary.</>}
          >
            <dl className="grid gap-3 sm:grid-cols-2">
              <Term term="Vault">A wallet holding MINA and a list of owners. On-chain, a multisig smart contract.</Term>
              <Term term="Owner">An address permitted to propose and approve. Your connected wallet is marked <Tok>You</Tok>; a vault you do not own is shown as <Tok>View-only</Tok>.</Term>
              <Term term="Threshold">The number of approvals a proposal requires before it can execute. Shown in Settings as <Tok>Required Confirmations</Tok>.</Term>
              <Term term="Proposal">A drafted action awaiting approvals.</Term>
              <Term term="Confirmations">The approvals collected so far, displayed as a checklist of owners.</Term>
              <Term term="Nonce">A per-vault counter that orders executions and prevents replays. The form supplies the next value.</Term>
              <Term term="Delegate">The block producer the vault&apos;s stake supports. Setting or clearing it moves no funds.</Term>
              <Term term="Blind signing">Wallets cannot render a full proposal, so they sign an opaque hash. Confirm the details in the app before signing.</Term>
              <Term term="SubVault">A vault owned by another vault. Nesting is limited to one level.</Term>
              <Term term="LOCAL vs REMOTE"><Em>LOCAL</Em> actions affect the current vault. <Em>REMOTE</Em> actions are proposed on a Vault and take effect on one of its SubVaults.</Term>
              <Term term="Config nonce">A counter that increments when the owner set or threshold changes. A proposal is bound to the config nonce under which it was created, so a later governance change invalidates it.</Term>
              <Term term="Verification key">The on-chain fingerprint of a vault&apos;s contract, used to verify proofs.</Term>
            </dl>
          </Section>

          {/* CREATE A VAULT */}
          <Section
            id="create"
            eyebrow="Your first Vault"
            title="Create a Vault"
            intro={<>Creating a vault takes four steps and confirms after roughly three minutes.</>}
          >
            <ol className="list-none m-0 p-0">
              <Step n={1} title="Connect a wallet">
                <p>Connect Auro (browser extension) or Ledger (USB, via WebHID). Ledger also requires a <Em>Vault Index</Em>, the account number on the device (default <Tok>0</Tok>).</p>
              </Step>
              <Step n={2} title="Start a vault">
                <p>From <Tok>Your Vaults</Tok>, select <Tok>Create Vault</Tok>. Enter a local nickname and choose a network. Only Testnet is currently available.</p>
              </Step>
              <Step n={3} title="Set owners and threshold">
                <p>The vault address is generated automatically. Add each owner address (up to twenty; your wallet is included by default) and set the threshold.</p>
              </Step>
              <Step n={4} title="Deploy">
                <p>Select <Tok>Deploy Vault</Tok>. A single transaction creates the vault and installs its owners, confirming after the next block.</p>
              </Step>
            </ol>
            <Figure
              src="/guide/create-vault.png"
              alt="The Create Vault wizard"
              caption="The Create Vault wizard: name and network, then owners and threshold."
            />
          </Section>

          {/* PROPOSE / APPROVE / EXECUTE */}
          <Section
            id="flow"
            eyebrow="Your first Vault"
            title="Propose, approve, execute"
            intro={<>Once a vault is deployed, every action follows this sequence.</>}
          >
            <ol className="list-none m-0 p-0">
              <Step n={1} title="Propose">
                <p>Open a vault and select <Tok>New Proposal</Tok>. Choose an action, complete the form (the nonce is prefilled), and select <Tok>Submit Proposal</Tok>. Proposing records the proposer&apos;s first approval.</p>
              </Step>
              <Step n={2} title="Approve">
                <p>Each remaining owner opens the proposal and selects <Tok>Approve Proposal</Tok>. Confirmations accrue until the threshold is met. If a proposal cannot proceed, the app disables the action and states why (see <a href="#warnings" className="text-safe-green hover:opacity-80 underline underline-offset-2">Reading the warnings</a>).</p>
              </Step>
              <Step n={3} title="Execute">
                <p>When the threshold is met, select <Tok>Execute Proposal</Tok>. Any party can execute. If the vault balance is insufficient, execution is blocked.</p>
              </Step>
            </ol>
            <Figure
              src="/guide/proposal-detail.png"
              alt="A proposal detail page with approve and execute"
              caption="A proposal's detail page: owners approve here, and once the threshold is met, anyone can execute."
            />
          </Section>

          {/* WHAT YOU CAN DO */}
          <Section
            id="actions"
            eyebrow="Going further"
            title="What you can do"
            intro={<>Every action is one of the following types. The chips indicate whether an action affects the current vault (<Tok>LOCAL</Tok>) or a SubVault (<Tok>REMOTE</Tok>), and whether it changes the config nonce.</>}
          >
            <div className="font-mono text-xs uppercase tracking-[0.14em] text-safe-text/60 flex items-center gap-3 mb-3.5">
              Vault actions<span className="flex-1 h-px bg-safe-border" />
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <ActionCard code="transfer" title="Send MINA" desc="Send MINA to up to nine recipients." chips={<Chip>LOCAL</Chip>} />
              <ActionCard code="addOwner" title="Add Owner" desc="Add a signer to the owner set." chips={<><Chip>LOCAL</Chip><Chip tone="config">Changes config</Chip></>} />
              <ActionCard code="removeOwner" title="Remove Owner" desc="Remove a signer. Blocked if it would drop the owner count below the threshold." chips={<><Chip>LOCAL</Chip><Chip tone="config">Changes config</Chip></>} />
              <ActionCard code="changeThreshold" title="Change Threshold" desc="Change the number of approvals required." chips={<><Chip>LOCAL</Chip><Chip tone="config">Changes config</Chip></>} />
              <ActionCard code="setDelegate" title="Set Delegate" desc="Set or clear the block-producer delegate. Moves no funds." chips={<Chip>LOCAL</Chip>} />
            </div>

            <div className="font-mono text-xs uppercase tracking-[0.14em] text-safe-text/60 flex items-center gap-3 mt-7 mb-3.5">
              SubVault actions · from a top-level Vault<span className="flex-1 h-px bg-safe-border" />
            </div>
            <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
              <ActionCard code="createChild" title="Create SubVault" desc="Deploy a SubVault owned by this Vault." chips={<Chip tone="accent">REMOTE</Chip>} />
              <ActionCard code="allocateChild" title="Allocate to SubVaults" desc="Fund one or more SubVaults from this Vault." chips={<Chip>LOCAL</Chip>} />
              <ActionCard code="reclaimChild" title="Reclaim from SubVault" desc="Return an amount from a SubVault to this Vault." chips={<Chip tone="accent">REMOTE</Chip>} />
              <ActionCard code="destroyChild" title="Destroy SubVault" desc="Drain a SubVault's balance to this Vault and permanently disable its multisig. Irreversible." chips={<><Chip tone="accent">REMOTE</Chip><Chip tone="danger">Irreversible</Chip></>} />
              <ActionCard code="enableChildMultiSig" title="Toggle SubVault Multi-sig" desc="Enable or disable a SubVault running its own proposals." chips={<Chip tone="accent">REMOTE</Chip>} />
              <div className="sm:col-span-2 lg:col-span-3 bg-safe-dark border border-dashed border-safe-border rounded-xl p-4 text-sm text-safe-text leading-relaxed">
                <b className="text-white">Deleting a proposal</b> is not a separate action. The app creates a
                zero-effect proposal that reuses the target nonce, cancelling the original once approved. Not
                available for Create SubVault.
              </div>
            </div>
          </Section>

          {/* SUBVAULTS */}
          <Section
            id="subvaults"
            eyebrow="Going further"
            title="SubVaults"
            intro={<>A SubVault is a vault owned by another vault, used to separate funds into compartments the owning Vault controls. Nesting is limited to one level.</>}
          >
            <ol className="list-none m-0 p-0">
              <Step n={1} title="Create">
                <p>On a top-level vault, open <Tok>SubVaults</Tok> and select <Tok>Create SubVault</Tok>. Owners and threshold are prefilled from the Vault. Propose it, have the Vault owners approve, then execute to initialize the SubVault.</p>
              </Step>
              <Step n={2} title="Fund and reclaim">
                <p><Tok>Allocate to SubVaults</Tok> sends MINA to SubVaults. <Tok>Reclaim from SubVault</Tok> returns an amount to the Vault, capped at the SubVault balance.</p>
              </Step>
              <Step n={3} title="Autonomy">
                <p><Tok>Toggle SubVault Multi-sig</Tok> controls whether a SubVault can run its own proposals. When disabled, the SubVault is controlled only by its Vault; Vault-authorized actions still apply.</p>
              </Step>
              <Step n={4} title="Destroy">
                <p><Tok>Destroy SubVault</Tok> drains the SubVault to its Vault and permanently disables it. The action is irreversible and requires confirmation.</p>
              </Step>
            </ol>
          </Section>

          {/* OFFLINE */}
          <Section
            id="offline"
            eyebrow="Going further"
            title="Air-gapped signing"
            intro={<>To keep an owner key on a machine that is never online, use air-gapped signing. Propose, approve, and execute each offer an Online and Offline option.</>}
          >
            <ol className="list-none m-0 p-0">
              <Step n={1} title="Name the signer">
                <p>On the Offline tab, enter the <Tok>Signer Address (Fee Payer)</Tok>: the public key of the key held on the offline machine. No wallet connection is required.</p>
              </Step>
              <Step n={2} title="Get the CLI">
                <p>Under <Tok>Instructions</Tok>, download <Tok>mina-guard-cli</Tok> for your platform and verify it against the published <Tok>SHA256SUMS</Tok>.</p>
              </Step>
              <Step n={3} title="Export the bundle">
                <p>Select <Tok>Export Bundle</Tok>. The app downloads a JSON file describing exactly what will be signed, and warns of any fee-payer balance or account-creation costs.</p>
              </Step>
              <Step n={4} title="Sign it offline">
                <p>Transfer the bundle to the offline machine and run:</p>
                <div className="font-mono text-sm bg-safe-dark border border-safe-border rounded-lg px-3.5 py-3 overflow-x-auto text-white">
                  <span className="text-safe-green">MINA_PRIVATE_KEY</span>=EK… ./mina-guard-cli bundle.json <span className="text-safe-text/60">{'> signed.json'}</span>
                </div>
                <p>The CLI prints a readable summary and requires you to type <Tok>y</Tok> before signing.</p>
              </Step>
              <Step n={5} title="Broadcast">
                <p>Return <Tok>signed.json</Tok> to an online machine and upload it. The app verifies it is bound to the correct vault and proposal, then broadcasts it.</p>
              </Step>
            </ol>
            <div className="mt-4 bg-safe-dark border border-dashed border-safe-border rounded-xl p-4 text-sm text-safe-text leading-relaxed">
              Create SubVault cannot be proposed offline, as it uses the guided wizard. A Create SubVault
              proposal can still be approved and executed offline.
            </div>
          </Section>

          {/* WARNINGS */}
          <Section
            id="warnings"
            eyebrow="Reference"
            title="Reading the warnings"
            intro={<>The app blocks invalid or unsafe actions and states the reason. The common messages are below.</>}
          >
            <div className="space-y-2.5">
              <Warn tone="red" sev="Blocks" title="Outdated config nonce">The owner set or threshold changed after this proposal was created, so it can no longer execute. Create a new proposal.</Warn>
              <Warn tone="amber" sev="Dead" title="Invalidated by a later nonce">A newer proposal reused this one&apos;s slot. Create a new proposal if the action is still required.</Warn>
              <Warn tone="red" sev="Blocks" title="SubVault config does not match the signed proposal">The SubVault configuration differs from what the proposal was signed against. Approval is blocked to prevent a configuration swap.</Warn>
              <Warn tone="amber" sev="Wait" title="SubVault config could not be verified">The SubVault events are not yet indexed. Wait for the indexer to catch up, then retry.</Warn>
              <Warn tone="amber" sev="Check" title="Memo mismatch">The displayed memo does not match what the proposal was signed with. Verify before approving.</Warn>
              <Warn tone="red" sev="Blocks" title="Insufficient balance">The source vault cannot cover the amount. Fund it or reduce the amount before executing.</Warn>
            </div>
          </Section>

          {/* WALLETS */}
          <Section
            id="wallets"
            eyebrow="Reference"
            title="Wallets and networks"
          >
            <div className="grid gap-3.5 sm:grid-cols-3">
              {[
                { h: 'Auro', b: 'browser', p: <>The Auro browser extension. The standard option; its network follows the extension.</> },
                { h: 'Ledger', b: 'hardware', p: <>A Ledger device over USB (WebHID). The app requests a Vault Index and allows switching networks in the header.</> },
                { h: 'Air-gapped CLI', b: 'offline', p: <>The signing key never goes online. See <a href="#offline" className="text-safe-green hover:opacity-80 underline underline-offset-2">Air-gapped signing</a>.</> },
              ].map((w) => (
                <div key={w.h} className="bg-safe-gray border border-safe-border rounded-xl p-4">
                  <h4 className="flex items-center gap-2 font-semibold text-white mb-2">
                    {w.h}
                    <span className="font-mono text-[0.62rem] uppercase tracking-[0.08em] text-safe-green border border-safe-green/30 rounded px-1.5 py-0.5">{w.b}</span>
                  </h4>
                  <p className="text-sm text-safe-text leading-relaxed">{w.p}</p>
                </div>
              ))}
            </div>

            <div className="mt-5 space-y-3">
              {[
                { l: 'Blind signing', v: <>Auro and Ledger sign only the proposal <b className="text-white">hash</b>. Confirm the action in the app first; it recomputes and verifies the hash before signing.</> },
                { l: 'Networks', v: <><b className="text-white">Testnet</b> is currently available. Devnet and Mainnet are planned.</> },
              ].map((f) => (
                <div key={f.l} className="flex flex-col sm:flex-row sm:gap-3 text-sm text-safe-text leading-relaxed">
                  <span className="font-mono text-[0.7rem] uppercase tracking-wide text-safe-text/60 sm:min-w-[128px] shrink-0 mb-0.5 sm:mb-0">{f.l}</span>
                  <span>{f.v}</span>
                </div>
              ))}
            </div>

            <div className="mt-10 pt-6 border-t border-safe-border text-sm text-safe-text/70">
              <p className="font-mono text-safe-text">MinaGuard User Guide</p>
              <p className="mt-1.5 max-w-[60ch]">
                Terminology and flows reflect the application as built. Where the interface wording and the
                contract behavior differ, the contract is authoritative.
              </p>
            </div>
          </Section>
        </div>

        {/* ---------- IN-PAGE TOC (right rail, xl+) ---------- */}
        <aside className="hidden xl:block">
          <nav className="sticky top-10 space-y-5">
            {NAV.map((group) => (
              <div key={group.group}>
                <p className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-safe-text/50 mb-2">{group.group}</p>
                <ul className="space-y-0.5 list-none m-0 p-0">
                  {group.items.map((it) => (
                    <li key={it.id}>
                      <a
                        href={`#${it.id}`}
                        className={`block text-sm py-1 pl-3 border-l-2 transition-colors ${
                          active === it.id
                            ? 'text-safe-green border-safe-green'
                            : 'text-safe-text border-transparent hover:text-white'
                        }`}
                      >
                        {it.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
      </div>
    </div>
  );
}
