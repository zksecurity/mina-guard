'use client';

import { useState } from 'react';

const CONFIRM_PHRASE = 'WIPE LOCAL DATA';

interface Props {
  initial: { minaEndpoint: string; archiveEndpoint: string };
  onClose: () => void;
}

export default function NodeEndpointsModal({ initial, onClose }: Props) {
  const [mina, setMina] = useState(initial.minaEndpoint);
  const [archive, setArchive] = useState(initial.archiveEndpoint);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const changed = mina !== initial.minaEndpoint || archive !== initial.archiveEndpoint;
  const confirmed = confirm.trim() === CONFIRM_PHRASE;
  const canSubmit = changed && confirmed && !submitting;

  function validate(): string | null {
    for (const [label, value] of [['Mina', mina], ['Archive', archive]] as const) {
      try {
        const u = new URL(value);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${label} URL must use http or https`;
      } catch {
        return `${label} URL is not valid`;
      }
    }
    return null;
  }

  async function handleSubmit() {
    const v = validate();
    if (v) { setError(v); return; }
    setError(null);
    setSubmitting(true);
    const bridge = typeof window !== 'undefined' ? window.minaGuardConfig : undefined;
    if (!bridge) {
      setError('This feature is only available in the desktop app.');
      setSubmitting(false);
      return;
    }
    try {
      await bridge.setEndpoints({ minaEndpoint: mina.trim(), archiveEndpoint: archive.trim() });
      // The Electron main process relaunches the app; this promise typically
      // never resolves because the process is killed first. If we do return,
      // something went wrong.
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-safe-dark border border-safe-border rounded-xl p-6 w-full max-w-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h4 className="text-base font-semibold">Change node endpoints</h4>

        <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-300 space-y-2">
          <p className="font-semibold text-red-200">Local data only — on-chain state is not affected.</p>
          <p>
            Changing the node endpoints wipes the app&apos;s local index (cached proposals, event history, contract
            discovery cache, indexer cursor). Your zkApp accounts, proposals, approvals, and balances live on the Mina
            chain and are not touched by this action. After the restart, the app will re-index from the new endpoints.
          </p>
          <p>The application will restart.</p>
        </div>

        <label className="block text-xs font-medium mt-5 mb-1.5">Mina node GraphQL URL</label>
        <input
          type="text"
          value={mina}
          onChange={(e) => setMina(e.target.value)}
          spellCheck={false}
          className="w-full px-3 py-2 bg-safe-gray border border-safe-border rounded-lg font-mono text-xs text-white focus:outline-none focus:border-safe-green"
        />

        <label className="block text-xs font-medium mt-3 mb-1.5">Archive node GraphQL URL</label>
        <input
          type="text"
          value={archive}
          onChange={(e) => setArchive(e.target.value)}
          spellCheck={false}
          className="w-full px-3 py-2 bg-safe-gray border border-safe-border rounded-lg font-mono text-xs text-white focus:outline-none focus:border-safe-green"
        />

        <label className="block text-xs font-medium mt-4 mb-1.5">
          Type <span className="font-mono text-safe-green">{CONFIRM_PHRASE}</span> to confirm
        </label>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          spellCheck={false}
          autoComplete="off"
          className="w-full px-3 py-2 bg-safe-gray border border-safe-border rounded-lg font-mono text-xs text-white focus:outline-none focus:border-safe-green"
        />

        {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

        <div className="flex gap-3 mt-5">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 p-2.5 border border-safe-border rounded-lg text-sm text-safe-text hover:text-white hover:border-safe-text transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 p-2.5 bg-safe-green text-black rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Restarting...' : 'Wipe and restart'}
          </button>
        </div>
      </div>
    </div>
  );
}
