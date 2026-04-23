'use client';

import Link from 'next/link';
import {
  Proposal,
  TX_TYPE_LABELS,
  formatMina,
  isDeleteProposal,
  truncateAddress,
} from '@/lib/types';
import ApprovalProgress from './ApprovalProgress';

interface TransactionCardProps {
  proposal: Proposal;
  threshold: number;
  owners: string[];
}

const statusColors = {
  pending: 'text-yellow-400 bg-yellow-400/10',
  executed: 'text-safe-green bg-safe-green/10',
  expired: 'text-red-400 bg-red-400/10',
  invalidated: 'text-orange-400 bg-orange-400/10',
};

/** Compact proposal list card used on dashboard and transactions pages. */
export default function TransactionCard({
  proposal,
  threshold,
  owners,
}: TransactionCardProps) {
  const timeAgo = getTimeAgo(new Date(proposal.createdAt).getTime());
  const label = isDeleteProposal(proposal)
    ? 'Delete proposal'
    : proposal.txType ? TX_TYPE_LABELS[proposal.txType] : 'Unknown';
  const attemptError =
    proposal.status === 'pending'
      ? proposal.lastExecuteError ?? proposal.lastApproveError
      : null;
  const attemptErrorKind = proposal.lastExecuteError ? 'Execute' : 'Approve';
  const isRemote = proposal.destination === 'remote';
  const isDelete = isDeleteProposal(proposal);
  const nonceLabel = proposal.nonce != null ? `#${proposal.nonce}` : '#?';
  const badgeClass = isRemote
    ? 'bg-indigo-500/15 border-indigo-400/40 text-indigo-300'
    : 'bg-safe-gray border-safe-border text-safe-text';
  const secondaryLine = isDelete
    ? proposal.nonce != null
      ? `Invalidates proposal with nonce #${proposal.nonce}`
      : 'Invalidates another proposal'
    : isRemote
      ? proposal.childAccount
        ? `Executes on subaccount ${truncateAddress(proposal.childAccount)}`
        : 'Executes on subaccount'
      : 'Executes on this account';

  return (
    <Link href={`/transactions/${proposal.proposalHash}`}>
      <div className="border border-safe-border rounded-lg p-4 card-hover cursor-pointer">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className={`w-10 h-10 rounded-lg border flex items-center justify-center ${badgeClass}`}>
              <span className="text-xs font-mono">{nonceLabel}</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusColors[proposal.status]}`}>
                  {proposal.status}
                </span>
                {attemptError && (
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded-full text-red-300 bg-red-400/10 border border-red-400/30"
                    title={`${attemptErrorKind}: ${attemptError}`}
                  >
                    last attempt failed
                  </span>
                )}
              </div>
              <p className="text-xs text-safe-text mt-0.5">{secondaryLine}</p>
              {proposal.txType === 'transfer' && !isDelete && (
                <p className="text-xs text-safe-text mt-0.5">
                  {proposal.recipientCount} recipients · {formatMina(proposal.totalAmount)} MINA
                </p>
              )}
              {proposal.txType === 'changeThreshold' && (
                <p className="text-xs text-safe-text mt-0.5">Change threshold to {proposal.data ?? '?'}</p>
              )}
              {(proposal.txType === 'addOwner' || proposal.txType === 'removeOwner') && (
                <p className="text-xs text-safe-text mt-0.5">Owner governance request</p>
              )}
              {proposal.txType === 'setDelegate' && (
                <p className="text-xs text-safe-text mt-0.5">Delegate update request</p>
              )}
              <p className="text-[10px] text-safe-text mt-1">{timeAgo}</p>
            </div>
          </div>

          <ApprovalProgress
            approvalCount={proposal.approvalCount}
            threshold={threshold}
            owners={owners}
            compact
            status={proposal.status}
          />
        </div>
      </div>
    </Link>
  );
}

/** Converts timestamps to compact relative-age labels. */
function getTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
