'use client';

import { truncateAddress } from '@/lib/types';

interface ApprovalProgressProps {
  approvalCount: number;
  threshold: number;
  owners: string[];
  approvalAddresses?: string[];
  compact?: boolean;
}

/** Renders proposal approval progress using either counts or explicit approver addresses. */
export default function ApprovalProgress({
  approvalCount,
  threshold,
  owners,
  approvalAddresses = [],
  compact = false,
}: ApprovalProgressProps) {
  const approvals = Math.min(approvalCount, Math.max(threshold, approvalCount));
  const progress = threshold > 0 ? Math.min((approvals / threshold) * 100, 100) : 0;
  const isComplete = threshold > 0 && approvals >= threshold;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex -space-x-1">
          {owners.map((owner, i) => {
            const approved = approvalAddresses.length
              ? approvalAddresses.includes(owner)
              : i < approvals;
            return (
              <div
                key={owner}
                className={`w-6 h-6 rounded-full border-2 flex items-center justify-center text-[8px] font-bold ${
                  approved
                    ? 'bg-safe-green border-safe-green text-safe-dark'
                    : 'bg-safe-gray border-safe-border text-safe-text'
                }`}
                title={owner}
              >
                {i + 1}
              </div>
            );
          })}
        </div>
        <span className={`text-xs font-mono ${isComplete ? 'text-safe-green' : 'text-safe-text'}`}>
          {approvals}/{threshold}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-safe-gray rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isComplete ? 'bg-safe-green' : 'bg-yellow-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className={`text-sm font-mono ${isComplete ? 'text-safe-green' : 'text-safe-text'}`}>
          {approvals}/{threshold}
        </span>
      </div>

      <div className="space-y-1.5">
        {owners.map((owner, i) => {
          const approved = approvalAddresses.length
            ? approvalAddresses.includes(owner)
            : i < approvals;

          return (
            <div key={owner} className="flex items-center gap-2 text-sm">
              {approved ? (
                <svg className="w-4 h-4 text-safe-green" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-4 h-4 text-safe-text" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              <span className={`font-mono text-xs ${approved ? 'text-white' : 'text-safe-text'}`}>
                {truncateAddress(owner)}
              </span>
              {approved && <span className="text-[10px] text-safe-green ml-auto">Confirmed</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
