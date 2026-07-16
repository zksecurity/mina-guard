/**
 * Deterministic addresses and expected counts for the UI test suite.
 *
 * The seed script (seed.ts) writes exactly this world into the uitest DB;
 * tests import the same constants to assert against it. Keep this file free
 * of dependencies — it is imported from Playwright test files where pulling
 * in o1js or Prisma would be slow.
 *
 * Addresses are real base58 pubkeys (the API validates them) generated once
 * and frozen here; no corresponding private keys are needed because the UI
 * suite never signs or broadcasts.
 */

/** The connected test user — an owner on every seeded vault. */
export const WALLET = 'B62qjxZEh62njJRPAKfAC7mkzYcLvcEqzCvnVkESyhh6DxtotXWqNqM';

export const OWNER_2 = 'B62qq3UVbcnSUZtVRbn1K9FyjYa5Qmjc2hWYszDEUK3DRw9DyXjTKHk';
export const OWNER_3 = 'B62qk1adEw65vYq2CwMm52byhsTCz4CrUb3bz8jQiGLaE2E8WXDkCGL';
export const RECIPIENT = 'B62qk3braC4bLW63rXBWijLdkkuGbJoYvk1gZRbTkZ1rJabLD56Bumi';

/** 3-owner vault with threshold 2 and proposals in every derivable status. */
export const TREASURY = 'B62qmwNYgpFJgr4o5HtuadxeoT3bpmzBWzHfWkc9D8hFmEFFmeuCpQx';
/** Child vault of TREASURY (parent linkage, childMultiSigEnabled). */
export const OPS_CHILD = 'B62qkDpgeKBdaFXrWH7fk97b77UmYPtfwvwNueQ7VT41NrvYoVuDWYe';
/** Single-owner vault with no proposals (empty states). */
export const PERSONAL = 'B62qnzWNsqYfDTrUNpreAnEieYp5dTYZJmbcEkJ2w7LLn5dnUFBnsvS';

/** TREASURY's on-chain counters as seeded in its latest ContractConfig row. */
export const TREASURY_STATE = {
  threshold: 2,
  numOwners: 3,
  nonce: 5,
  configNonce: 1,
};

/** status.latestSlot the backend is primed with (INDEXER_FIXED_LATEST_SLOT). */
export const FIXED_LATEST_SLOT = 1000;

/** Proposal hashes (o1js Field strings — the API's route params require digits). */
export const PROPOSALS = {
  pendingTransfer: '9001',
  pendingAddOwner: '9002',
  executedTransfer: '9003',
  executedMemoMismatch: '9004',
  expiredTransfer: '9005',
  invalidatedTransfer: '9006',
} as const;

export const MEMOS = {
  pendingTransfer: 'Q3 grant payout',
  executedTransfer: 'October payroll',
  executedMemoMismatch: 'legal retainer',
} as const;

/** Canned results the capture hook answers with (mirrors ui/lib/multisigClient.ts). */
export const CAPTURED_RESULT = {
  proposalHash: '424242',
  txHash: '5JuE2ECapturedTx',
} as const;

/** Default nonce the proposal form derives for TREASURY's LOCAL nonce space:
 *  floor is the contract nonce (5); only PENDING proposals block a nonce, so
 *  with 6 and 7 pending (expired 8 / invalidated 4 are reusable) → 8. */
export const NEXT_LOCAL_NONCE = 8;
/** Default nonce for OPS_CHILD's REMOTE nonce space (parentNonce 0, none seeded). */
export const NEXT_REMOTE_NONCE = 1;

/** Per-status proposal counts on TREASURY, as derived by the API at read time. */
export const TREASURY_COUNTS = {
  pending: 2,
  executed: 2,
  expired: 1,
  invalidated: 1,
  all: 6,
} as const;
