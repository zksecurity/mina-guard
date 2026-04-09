/**
 * Proposal memo helpers.
 *
 * Mina's native transaction memo caps at 32 UTF-8 bytes, and we mirror that
 * limit for proposal memos so the plaintext can also ride on the outer tx
 * memo without truncation. Note the limit is in *bytes*, not characters —
 * multi-byte chars (emoji, CJK, accented letters) consume more than one byte.
 *
 * o1js exposes `Memo.toValidString` with the same check, but it lives in an
 * internal `mina-signer` submodule that isn't part of the public package
 * exports, so we reimplement the 3 lines here instead of reaching into deps.
 */

/** Mina transaction memo max length in UTF-8 bytes. */
export const MEMO_MAX_BYTES = 32;

/** Byte length of a string when UTF-8 encoded. */
export function memoByteLength(memo: string): number {
  return new TextEncoder().encode(memo).length;
}

/** True iff `memo` fits in a Mina transaction memo (<= MEMO_MAX_BYTES). */
export function isValidMemoLength(memo: string): boolean {
  return memoByteLength(memo) <= MEMO_MAX_BYTES;
}
