'use client';

const REPO = 'https://github.com/zksecurity/mina-guard';
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? '';
const COMMIT = process.env.NEXT_PUBLIC_COMMIT_SHA ?? '';

const Dot = () => (
  <span aria-hidden className="text-safe-border">
    &middot;
  </span>
);

/**
 * Global app footer: copyright, a link to the standalone guide (new tab), the
 * source repo, and the build stamp. Lives in the app shell, so it never renders
 * on the standalone /guide route.
 */
export default function AppFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="shrink-0 border-t border-safe-border px-6 py-4">
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-safe-text">
        <span>&copy; {year} zkSecurity</span>

        <Dot />

        <a
          href="/guide"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-medium transition-colors hover:text-white"
          title="Open the user guide in a new tab"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.746 0 3.332.477 4.5 1.253v13C19.832 18.477 18.246 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          User guide
          <svg className="h-3 w-3 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14 5h5m0 0v5m0-5L10 14M9 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-3" />
          </svg>
        </a>

        <Dot />

        <a
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-medium transition-colors hover:text-white"
          title="Source on GitHub"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
            <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.23 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0024 12.5C24 5.87 18.63.5 12 .5z" />
          </svg>
          GitHub
        </a>

        {VERSION && (
          <>
            <Dot />
            {COMMIT ? (
              <a
                href={`${REPO}/commit/${COMMIT}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono transition-colors hover:text-white"
                title="This build's commit"
              >
                v{VERSION} &middot; {COMMIT}
              </a>
            ) : (
              <span className="font-mono">v{VERSION}</span>
            )}
          </>
        )}
      </div>
    </footer>
  );
}
