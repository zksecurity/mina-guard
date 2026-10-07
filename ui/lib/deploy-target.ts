/** What the node knows about a vault address before a deployment. */
export interface DeployTargetAccount {
  zkapp?: { appState?: ReadonlyArray<unknown> | null; verificationKey?: unknown } | null;
}

/** The result of fetching the address from the node, as o1js's `fetchAccount` reports it. */
export interface DeployTargetFetch {
  account?: DeployTargetAccount | null;
  error?: { statusCode?: number; statusText?: string } | null;
}

/**
 * Decides how to deploy a vault to an address. Anyone can create the bare Mina
 * account first by paying into the address, and a deployment that declares a
 * new account then fails. An existing bare account is deployed into without
 * the creation fee. An account that already carries a verification key or app
 * state is refused: only the address's own key could have put them there. A
 * node error other than "no such account" is refused too, since guessing
 * would reproduce the failure this check exists to prevent.
 */
export function classifyDeployTarget(fetched: DeployTargetFetch): 'new' | 'existing' {
  if (fetched.error) {
    if (fetched.error.statusCode === 404) return 'new';
    throw new Error(`Could not check the vault address: ${fetched.error.statusText ?? 'node request failed'}`);
  }
  const account = fetched.account;
  if (!account) return 'new';
  const zkapp = account.zkapp;
  const hasState = (zkapp?.appState ?? []).some((value) => String(value) !== '0');
  if (zkapp?.verificationKey || hasState) {
    throw new Error('This address already holds a zkApp. Create the vault with a fresh address.');
  }
  return 'existing';
}
