/** Hover tooltip warning that the on-chain transaction memo is set by whoever
 *  executes the proposal — it may differ from the memo entered here, which is
 *  only committed to the proposal hash (off-chain plaintext, on-chain hash). */
export default function MemoWarningTooltip() {
  return (
    <span className="relative group">
      <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-yellow-400/40 text-[10px] leading-none text-yellow-400 cursor-help">⚠</span>
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 z-50 transition-all duration-200 pointer-events-none opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0">
        <div className="bg-safe-green/70 backdrop-blur-md text-white text-xs font-semibold rounded-lg px-3 py-2 shadow-lg w-80">
          The final transaction memo on-chain is set by whoever executes the proposal and may differ.
        </div>
        <svg className="mx-auto -mt-px" width="10" height="6" viewBox="0 0 10 6">
          <path d="M0 0L5 6L10 0Z" className="fill-safe-green/70" />
        </svg>
      </div>
    </span>
  );
}
