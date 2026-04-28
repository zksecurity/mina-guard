type Variant = 'warning' | 'proposalMismatch' | 'match' | 'mismatch';

const VARIANTS: Record<
  Variant,
  { glyph: string; color: string; border: string; text: string }
> = {
  warning: {
    glyph: '⚠',
    color: 'text-yellow-400',
    border: 'border-yellow-400/40',
    text: 'The memo shown was decoded from the transaction but does not match the on-chain hash. It may have been altered, or the wallet encoded it differently. The executor will still attach this memo — verify it before approving.',
  },
  proposalMismatch: {
    glyph: '⚠',
    color: 'text-yellow-400',
    border: 'border-yellow-400/40',
    text: 'The proposal memo does not match its on-chain hash. The proposer may have used a different memo than what was hashed into the proposal.',
  },
  match: {
    glyph: '✓',
    color: 'text-safe-green',
    border: 'border-safe-green/40',
    text: 'Memo verified: proposal memo, on-chain hash, and execution memo all match.',
  },
  mismatch: {
    glyph: '✗',
    color: 'text-red-400',
    border: 'border-red-400/40',
    text: 'Memo error: the proposal memo, on-chain hash, or execution memo do not all match.',
  },
};

export default function MemoWarningTooltip({ variant = 'warning' }: { variant?: Variant }) {
  const v = VARIANTS[variant];
  return (
    <span className="relative group">
      <span className={`inline-flex items-center justify-center w-4 h-4 rounded-full border ${v.border} text-[10px] leading-none ${v.color} cursor-help`}>{v.glyph}</span>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 transition-all duration-200 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0">
        <div className="bg-safe-green/70 backdrop-blur-md text-white text-xs font-semibold rounded-lg px-3 py-2 shadow-lg w-80">
          {v.text}
        </div>
        <svg className="mx-auto -mt-px" width="10" height="6" viewBox="0 0 10 6">
          <path d="M0 0L5 6L10 0Z" className="fill-safe-green/70" />
        </svg>
      </div>
    </span>
  );
}
