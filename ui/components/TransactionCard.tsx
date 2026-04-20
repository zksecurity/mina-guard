'use client';

import Link from 'next/link';
import {
  Proposal,
  TX_TYPE_LABELS,
  formatMina,
  isDeleteProposal,
} from '@/lib/types';
import ApprovalProgress from './ApprovalProgress';

interface TransactionCardProps {
  proposal: Proposal;
  index: number;
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
  index,
  threshold,
  owners,
}: TransactionCardProps) {
  const timeAgo = getTimeAgo(new Date(proposal.createdAt).getTime());
  const label = isDeleteProposal(proposal)
    ? 'Delete proposal'
    : proposal.txType ? TX_TYPE_LABELS[proposal.txType] : 'Unknown';

  return (
    <Link href={`/transactions/${proposal.proposalHash}`}>
      <div className="border border-safe-border rounded-lg p-4 card-hover cursor-pointer">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-safe-gray border border-safe-border flex items-center justify-center text-safe-text">
              <span className="text-xs font-mono">#{index}</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusColors[proposal.status]}`}>
                  {proposal.status}
                </span>
              </div>
              {proposal.txType === 'transfer' && !isDeleteProposal(proposal) && (
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
