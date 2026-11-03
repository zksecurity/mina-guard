import Link from 'next/link';

/** Shown wherever a visitor can connect a wallet: connecting accepts the terms. */
export default function ConnectTerms({ className = '' }: { className?: string }) {
  return (
    <p className={`text-xs text-safe-text ${className}`}>
      By connecting a wallet, you agree to the{' '}
      <Link href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-white">Terms</Link>{' '}
      and acknowledge the{' '}
      <Link href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-white">Privacy Policy</Link>.
    </p>
  );
}
