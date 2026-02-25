'use client';

import { useState, useEffect, useCallback } from 'react';
import { Transaction, TxStatus, TxType } from '@/lib/types';
import {
  getTransactions,
  addTransaction as addTx,
  updateTransaction as updateTx,
} from '@/lib/storage';

// Demo transactions for UI development
const DEMO_TRANSACTIONS: Transaction[] = [
  {
    id: '0',
    to: 'B62qjsVMsLjG75MViqXznhVGs3pGA1HfpqzxGDDMPaLQe11DEHiCJSN',
    amount: '2000000000',
    tokenId: '0',
    txType: 'transfer',
    data: '0',
    nonce: '0',
    txHash: '15924758234905723409857',
    status: 'pending',
    approvals: [
      'B62qpRzFVjd56FiHnNfxokVbcHMQLT119My1FEdSq8ss7KomLiSZcan',
    ],
    proposer:
      'B62qpRzFVjd56FiHnNfxokVbcHMQLT119My1FEdSq8ss7KomLiSZcan',
    createdAt: Date.now() - 3600000,
  },
  {
    id: '1',
    to: 'B62qkUHaJUHERZuCHQhXCQ8xsGBqyYSgjQsKnKN5HhSJecakuJ4pYyk',
    amount: '5000000000',
    tokenId: '0',
    txType: 'transfer',
    data: '0',
    nonce: '1',
    txHash: '28347592345897234598',
    status: 'executed',
    approvals: [
      'B62qpRzFVjd56FiHnNfxokVbcHMQLT119My1FEdSq8ss7KomLiSZcan',
      'B62qjsVMsLjG75MViqXznhVGs3pGA1HfpqzxGDDMPaLQe11DEHiCJSN',
    ],
    proposer:
      'B62qjsVMsLjG75MViqXznhVGs3pGA1HfpqzxGDDMPaLQe11DEHiCJSN',
    createdAt: Date.now() - 86400000,
    executedAt: Date.now() - 82800000,
  },
  {
    id: '2',
    to: '',
    amount: '0',
    tokenId: '0',
    txType: 'changeThreshold',
    data: '3',
    nonce: '2',
    txHash: '39458723495872349587',
    status: 'pending',
    approvals: [
      'B62qpRzFVjd56FiHnNfxokVbcHMQLT119My1FEdSq8ss7KomLiSZcan',
      'B62qjsVMsLjG75MViqXznhVGs3pGA1HfpqzxGDDMPaLQe11DEHiCJSN',
    ],
    proposer:
      'B62qpRzFVjd56FiHnNfxokVbcHMQLT119My1FEdSq8ss7KomLiSZcan',
    createdAt: Date.now() - 1800000,
  },
];

export function useTransactions(multisigAddress: string | null) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Load transactions
  useEffect(() => {
    if (!multisigAddress) {
      setTransactions([]);
      return;
    }

    setIsLoading(true);
    const saved = getTransactions(multisigAddress);
    if (saved.length > 0) {
      setTransactions(saved);
    } else {
      // Initialize with demo transactions
      setTransactions(DEMO_TRANSACTIONS);
    }
    setIsLoading(false);
  }, [multisigAddress]);

  const addTransaction = useCallback(
    (tx: Transaction) => {
      if (!multisigAddress) return;
      addTx(multisigAddress, tx);
      setTransactions((prev) => [...prev, tx]);
    },
    [multisigAddress]
  );

  const updateTransaction = useCallback(
    (txId: string, updates: Partial<Transaction>) => {
      if (!multisigAddress) return;
      updateTx(multisigAddress, txId, updates);
      setTransactions((prev) =>
        prev.map((t) => (t.id === txId ? { ...t, ...updates } : t))
      );
    },
    [multisigAddress]
  );

  const getByStatus = useCallback(
    (status: TxStatus) => {
      return transactions.filter((t) => t.status === status);
    },
    [transactions]
  );

  const pendingCount = transactions.filter(
    (t) => t.status === 'pending'
  ).length;

  return {
    transactions,
    isLoading,
    addTransaction,
    updateTransaction,
    getByStatus,
    pendingCount,
  };
}
