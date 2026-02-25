'use client';

import { Transaction } from '@/lib/types';
import TransactionCard from './TransactionCard';

interface TransactionListProps {
  transactions: Transaction[];
  threshold: number;
  owners: string[];
  emptyMessage?: string;
}

export default function TransactionList({
  transactions,
  threshold,
  owners,
  emptyMessage = 'No transactions yet',
}: TransactionListProps) {
  if (transactions.length === 0) {
    return (
      <div className="text-center py-12">
        <svg
          className="w-12 h-12 mx-auto text-safe-border mb-3"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <p className="text-safe-text text-sm">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {transactions.map((tx) => (
        <TransactionCard
          key={tx.id}
          tx={tx}
          threshold={threshold}
          owners={owners}
        />
      ))}
    </div>
  );
}
