/**
 * Builds a link to a new GitHub issue from .github/ISSUE_TEMPLATE/bug_report.yml
 * with the details a maintainer would otherwise have to ask for. Opening the
 * link sends these details to GitHub to fill in the form; the reporter can
 * edit them, and nothing is posted until they submit.
 */
import { getMinaGuardConfig } from './endpoints';

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

/** The network this UI talks to: the desktop app injects its runtime choice. */
function activeNetwork(): string | undefined {
  try {
    return getMinaGuardConfig().networkId;
  } catch {
    return process.env.NEXT_PUBLIC_MINA_NETWORK;
  }
}

/**
 * The current build details. Browser-only details (the runtime network and the
 * user agent) are added only when `inBrowser` is true, so a server render and
 * the first client render produce the same link.
 */
export function currentBugReportUrl(
  details: { page: string; wallet?: string | null; error?: string | null },
  inBrowser = true,
): string {
  return bugReportUrl({
    version: process.env.NEXT_PUBLIC_APP_VERSION,
    commit: process.env.NEXT_PUBLIC_COMMIT_SHA,
    network: inBrowser ? activeNetwork() : process.env.NEXT_PUBLIC_MINA_NETWORK,
    browser: inBrowser ? navigator.userAgent : undefined,
    ...details,
  });
}
