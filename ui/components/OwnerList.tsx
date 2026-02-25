'use client';

import { truncateAddress } from '@/lib/types';

interface OwnerListProps {
  owners: string[];
  currentUser: string | null;
  threshold: number;
  onAddOwner?: () => void;
  onRemoveOwner?: (address: string) => void;
}

export default function OwnerList({
  owners,
  currentUser,
  threshold,
  onAddOwner,
  onRemoveOwner,
}: OwnerListProps) {
  const canRemove = owners.length > threshold;

  return (
    <div className="space-y-3">
      {owners.map((owner, i) => {
        const isCurrentUser = currentUser === owner;
        return (
          <div
            key={i}
            className="flex items-center justify-between p-3 bg-safe-gray border border-safe-border rounded-lg"
          >
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-safe-border flex items-center justify-center text-xs font-bold">
                {i + 1}
              </div>
              <div>
                <p className="text-sm font-mono">{truncateAddress(owner, 8)}</p>
                {isCurrentUser && (
                  <span className="text-[10px] text-safe-green">You</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigator.clipboard.writeText(owner)}
                className="p-1.5 text-safe-text hover:text-white transition-colors"
                title="Copy address"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
              {onRemoveOwner && canRemove && (
                <button
                  onClick={() => onRemoveOwner(owner)}
                  className="p-1.5 text-safe-text hover:text-red-400 transition-colors"
                  title="Remove owner"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        );
      })}

      {/* Add owner button */}
      {onAddOwner && (
        <button
          onClick={onAddOwner}
          className="w-full p-3 border border-dashed border-safe-border rounded-lg text-sm text-safe-text hover:text-safe-green hover:border-safe-green transition-colors flex items-center justify-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add New Owner
        </button>
      )}
    </div>
  );
}
