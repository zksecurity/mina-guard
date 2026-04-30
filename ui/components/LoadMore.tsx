'use client';

interface LoadMoreProps {
  visibleCount: number;
  totalCount: number;
  onClick: () => void;
}

export default function LoadMore({ visibleCount, totalCount, onClick }: LoadMoreProps) {
  if (visibleCount >= totalCount) return null;
  return (
    <div className="flex flex-col items-center gap-1 py-3">
      <button
        type="button"
        onClick={onClick}
        className="text-sm text-safe-green hover:brightness-110 font-semibold px-4 py-1.5 rounded-md border border-safe-border bg-safe-gray hover:bg-safe-hover transition-colors"
      >
        Load more
      </button>
      <span className="text-[10px] text-safe-text">
        Showing {visibleCount} of {totalCount}
      </span>
    </div>
  );
}
