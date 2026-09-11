import {
  GUARD_PERMISSION_KINDS,
  GUARD_PERMISSION_NAMES,
  GUARD_PERMISSIONS,
  type GuardPermissionName,
} from 'contracts';

export type PermissionKind =
  | 'None'
  | 'Either'
  | 'Proof'
  | 'Signature'
  | 'Impossible';

export type PermissionKindVector = Partial<
  Record<GuardPermissionName, PermissionKind>
>;

type BoolLike = boolean | { toBoolean(): boolean };
type PermissionLike = {
  constant?: BoolLike;
  signatureNecessary?: BoolLike;
  signatureSufficient?: BoolLike;
};

function readBool(value: BoolLike | undefined): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value && typeof value.toBoolean === 'function') return value.toBoolean();
  return null;
}

/** Converts o1js' three-bit AuthRequired representation to its protocol name. */
export function permissionKind(permission: unknown): PermissionKind | null {
  if (
    permission === 'None' ||
    permission === 'Either' ||
    permission === 'Proof' ||
    permission === 'Signature' ||
    permission === 'Impossible'
  ) {
    return permission;
  }

  const value = permission as PermissionLike | undefined;
  const constant = readBool(value?.constant);
  const necessary = readBool(value?.signatureNecessary);
  const sufficient = readBool(value?.signatureSufficient);
  if (constant === null || necessary === null || sufficient === null)
    return null;

  if (constant && necessary && !sufficient) return 'Impossible';
  if (constant && !necessary && sufficient) return 'None';
  if (!constant && !necessary && !sufficient) return 'Proof';
  if (!constant && necessary && sufficient) return 'Signature';
  if (!constant && !necessary && sufficient) return 'Either';
  return null;
}

/** Normalizes all permission fields for API clients and audit diagnostics. */
export function permissionKindVector(
  permissions: unknown
): PermissionKindVector {
  if (!permissions || typeof permissions !== 'object') return {};
  const source = permissions as Record<string, unknown>;
  const result: PermissionKindVector = {};

  for (const name of GUARD_PERMISSION_NAMES) {
    const raw =
      name === 'setVerificationKey'
        ? (source[name] as { auth?: unknown } | undefined)?.auth ?? source[name]
        : source[name];
    const kind = permissionKind(raw);
    if (kind !== null) result[name] = kind;
  }
  return result;
}

/** Returns every missing or non-canonical permission field. */
export function permissionMismatches(
  actual: PermissionKindVector
): GuardPermissionName[] {
  return GUARD_PERMISSION_NAMES.filter(
    (name) => actual[name] !== GUARD_PERMISSION_KINDS[name]
  );
}

function transactionVersion(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && 'toString' in value) {
    return String((value as { toString(): string }).toString());
  }
  return String(value);
}

/**
 * Compares the complete o1js permission vector, including `access` and the
 * setVerificationKey transaction-version guard.
 */
export function validatePermissionVector(permissions: unknown): {
  permissionKinds: PermissionKindVector;
  mismatches: GuardPermissionName[];
} {
  const permissionKinds = permissionKindVector(permissions);
  const mismatches = permissionMismatches(permissionKinds);
  const actualVkVersion = transactionVersion(
    (permissions as { setVerificationKey?: { txnVersion?: unknown } } | null)
      ?.setVerificationKey?.txnVersion
  );
  const expectedVkVersion = transactionVersion(
    GUARD_PERMISSIONS.setVerificationKey.txnVersion
  );

  if (
    actualVkVersion !== expectedVkVersion &&
    !mismatches.includes('setVerificationKey')
  ) {
    mismatches.push('setVerificationKey');
  }

  return { permissionKinds, mismatches };
}
