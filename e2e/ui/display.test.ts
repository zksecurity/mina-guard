/**
 * Display/state tests ported from the chain e2e suite (former steps 10, 11,
 * 17, 20, 28, 44, 50, 51 — plus the expired-detail and memo-indicator checks
 * whose chain fixtures were cut earlier). Same assertions against the same
 * real UI, rendered from the seeded DB instead of a live chain.
 */
import { test, expect, type Page } from '@playwright/test';
import { connectWallet, navigateTo, openVault, statusTab } from './ui-helpers';
import {
  TREASURY,
  OPS_CHILD,
  PERSONAL,
  OWNER_2,
  OWNER_3,
  RECIPIENT,
  TREASURY_STATE,
  PROPOSALS,
  MEMOS,
} from './fixtures';

test.beforeEach(async ({ page }) => {
  await connectWallet(page);
});

async function openProposal(page: Page, hash: string): Promise<void> {
  await openVault(page, TREASURY);
  await navigateTo(page, `/transactions/${hash}`);
}

async function expectNoActionButtons(page: Page, names: RegExp[]): Promise<void> {
  for (const name of names) {
    await expect(page.getByRole('button', { name })).not.toBeVisible();
  }
}

// --- former step 10 ---------------------------------------------------------

test('settings page shows vault configuration', async ({ page }) => {
  await openVault(page, TREASURY);
  await navigateTo(page, '/settings');

  await expect(page.locator('text=Required Confirmations')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`text=Owners (${TREASURY_STATE.numOwners})`)).toBeVisible();
  await expect(page.locator('text=Config Nonce')).toBeVisible();
  await expect(page.locator('text=Owners Commitment')).toBeVisible();
});

// --- former step 11 (tab click actually filters the list) -------------------

test('transactions tab click filters the list to that status', async ({ page }) => {
  await openVault(page, TREASURY);
  await navigateTo(page, '/transactions');

  await statusTab(page, /Executed/i).click();
  // Executed proposals carry nonces #3 and #2; the pending ones (#6, #7) hide.
  await expect(page.getByText('#3', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('#2', { exact: true })).toBeVisible();
  await expect(page.getByText('#6', { exact: true })).not.toBeVisible();

  await statusTab(page, /Pending/i).click();
  await expect(page.getByText('#6', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('#3', { exact: true })).not.toBeVisible();
});

// --- former steps 17 + 20 ----------------------------------------------------

test('dashboard delegate card shows None without a delegate', async ({ page }) => {
  await openVault(page, TREASURY);
  await expect(page.locator('text=None')).toBeVisible({ timeout: 10_000 });
});

test('dashboard delegate card shows the delegate address', async ({ page }) => {
  await openVault(page, PERSONAL);
  await expect(page.locator(`text=${RECIPIENT.slice(0, 8)}`).first()).toBeVisible({ timeout: 10_000 });
});

// --- former step 28 ----------------------------------------------------------

test('subvault appears in tree and child detail links its parent', async ({ page }) => {
  await page.goto('/');
  const childRow = page.locator('a', {
    has: page.locator(`text=${OPS_CHILD.slice(0, 10)}`),
  });
  await expect(childRow.first()).toBeVisible({ timeout: 60_000 });

  await openVault(page, OPS_CHILD);
  // The child detail page links its parent via the ParentCard's "Open Vault →"
  // link (user-facing copy uses Vault/SubVault, not parent/child).
  await expect(page.locator('text=Open Vault')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`text=${TREASURY.slice(0, 10)}`).first()).toBeVisible();
});

// --- former step 44 ----------------------------------------------------------

test('non-existent proposal hash shows not-found, not a crash', async ({ page }) => {
  await openProposal(page, '12345678901234567890');
  await expect(page.locator('text=Proposal not found')).toBeVisible({ timeout: 10_000 });
});

// --- former steps 50/51 + restored 52 ----------------------------------------

test('rejects an unsupported signed response before broadcast', async ({ page }) => {
  await openProposal(page, PROPOSALS.pendingTransfer);
  await expect(page.getByText('New recipient account costs')).toBeVisible();
  await expect(page.getByText(/later proposals can wait behind this nonce/)).toBeVisible();
  await page.getByRole('button', { name: 'Offline', exact: true }).click();
  const broadcasts: string[] = [];
  page.on('request', request => {
    if (request.postData()?.includes('sendZkapp')) broadcasts.push(request.url());
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'unsupported-signed.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ version: 2, type: 'offline-signed-tx', action: 'approve',
      contractAddress: TREASURY, proposalHash: PROPOSALS.pendingTransfer, transaction: {} })),
  });
  await expect(page.getByText(/Unsupported signed response version/)).toBeVisible();
  expect(broadcasts).toEqual([]);
});

test('an empty memo is displayed as a committed empty value', async ({ page }) => {
  await openProposal(page, PROPOSALS.pendingAddOwner);
  await expect(page.getByText('Memo', { exact: true })).toBeVisible();
  await expect(page.getByText('(empty)', { exact: true })).toBeVisible();
});

test('executed proposal has no action buttons and shows memo match', async ({ page }) => {
  await openProposal(page, PROPOSALS.executedTransfer);

  await expect(page.getByText('executed', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expectNoActionButtons(page, [
    /approve proposal/i,
    /execute proposal/i,
    /delete proposal/i,
  ]);
  await expect(page.locator(`text=${MEMOS.executedTransfer}`)).toBeVisible();
  await expect(page.getByText('✓', { exact: true })).toBeVisible(); // memo-match indicator
});

test('executed proposal with stripped memo shows mismatch indicator', async ({ page }) => {
  await openProposal(page, PROPOSALS.executedMemoMismatch);
  await expect(page.getByText('executed', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('✗', { exact: true })).toBeVisible(); // memo-mismatch indicator
});

test('invalidated proposal has no action buttons', async ({ page }) => {
  await openProposal(page, PROPOSALS.invalidatedTransfer);
  await expect(page.getByText('invalidated', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expectNoActionButtons(page, [/approve proposal/i, /execute proposal/i]);
});

test('expired proposal has no approve/execute buttons', async ({ page }) => {
  await openProposal(page, PROPOSALS.expiredTransfer);
  await expect(page.getByText('expired', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  await expectNoActionButtons(page, [/approve proposal/i, /execute proposal/i]);
});

test('unsafe CREATE_CHILD target blocks online and offline approval', async ({ page }) => {
  // Re-shape the pending fixture as a remote CREATE_CHILD proposal while
  // leaving the indexed parent canonical. This models the finding's malicious
  // creator deploying an unsafe child outside the supported client.
  await page.route(
    new RegExp(`/api/contracts/${TREASURY}/proposals(?:\\?.*)?$`),
    async (route) => {
      const response = await route.fetch();
      const proposals = (await response.json()) as Array<Record<string, unknown>>;
      await route.fulfill({
        response,
        json: proposals.map((proposal) =>
          proposal.proposalHash === PROPOSALS.pendingTransfer
            ? {
                ...proposal,
                txType: 'createChild',
                destination: 'remote',
                childAccount: OPS_CHILD,
                receivers: [],
              }
            : proposal,
        ),
      });
    },
  );
  await page.route(
    `**/api/contracts/${TREASURY}/proposals/${PROPOSALS.pendingTransfer}/approvals`,
    (route) => route.fulfill({ json: [] }),
  );
  await page.route(`**/api/accounts/${OPS_CHILD}/security`, (route) =>
    route.fulfill({
      json: {
        accountFound: true,
        verificationKeyHash: 'canonical-vk',
        verificationKeyMatches: true,
        permissionKinds: { send: 'Either' },
        expectedPermissionKinds: { send: 'Proof' },
        permissionMismatches: ['send'],
        safe: false,
      },
    }),
  );

  await openProposal(page, PROPOSALS.pendingTransfer);
  await expect(page.getByRole('alert').filter({
    hasText: 'The proposed SubVault has a missing or non-canonical on-chain permission field.',
  })).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByRole('button', { name: /approve proposal/i }),
  ).not.toBeVisible();

  await page.getByRole('button', { name: 'Offline', exact: true }).click();
  await expect(
    page.getByText(/offline bundle creation and broadcast are blocked/i),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /export approve bundle/i }),
  ).not.toBeVisible();
  await expect(page.getByText(/drop signed \.json/i)).not.toBeVisible();
});

test('unsafe parent blocks the dedicated SubVault creation wizard', async ({ page }) => {
  await openVault(page, TREASURY);
  await page.route(`**/api/accounts/${TREASURY}/security`, (route) =>
    route.fulfill({
      json: {
        accountFound: true,
        verificationKeyHash: 'canonical-vk',
        verificationKeyMatches: true,
        permissionKinds: { send: 'Either' },
        expectedPermissionKinds: { send: 'Proof' },
        permissionMismatches: ['send'],
        safe: false,
      },
    }),
  );

  await navigateTo(page, `/accounts/new?parent=${TREASURY}`);
  await page.getByRole('button', { name: 'Next', exact: true }).click();

  await expect(page.getByText(/unsafe parent vault/i)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Propose SubVault' }),
  ).toBeDisabled();
});

test('offline bundle export rechecks permissions instead of trusting page state', async ({ page }) => {
  let unsafeNow = false;
  await page.route(`**/api/accounts/${TREASURY}/security`, async (route) => {
    if (!unsafeNow) {
      await route.continue();
      return;
    }
    await route.fulfill({
      json: {
        accountFound: true,
        verificationKeyHash: 'canonical-vk',
        verificationKeyMatches: true,
        permissionKinds: { send: 'Either' },
        expectedPermissionKinds: { send: 'Proof' },
        permissionMismatches: ['send'],
        safe: false,
      },
    });
  });

  await openProposal(page, PROPOSALS.pendingTransfer);
  await page.getByRole('button', { name: 'Offline', exact: true }).click();
  await page.getByPlaceholder('B62q...').fill(OWNER_2);
  const exportButton = page.getByRole('button', {
    name: /export approve bundle/i,
  });
  await expect(exportButton).toBeVisible();

  // The hook admitted the page while the account was safe. Flip only the live
  // response and prove the export callback checks again before creating a file.
  unsafeNow = true;
  await exportButton.click();
  await expect(
    page.getByText(/vault permissions have not passed the canonical security check/i),
  ).toBeVisible();
});

// --- REMOTE proposals whose SubVault target the backend has not indexed ------

/** Re-shapes the pending fixture as a REMOTE reclaim of OPS_CHILD with the
 *  given backend verdict, and hides approvals so the wallet could approve. */
async function mockRemoteReclaim(page: Page, verdict: Record<string, unknown>): Promise<void> {
  await page.route(
    new RegExp(`/api/contracts/${TREASURY}/proposals(?:\\?.*)?$`),
    async (route) => {
      const response = await route.fetch();
      const proposals = (await response.json()) as Array<Record<string, unknown>>;
      await route.fulfill({
        response,
        json: proposals.map((proposal) =>
          proposal.proposalHash === PROPOSALS.pendingTransfer
            ? { ...proposal, txType: 'reclaimChild', destination: 'remote', childAccount: OPS_CHILD, receivers: [], ...verdict }
            : proposal,
        ),
      });
    },
  );
  await page.route(
    `**/api/contracts/${TREASURY}/proposals/${PROPOSALS.pendingTransfer}/approvals`,
    (route) => route.fulfill({ json: [] }),
  );
}

test('a REMOTE proposal waits while its SubVault target is not indexed', async ({ page }) => {
  await mockRemoteReclaim(page, { childTargetIndexed: false });
  await openProposal(page, PROPOSALS.pendingTransfer);
  await expect(page.getByText('SubVault not indexed yet', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expectNoActionButtons(page, [/approve proposal/i, /execute proposal/i]);

  await page.getByRole('button', { name: 'Offline', exact: true }).click();
  await expect(page.getByText(/wait until the backend has indexed the target SubVault/i)).toBeVisible();
  await expectNoActionButtons(page, [/export approve bundle/i, /export execute bundle/i]);
});


// --- CREATE_CHILD approval shows what it authorizes --------------------------

const CANONICAL_PERMISSIONS = {
  editState: 'Proof', send: 'Proof', receive: 'None', setDelegate: 'Proof',
  setPermissions: 'Impossible', setVerificationKey: 'Impossible', setZkappUri: 'Impossible',
  editActionState: 'Proof', setTokenSymbol: 'Impossible', incrementNonce: 'Impossible',
  setVotingFor: 'Impossible', setTiming: 'Impossible', access: 'None',
};
/** `childConfigHash` over [OWNER_2, OWNER_3] in that slot order with threshold 1. */
const OPS_CHILD_CONFIG_HASH = '23105164216412012809451901057559969068001464395591450709626794513210236238504';
const OPS_CHILD_RESERVATION = [
  { eventType: 'createChildConfig', payload: { proposalHash: '0', childAccount: OPS_CHILD, threshold: '1', numOwners: '2' }, blockHeight: 5 },
  { eventType: 'createChildOwner', payload: { proposalHash: '0', owner: OWNER_2, index: '0' }, blockHeight: 5 },
  { eventType: 'createChildOwner', payload: { proposalHash: '0', owner: OWNER_3, index: '1' }, blockHeight: 5 },
];

/** Re-shapes the pending fixture as a CREATE_CHILD proposal for OPS_CHILD whose
 *  signed data commits to the reservation above, with a canonical parent and
 *  child, so only the configuration check decides whether Approve is offered. */
async function mockPendingCreateChild(page: Page, childEvents: unknown[]): Promise<void> {
  await page.route(
    new RegExp(`/api/contracts/${TREASURY}/proposals(?:\\?.*)?$`),
    async (route) => {
      const response = await route.fetch();
      const proposals = (await response.json()) as Array<Record<string, unknown>>;
      await route.fulfill({
        response,
        json: proposals.map((proposal) =>
          proposal.proposalHash === PROPOSALS.pendingTransfer
            ? {
                ...proposal,
                txType: 'createChild',
                destination: 'remote',
                childAccount: OPS_CHILD,
                data: OPS_CHILD_CONFIG_HASH,
                receivers: [],
              }
            : proposal,
        ),
      });
    },
  );
  await page.route(
    `**/api/contracts/${TREASURY}/proposals/${PROPOSALS.pendingTransfer}/approvals`,
    (route) => route.fulfill({ json: [] }),
  );
  for (const address of [TREASURY, OPS_CHILD]) {
    await page.route(`**/api/accounts/${address}/security`, (route) =>
      route.fulfill({
        json: {
          accountFound: true,
          verificationKeyHash: 'canonical-vk',
          verificationKeyMatches: true,
          permissionKinds: CANONICAL_PERMISSIONS,
          expectedPermissionKinds: CANONICAL_PERMISSIONS,
          permissionMismatches: [],
          safe: true,
        },
      }),
    );
  }
  await page.route(
    new RegExp(`/api/contracts/${OPS_CHILD}/events(?:\\?.*)?$`),
    (route) => route.fulfill({ json: childEvents }),
  );
}

test('CREATE_CHILD approval shows the SubVault owners and threshold, then offers Approve', async ({ page }) => {
  await mockPendingCreateChild(page, OPS_CHILD_RESERVATION);
  await openProposal(page, PROPOSALS.pendingTransfer);

  const owners = page.getByTestId('subvault-owners');
  await expect(owners).toBeVisible({ timeout: 10_000 });
  await expect(owners).toContainText(OWNER_2);
  await expect(owners).toContainText(OWNER_3);
  await expect(page.getByText('SubVault Threshold', { exact: true }).locator('..')).toContainText('1 of 2');
  await expect(page.getByRole('button', { name: /^approve proposal$/i })).toBeEnabled();
});

test('CREATE_CHILD approval waits while the SubVault reservation is not indexed', async ({ page }) => {
  await mockPendingCreateChild(page, []);
  await openProposal(page, PROPOSALS.pendingTransfer);

  await expect(page.getByText('SubVault config could not be verified')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: /approve waits for the subvault config/i })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^approve proposal$/i })).not.toBeVisible();
  await expect(page.getByTestId('subvault-owners')).not.toBeVisible();
});
