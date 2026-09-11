import { Permissions } from 'o1js';

/**
 * The only account-permission vector supported by MinaGuard.
 *
 * A verification-key match does not authenticate permissions because both are
 * installed by the signature-authorized deployment AccountUpdate. Every
 * component that accepts a vault must also compare its on-chain permissions
 * against this complete vector.
 */
export const GUARD_PERMISSIONS = {
  editState: Permissions.proof(),
  send: Permissions.proof(),
  receive: Permissions.none(),
  setDelegate: Permissions.proof(),
  setPermissions: Permissions.impossible(),
  setVerificationKey:
    Permissions.VerificationKey.impossibleDuringCurrentVersion(),
  setZkappUri: Permissions.impossible(),
  editActionState: Permissions.proof(),
  setTokenSymbol: Permissions.impossible(),
  incrementNonce: Permissions.impossible(),
  setVotingFor: Permissions.impossible(),
  setTiming: Permissions.impossible(),
  access: Permissions.none(),
};

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

/** JSON/GraphQL representation used by online clients for field-by-field checks. */
export const GUARD_PERMISSION_KINDS: Record<
  GuardPermissionName,
  'None' | 'Either' | 'Proof' | 'Signature' | 'Impossible'
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
