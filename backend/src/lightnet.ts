import { z } from 'zod';

const acquiredAccountSchema = z.object({
  pk: z.string().min(1),
  sk: z.string().min(1),
});

export class LightnetAcquireError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'LightnetAcquireError';
  }
}

/**
 * Acquires a regular funded account from the Lightnet account manager and
 * validates the returned keypair payload.
 */
export async function acquireLightnetAccount(
  accountManagerUrl: string
): Promise<{ pk: string; sk: string }> {
  const response = await fetch(
    `${accountManagerUrl}/acquire-account?isRegularAccount=true`,
    {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Account manager returned ${response.status}${body ? `: ${body}` : ''}`
    );
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new Error('Account manager returned invalid JSON');
  }

  const parsed = acquiredAccountSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Account manager returned an invalid account payload');
  }

  return parsed.data;
}

/** Best-effort release of a previously acquired Lightnet account back to the pool. */
export async function releaseLightnetAccount(
  accountManagerUrl: string,
  account: { pk: string; sk: string }
): Promise<void> {
  try {
    await fetch(`${accountManagerUrl}/release-account`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(account),
    });
  } catch {
    // Release failures are non-fatal for the funding flow.
  }
}

/** Acquires a Lightnet account, runs the callback, and always releases the account afterward. */
export async function withLightnetAccount<T>(
  accountManagerUrl: string,
  run: (account: { pk: string; sk: string }) => Promise<T>,
  deps: {
    acquireLightnetAccount: typeof acquireLightnetAccount;
    releaseLightnetAccount: typeof releaseLightnetAccount;
  } = {
    acquireLightnetAccount,
    releaseLightnetAccount,
  }
): Promise<T> {
  let account: { pk: string; sk: string };
  try {
    account = await deps.acquireLightnetAccount(accountManagerUrl);
  } catch (error) {
    throw new LightnetAcquireError(
      error instanceof Error ? error.message : 'Failed to acquire funded account',
      { cause: error }
    );
  }
  try {
    return await run(account);
  } finally {
    await deps.releaseLightnetAccount(accountManagerUrl, account);
  }
}

/**
 * Picks a safe payment amount from the funder balance, leaving enough for
 * account creation and transaction fees.
 */
export function computeFundingAmount(
  funderBalanceNano: bigint,
  desiredAmountNano: bigint = 50_000_000_000n,
  reserveNano: bigint = 1_100_000_000n
): bigint {
  if (funderBalanceNano <= reserveNano) return 0n;
  const available = funderBalanceNano - reserveNano;
  return available < desiredAmountNano ? available : desiredAmountNano;
}

/**
 * Broadcasts a plain signed payment via GraphQL sendPayment, which works on
 * Lightnet even when sendZkapp is rejected by the nginx proxy.
 */
export async function sendSignedLightnetPayment(params: {
  minaEndpoint: string;
  from: string;
  to: string;
  amount: string;
  fee: string;
  nonce: string;
  privateKey: string;
}): Promise<string> {
  const { default: MinaSignerClient } = await import(
    '../node_modules/o1js/dist/node/mina-signer/mina-signer.js'
  );

  const client = new MinaSignerClient({ network: 'testnet' });
  const signed = client.signPayment(
    {
      from: params.from,
      to: params.to,
      amount: params.amount,
      fee: params.fee,
      nonce: params.nonce,
    },
    params.privateKey
  ) as {
    signature: { field?: string; scalar?: string };
  };

  const response = await fetch(params.minaEndpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        mutation SendPayment($input: SendPaymentInput!, $signature: SignatureInput) {
          sendPayment(input: $input, signature: $signature) {
            payment {
              hash
            }
          }
        }
      `,
      variables: {
        input: {
          from: params.from,
          to: params.to,
          amount: params.amount,
          fee: params.fee,
          nonce: params.nonce,
        },
        signature: {
          field: signed.signature.field,
          scalar: signed.signature.scalar,
        },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Daemon payment request failed: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    data?: {
      sendPayment?: {
        payment?: { hash?: string | null } | null;
      } | null;
    };
    errors?: Array<{ message?: string }>;
  };

  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message ?? 'GraphQL error').join('; '));
  }

  const hash = json.data?.sendPayment?.payment?.hash;
  if (!hash) {
    throw new Error('sendPayment response missing transaction hash');
  }

  return hash;
}
