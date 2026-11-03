/**
 * Builds a link to a new GitHub issue from .github/ISSUE_TEMPLATE/bug_report.yml
 * with the details a maintainer would otherwise have to ask for. The reporter
 * sees and can edit every field before submitting; nothing is sent until then.
 */
const NEW_ISSUE = 'https://github.com/zksecurity/mina-guard/issues/new';
const MAX_ERROR = 1000;

export interface BugReportContext {
  version?: string;
  commit?: string;
  network?: string;
  /** Path only; the query string is dropped. */
  page?: string;
  wallet?: string | null;
  browser?: string;
  error?: string | null;
}

export function bugReportUrl(context: BugReportContext): string {
  const params = new URLSearchParams({ template: 'bug_report.yml' });
  const version = [context.version && `v${context.version}`, context.commit].filter(Boolean).join(' ');
  const fields: Record<string, string | null | undefined> = {
    version,
    network: context.network,
    page: context.page?.split(/[?#]/)[0],
    wallet: context.wallet ? context.wallet[0].toUpperCase() + context.wallet.slice(1) : 'Not connected',
    browser: context.browser,
    error: context.error ? context.error.slice(0, MAX_ERROR) : undefined,
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value) params.set(name, value);
  }
  return `${NEW_ISSUE}?${params}`;
}

/** The current build and browser details, for use in client components. */
export function currentBugReportUrl(details: { page: string; wallet?: string | null; error?: string | null }): string {
  return bugReportUrl({
    version: process.env.NEXT_PUBLIC_APP_VERSION,
    commit: process.env.NEXT_PUBLIC_COMMIT_SHA,
    network: process.env.NEXT_PUBLIC_MINA_NETWORK,
    browser: typeof navigator === 'undefined' ? undefined : navigator.userAgent,
    ...details,
  });
}
