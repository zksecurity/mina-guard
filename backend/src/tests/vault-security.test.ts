import { describe, expect, it } from 'bun:test';
import { Permissions } from 'o1js';
import {
  GUARD_PERMISSION_KINDS,
  GUARD_PERMISSION_NAMES,
  GUARD_PERMISSIONS,
  GUARD_SET_VERIFICATION_KEY_TXN_VERSION,
} from 'contracts';
import {
  matchesExpectedVerificationKey,
  permissionKindVector,
  permissionMismatches,
  validatePermissionVector,
} from '../vault-security.js';

describe('canonical MinaGuard permissions', () => {
  it('fails closed when the expected verification-key hash is missing', () => {
    expect(matchesExpectedVerificationKey('actual-vk', null)).toBe(false);
    expect(matchesExpectedVerificationKey(null, 'expected-vk')).toBe(false);
    expect(matchesExpectedVerificationKey('expected-vk', 'expected-vk')).toBe(
      true,
    );
  });

  it('accepts every field of the canonical vector', () => {
    const result = validatePermissionVector(GUARD_PERMISSIONS);

    expect(result.mismatches).toEqual([]);
    expect(result.permissionKinds).toEqual(GUARD_PERMISSION_KINDS);
    expect(Object.keys(result.permissionKinds).sort()).toEqual(
      [...GUARD_PERMISSION_NAMES].sort()
    );
    expect(GUARD_SET_VERIFICATION_KEY_TXN_VERSION).toBe(
      GUARD_PERMISSIONS.setVerificationKey.txnVersion.toString(),
    );
  });

  it('rejects the hidden send: Either withdrawal permission', () => {
    const altered = {
      ...GUARD_PERMISSIONS,
      send: Permissions.proofOrSignature(),
    };

    expect(validatePermissionVector(altered).mismatches).toEqual(['send']);
  });

  it('accepts the raw permission strings returned by Mina GraphQL', () => {
    const raw = {
      ...GUARD_PERMISSION_KINDS,
      setVerificationKey: {
        auth: GUARD_PERMISSION_KINDS.setVerificationKey,
        txnVersion: GUARD_PERMISSIONS.setVerificationKey.txnVersion.toString(),
      },
    };

    expect(validatePermissionVector(raw).mismatches).toEqual([]);
  });

  it('does not confuse raw setVerificationKey: None with Impossible', () => {
    const raw = {
      ...GUARD_PERMISSION_KINDS,
      setVerificationKey: {
        auth: 'None',
        txnVersion: GUARD_PERMISSIONS.setVerificationKey.txnVersion.toString(),
      },
    };

    expect(validatePermissionVector(raw).mismatches).toEqual([
      'setVerificationKey',
    ]);
  });

  it('fails closed when any permission field is absent', () => {
    const actual = permissionKindVector(GUARD_PERMISSIONS);
    delete actual.access;

    expect(permissionMismatches(actual)).toEqual(['access']);
  });

  it('rejects a non-canonical verification-key transaction version', () => {
    const altered = {
      ...GUARD_PERMISSIONS,
      setVerificationKey: {
        ...GUARD_PERMISSIONS.setVerificationKey,
        txnVersion: GUARD_PERMISSIONS.setVerificationKey.txnVersion.add(1),
      },
    };

    expect(validatePermissionVector(altered).mismatches).toEqual([
      'setVerificationKey',
    ]);
  });
});
