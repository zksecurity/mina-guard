'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { choosePreflight, getPreflightView, mountPreflight, subscribePreflight } from '@/lib/preflight-flow';

export default function TransactionPreflightPanel() {
  const state = useSyncExternalStore(subscribePreflight, getPreflightView, () => null);
  useEffect(mountPreflight, []);
  if (!state) return null;
  const checking = state.kind === 'checking';
  const title = checking ? 'Checking latest vault state…'
    : state.kind === 'stores' ? 'Vault data isn’t up to date'
    : state.kind === 'existing' ? 'Proposal already exists'
    : state.kind === 'executed' ? 'Proposal already executed'
    : state.kind === 'review' ? 'Review the original request'
    : state.kind === 'invalid' ? 'This action is no longer available'
    : state.kind === 'unavailable' ? 'Couldn’t check the vault'
    : state.offline ? 'This transaction needs a new proof' : 'The vault changed';
  const message = checking ? 'Checking that the vault still matches before sending this transaction.'
    : state.kind === 'stores' ? 'Nothing was sent. The indexed data doesn’t match the blockchain yet. Wait a moment, then retry.'
    : state.kind === 'existing' ? 'This proposal has already been created. Your transaction wasn’t sent. Open the existing proposal to see its status.'
    : state.kind === 'executed' ? 'This proposal has already been executed. Your transaction wasn’t sent and is no longer needed.'
    : state.kind === 'review' ? `${state.message} Your transaction wasn’t sent.`
    : state.kind === 'invalid' ? `${state.message || 'The proposal is no longer eligible.'} Your transaction wasn’t sent.`
    : state.kind === 'unavailable' ? 'Nothing was sent. The node or indexed state could not be verified. Retry the check when they are available.'
    : state.offline ? 'The vault changed since this file was signed. Nothing was sent. Export a fresh request, sign it offline, then upload the new signed file.'
    : 'Your transaction wasn’t sent. Rebuild it using the latest vault state. You may need to sign again in your wallet.';
  return <div role="status" className={`rounded-xl border p-5 my-4 text-sm ${state.kind === 'stale' ? 'border-amber-400/40 bg-amber-400/10' : 'border-safe-border bg-safe-gray'}`}>
    <h3 className="font-semibold mb-2">{title}</h3>
    <p className="text-safe-text leading-relaxed">{message}</p>
    {state.kind === 'stale' && state.offline && !state.canRebuild && <p className="text-safe-text mt-2">Return to the proposal form to review and export a fresh request.</p>}
    {!checking && <div className="flex flex-wrap gap-3 mt-4">
      {state.kind === 'existing' && state.proposalHash && <a className="bg-safe-green text-safe-dark font-semibold px-4 py-2 rounded-lg" href={`/transactions/${encodeURIComponent(state.proposalHash)}`} onClick={() => choosePreflight('cancel')}>View proposal</a>}
      {state.kind === 'stores' && <button className="bg-safe-green text-safe-dark font-semibold px-4 py-2 rounded-lg" onClick={() => choosePreflight('retry')}>Retry</button>}
      {state.kind === 'stale' && state.canRebuild && <button className="bg-safe-green text-safe-dark font-semibold px-4 py-2 rounded-lg" onClick={() => choosePreflight('rebuild')}>{state.offline ? 'Export fresh request' : 'Rebuild transaction'}</button>}
      {state.kind === 'unavailable' && <button className="bg-safe-green text-safe-dark font-semibold px-4 py-2 rounded-lg" onClick={() => choosePreflight('retry')}>Retry check</button>}
      {state.kind === 'executed' && state.executionHash && process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL && <a className="text-safe-green underline py-2" href={`${process.env.NEXT_PUBLIC_BLOCK_EXPLORER_URL}/tx/${encodeURIComponent(state.executionHash)}?type=zk-tx`} target="_blank" rel="noopener noreferrer">View execution</a>}
      {state.kind === 'executed' && !state.executionHash && <span className="text-safe-text py-2">Executed · transaction details syncing</span>}
      <button className="border border-safe-border px-4 py-2 rounded-lg" onClick={() => choosePreflight('cancel')}>{state.kind === 'existing' || state.kind === 'executed' || state.kind === 'invalid' || state.kind === 'review' ? 'Dismiss' : 'Cancel'}</button>
    </div>}
  </div>;
}
