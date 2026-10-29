import Link from 'next/link';

/** Product status is visible on every network, in the app and standalone guide. */
export default function BetaNotice({ showGuideLink = true }: { showGuideLink?: boolean }) {
  return (
    <aside
      aria-label="Beta product notice"
      className="border-b border-safe-border bg-safe-green/10 px-4 py-2.5 text-center text-xs leading-relaxed text-safe-text sm:text-[13px]"
    >
      <span
        aria-hidden="true"
        className="mr-2 inline-flex rounded-full bg-safe-green px-2 py-px align-middle text-[11px] font-semibold tracking-wide text-safe-dark"
      >
        BETA
      </span>
      MinaGuard is in beta, including on Mainnet.{' '}
      <strong className="font-semibold text-white">You could lose funds</strong> if the
      software fails.
      {showGuideLink && (
        <>
          {' '}
          <Link
            href="/guide#beta"
            className="text-safe-green underline underline-offset-2 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-safe-green"
          >
            Read the beta guide
          </Link>
        </>
      )}
    </aside>
  );
}
