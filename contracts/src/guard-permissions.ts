import { Permissions } from 'o1js';
import {
  GUARD_PERMISSION_KINDS,
  GUARD_PERMISSION_NAMES,
  GUARD_SET_VERIFICATION_KEY_TXN_VERSION,
  type GuardPermissionKind,
  type GuardPermissionName,
} from './guard-permission-policy.js';

export {
  GUARD_PERMISSION_KINDS,
  GUARD_PERMISSION_NAMES,
  GUARD_SET_VERIFICATION_KEY_TXN_VERSION,
  type GuardPermissionKind,
  type GuardPermissionName,
};

/**
 * The only account-permission vector supported by MinaGuard.
 *
 * A verification-key match does not authenticate permissions: a creator can
 * bypass MinaGuard's proof-authorized initialization and install both the key
 * and a different vector in a signature-authorized deployment AccountUpdate.
 * Every component that accepts a vault must compare its stored permissions
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

/**
 * Permission vector used only by the signature-authorized deployment update.
 * The proof-authorized setup()/reserveForParent() update replaces this with
 * GUARD_PERMISSIONS in the same atomic transaction. The sole temporary
 * difference is that a MinaGuard proof may close the permission vector.
 */
export const GUARD_DEPLOY_PERMISSIONS = {
  ...GUARD_PERMISSIONS,
  setPermissions: Permissions.proof(),
};
