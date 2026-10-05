// The desktop window has no Auro of its own: every Auro call goes through the
// bridge page in the user's browser. These helpers let the main process tell
// that page which account a transaction was prepared for, and remember which
// accounts Auro returned when the user connected.

/** The account that pays for, and so must sign, a zkApp transaction sent through Auro. */
export function transactionFeePayer(params: unknown): string {
  const transaction = (params as { transaction?: unknown } | null)?.transaction;
  let parsed: unknown = transaction;
  if (typeof transaction === 'string') {
    try {
      parsed = JSON.parse(transaction);
    } catch {
      throw new Error('Transaction is not valid JSON');
    }
  }
  const publicKey = (parsed as { feePayer?: { body?: { publicKey?: unknown } } } | null)
    ?.feePayer?.body?.publicKey;
  if (typeof publicKey !== 'string' || !publicKey.startsWith('B62')) {
    throw new Error('Transaction has no fee payer');
  }
  return publicKey;
}

/** Accepts only a list of account strings from the bridge; anything else counts as no accounts. */
export function asAccounts(value: unknown): string[] {
  return Array.isArray(value) && value.every((account) => typeof account === 'string') ? value : [];
}
