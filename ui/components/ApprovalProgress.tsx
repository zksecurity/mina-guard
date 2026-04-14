'use client';

import { truncateAddress, type ProposalStatus } from '@/lib/types';

interface ApprovalProgressProps {
  approvalCount: number;
  threshold: number;
  owners: string[];
  approvalAddresses?: string[];
  compact?: boolean;
  status?: ProposalStatus;
}

/** Renders proposal approval progress using either counts or explicit approver addresses. */
export default function ApprovalProgress({
  approvalCount,
  threshold,
  owners,
  approvalAddresses = [],
  compact = false,
  status = 'pending',
}: ApprovalProgressProps) {
  const approvals = Math.min(approvalCount, Math.max(threshold, approvalCount));
  const progress = threshold > 0 ? Math.min((approvals / threshold) * 100, 100) : 0;
  const isComplete = threshold > 0 && approvals >= threshold;
  // For non-pending proposals the current threshold is irrelevant (proposal
  // already executed or expired under whatever threshold applied at the time).
  const showThreshold = status === 'pending';

  if (compact) {
    // For non-pending proposals show only the approvers' chips — rendering the
    // full owner set would leak the current threshold indirectly and implies
    // the proposal was compared against today's owners rather than the set
    // that existed at execute time.
    const chips = showThreshold
      ? owners.map((owner, i) => ({
          owner,
          label: String(i + 1),
          approved: approvalAddresses.length
            ? approvalAddresses.includes(owner)
            : i < approvals,
        }))
      : (approvalAddresses.length ? approvalAddresses : owners.slice(0, approvals)).map(
          (owner, i) => ({ owner, label: String(i + 1), approved: true })
        );

    return (
      <div className="flex items-center gap-2">
        <div className="flex -space-x-1">
          {chips.map((chip) => (
            <div
              key={chip.owner}
              className={`w-6 h-6 rounded-full border-2 flex items-center justify-center text-[8px] font-bold ${
                chip.approved
                  ? 'bg-safe-green border-safe-green text-safe-dark'
                  : 'bg-safe-gray border-safe-border text-safe-text'
              }`}
              title={chip.owner}
            >
              {chip.label}
            </div>
          ))}
        </div>
        <span className={`text-xs font-mono ${isComplete ? 'text-safe-green' : 'text-safe-text'}`}>
          {showThreshold ? `${approvals}/${threshold}` : approvals}
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {showThreshold ? (
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
      ) : (
        <div className="text-sm font-mono text-safe-text">
          {approvals} confirmation{approvals === 1 ? '' : 's'}
        </div>
      )}

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
