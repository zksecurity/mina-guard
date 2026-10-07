import { describe, expect, it } from 'bun:test';
import { classifyDeployTarget } from '../lib/deploy-target';

describe('classifyDeployTarget', () => {
  it('funds an account the node does not have', () => {
    expect(classifyDeployTarget(null)).toBe('new');
    expect(classifyDeployTarget(undefined)).toBe('new');
  });

  it('deploys into a bare account someone created first, without funding it again', () => {
    expect(classifyDeployTarget({})).toBe('existing');
    expect(classifyDeployTarget({ zkapp: null })).toBe('existing');
    expect(classifyDeployTarget({ zkapp: { appState: ['0', '0'], verificationKey: undefined } })).toBe('existing');
  });

  it('refuses an address that already carries a verification key or app state', () => {
    expect(() => classifyDeployTarget({ zkapp: { appState: [], verificationKey: { hash: 'vk' } } }))
      .toThrow('already holds a zkApp');
    expect(() => classifyDeployTarget({ zkapp: { appState: ['0', '7'] } })).toThrow('already holds a zkApp');
  });
});
