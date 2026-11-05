import { describe, expect, it } from 'bun:test';
import { bugReportUrl } from '../lib/bug-report';

const fields = (url: string) => new URL(url).searchParams;

describe('bug report link', () => {
  it('opens the bug form filled with the build, network, page, wallet and browser', () => {
    const params = fields(bugReportUrl({
      version: '0.1.0', commit: 'abc1234', network: 'mainnet', page: '/accounts/B62q?tab=owners#x',
      wallet: 'ledger', browser: 'Mozilla/5.0 Test', error: 'Execution failed.',
    }));
    expect(new URL(bugReportUrl({})).origin + new URL(bugReportUrl({})).pathname)
      .toBe('https://github.com/zksecurity/mina-guard/issues/new');
    expect(params.get('template')).toBe('bug_report.yml');
    expect(params.get('version')).toBe('v0.1.0 abc1234');
    expect(params.get('network')).toBe('mainnet');
    expect(params.get('page')).toBe('/accounts/B62q');
    expect(params.get('wallet')).toBe('Ledger');
    expect(params.get('browser')).toBe('Mozilla/5.0 Test');
    expect(params.get('error')).toBe('Execution failed.');
  });

  it('leaves out unknown details and caps long error messages', () => {
    const params = fields(bugReportUrl({ error: 'x'.repeat(5000) }));
    expect(params.has('version')).toBe(false);
    expect(params.has('network')).toBe(false);
    expect(params.get('wallet')).toBe('Not connected');
    expect(params.get('error')).toHaveLength(1000);
  });
});
