'use client';

interface ThresholdBadgeProps {
  threshold: number;
  numOwners: number;
  size?: 'sm' | 'md' | 'lg';
}

export default function ThresholdBadge({
  threshold,
  numOwners,
  size = 'md',
}: ThresholdBadgeProps) {
  const sizeClasses = {
    sm: 'text-xs px-2 py-0.5',
    md: 'text-sm px-3 py-1',
    lg: 'text-base px-4 py-1.5',
  };

  return (
    <span
      className={`inline-flex items-center gap-1 bg-safe-gray border border-safe-border rounded-full font-mono ${sizeClasses[size]}`}
    >
      <span className="text-safe-green font-semibold">{threshold}</span>
      <span className="text-safe-text">/</span>
      <span className="text-white">{numOwners}</span>
    </span>
  );
}
