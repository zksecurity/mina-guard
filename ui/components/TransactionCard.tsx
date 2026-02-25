'use client';

import Link from 'next/link';
import {
  Transaction,
  TX_TYPE_LABELS,
  truncateAddress,
  formatMina,
} from '@/lib/types';
import ApprovalProgress from './ApprovalProgress';

interface TransactionCardProps {
  tx: Transaction;
  threshold: number;
  owners: string[];
}

const statusColors = {
  pending: 'text-yellow-400 bg-yellow-400/10',
  executed: 'text-safe-green bg-safe-green/10',
  failed: 'text-red-400 bg-red-400/10',
};

const typeIcons: Record<string, JSX.Element> = {
  transfer: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 19V5m0 0l-7 7m7-7l7 7" />
    </svg>
  ),
  addOwner: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
    </svg>
  ),
  removeOwner: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 7a4 4 0 11-8 0 4 4 0 018 0zM9 14a6 6 0 00-6 6v1h12v-1a6 6 0 00-6-6zM21 12h-6" />
    </svg>
  ),
  changeThreshold: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  ),
  registerGuard: (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  ),
};

export default function TransactionCard({
  tx,
  threshold,
  owners,
}: TransactionCardProps) {
  const timeAgo = getTimeAgo(tx.createdAt);

  return (
    <Link href={`/transactions/${tx.id}`}>
      <div className="border border-safe-border rounded-lg p-4 card-hover cursor-pointer">
        <div className="flex items-start justify-between">
          {/* Left: Type icon + details */}
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-safe-gray border border-safe-border flex items-center justify-center text-safe-text">
              {typeIcons[tx.txType] ?? typeIcons.transfer}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  {TX_TYPE_LABELS[tx.txType]}
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusColors[tx.status]}`}
                >
                  {tx.status}
                </span>
              </div>
              {tx.txType === 'transfer' && (
                <p className="text-xs text-safe-text mt-0.5">
                  {formatMina(tx.amount)} MINA to{' '}
                  <span className="font-mono">
                    {truncateAddress(tx.to)}
                  </span>
                </p>
              )}
              {tx.txType === 'changeThreshold' && (
                <p className="text-xs text-safe-text mt-0.5">
                  Change threshold to {tx.data}
                </p>
              )}
              {(tx.txType === 'addOwner' || tx.txType === 'removeOwner') && (
                <p className="text-xs text-safe-text mt-0.5">
                  {tx.txType === 'addOwner' ? 'Add' : 'Remove'} owner
                </p>
              )}
              <p className="text-[10px] text-safe-text mt-1">{timeAgo}</p>
            </div>
          </div>

          {/* Right: Approval progress */}
          <ApprovalProgress
            approvals={tx.approvals}
            threshold={threshold}
            owners={owners}
            compact
          />
        </div>
      </div>
    </Link>
  );
}

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
