/** Pure serialized policy shared with browser code without importing o1js. */
export const GUARD_PERMISSION_NAMES = [
  'editState',
  'send',
  'receive',
  'setDelegate',
  'setPermissions',
  'setVerificationKey',
  'setZkappUri',
  'editActionState',
  'setTokenSymbol',
  'incrementNonce',
  'setVotingFor',
  'setTiming',
  'access',
] as const;

export type GuardPermissionName = (typeof GUARD_PERMISSION_NAMES)[number];
export type GuardPermissionKind =
  | 'None'
  | 'Either'
  | 'Proof'
  | 'Signature'
  | 'Impossible';

export const GUARD_PERMISSION_KINDS: Record<
  GuardPermissionName,
  GuardPermissionKind
> = {
  editState: 'Proof',
  send: 'Proof',
  receive: 'None',
  setDelegate: 'Proof',
  setPermissions: 'Impossible',
  setVerificationKey: 'Impossible',
  setZkappUri: 'Impossible',
  editActionState: 'Proof',
  setTokenSymbol: 'Impossible',
  incrementNonce: 'Impossible',
  setVotingFor: 'Impossible',
  setTiming: 'Impossible',
  access: 'None',
};

// o1js@3.0.0-mesa.final's current transaction version, committed by
// impossibleDuringCurrentVersion(). vault-security.test.ts proves this stays
// equal to the version embedded in GUARD_PERMISSIONS.
export const GUARD_SET_VERIFICATION_KEY_TXN_VERSION = '4';
