import { expect, type Page } from '@playwright/test';
import { MOCK_WALLET_SCRIPT } from '../wallet-mock';
import { WALLET } from './fixtures';

/** Injects the mock wallet with the fixture user connected. Call before goto. */
export async function connectWallet(page: Page, address: string = WALLET): Promise<void> {
  await page.addInitScript(MOCK_WALLET_SCRIPT);
  await page.addInitScript(`window.__testActiveAddress = ${JSON.stringify(address)};`);
}

/** Client-side navigation via the app's e2e hook (avoids a full reload). */
export async function navigateTo(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => (window as any).__e2eNavigate(p), path);
  await page.waitForFunction(
    (expected) => (window as any).__e2ePathname() === expected.split('?')[0],
    path,
    { timeout: 30_000 }
  );
  await page.waitForLoadState('networkidle');
}

/**
 * Opens a vault's dashboard and waits for it to render. Visiting the account
 * page also makes it the app's active contract, which /transactions and
 * /settings pages read from context.
 */
export async function openVault(page: Page, address: string): Promise<void> {
  await page.goto(`/accounts/${address}`);
  await expect(page.locator('text=Block Producer Delegate')).toBeVisible({ timeout: 60_000 });
}

/** Locates a transactions-page status tab button. */
export function statusTab(page: Page, label: RegExp) {
  return page.locator('button', { hasText: label }).first();
}

// ---------------------------------------------------------------------------
// Proposal-form helpers
// ---------------------------------------------------------------------------

/** Opens /transactions/new for a tx type with the given vault active. */
export async function openProposalForm(
  page: Page,
  vault: string,
  type: string
): Promise<void> {
  await openVault(page, vault);
  await navigateTo(page, `/transactions/new?type=${type}`);
}

/** Fills the recipients section via its Bulk mode (`address,amount` lines). */
export async function fillRecipients(page: Page, content: string): Promise<void> {
  const textarea = page.locator('textarea').first();
  if (!(await textarea.isVisible().catch(() => false))) {
    await page.getByRole('button', { name: 'Bulk', exact: true }).click();
    await textarea.waitFor({ state: 'visible', timeout: 5_000 });
  }
  await textarea.fill(content);
}

/** Fills the expiry input (placeholder "0") if the form renders one. */
export async function setExpiry(page: Page, value: string | number = 0): Promise<void> {
  const expiryInput = page.locator('input[placeholder="0"]');
  if ((await expiryInput.count()) > 0) {
    await expiryInput.first().fill(String(value));
  }
}

/** Enables capture mode: worker-bound calls are recorded instead of executed. */
export async function enableWorkerCapture(page: Page): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as any).__e2eCaptureWorkerCalls === 'function',
    { timeout: 30_000 }
  );
  await page.evaluate(() => (window as any).__e2eCaptureWorkerCalls(true));
}

export interface CapturedCall {
  method: string;
  params: any;
}

/** Clicks submit and returns the single captured worker call it produced. */
export async function submitAndCapture(
  page: Page,
  submitName: RegExp = /submit proposal/i
): Promise<CapturedCall> {
  await page.getByRole('button', { name: submitName }).click();
  await page.waitForFunction(
    () => ((window as any).__e2eWorkerCalls ?? []).length > 0,
    { timeout: 30_000 }
  );
  const calls: CapturedCall[] = await page.evaluate(() => (window as any).__e2eWorkerCalls);
  expect(calls).toHaveLength(1);
  return calls[0];
}

/** Asserts that clicking submit produced a form error and no worker call. */
export async function submitExpectingRejection(
  page: Page,
  error: RegExp,
  submitName: RegExp = /submit proposal/i
): Promise<void> {
  await page.getByRole('button', { name: submitName }).click();
  await page.waitForTimeout(500);
  expect(await page.textContent('body')).toMatch(error);
  const calls = await page.evaluate(() => ((window as any).__e2eWorkerCalls ?? []).length);
  expect(calls, 'no worker call should have been made').toBe(0);
}
