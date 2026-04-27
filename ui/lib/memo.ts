export const MEMO_MAX_BYTES = 32;

export function memoByteLength(memo: string): number {
  return new TextEncoder().encode(memo).length;
}

export function isValidMemoLength(memo: string): boolean {
  return memoByteLength(memo) <= MEMO_MAX_BYTES;
}
