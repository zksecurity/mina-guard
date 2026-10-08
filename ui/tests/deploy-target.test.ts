import { describe, expect, it } from 'bun:test';
import { classifyDeployTarget, receiverExists } from '../lib/deploy-target';

describe('classifyDeployTarget', () => {
  it('funds an account the node does not have', () => {
    expect(classifyDeployTarget({ error: { statusCode: 404, statusText: 'does not exist' } })).toBe('new');
    expect(classifyDeployTarget({ account: null })).toBe('new');
    expect(classifyDeployTarget({})).toBe('new');
  });

  it('deploys into a bare account someone created first, without funding it again', () => {
    expect(classifyDeployTarget({ account: {} })).toBe('existing');
    expect(classifyDeployTarget({ account: { zkapp: null } })).toBe('existing');
    expect(classifyDeployTarget({ account: { zkapp: { appState: ['0', '0'], verificationKey: undefined } } })).toBe('existing');
  });

  it('refuses an address that already carries a verification key or app state', () => {
    expect(() => classifyDeployTarget({ account: { zkapp: { appState: [], verificationKey: { hash: 'vk' } } } }))
      .toThrow('already holds a zkApp');
    expect(() => classifyDeployTarget({ account: { zkapp: { appState: ['0', '7'] } } })).toThrow('already holds a zkApp');
  });

  it('refuses to guess when the node fails for any other reason', () => {
    expect(() => classifyDeployTarget({ error: { statusCode: 500, statusText: 'upstream timeout' } }))
      .toThrow('Could not check the vault address: upstream timeout');
    expect(() => classifyDeployTarget({ error: {} })).toThrow('Could not check the vault address');
  });
});

describe('receiverExists', () => {
  it('treats only "no such account" as a new receiver', () => {
    expect(receiverExists({ error: { statusCode: 404, statusText: 'does not exist' } })).toBe(false);
    expect(receiverExists({ account: {} })).toBe(true);
    expect(receiverExists({ account: { zkapp: null } })).toBe(true);
    expect(receiverExists({ account: { zkapp: { appState: ['1'], verificationKey: { hash: 'vk' } } } })).toBe(true);
  });

  it('refuses to guess when the node fails for any other reason', () => {
    expect(() => receiverExists({ error: { statusCode: 500, statusText: 'upstream timeout' } }))
      .toThrow('Could not check a receiver address: upstream timeout');
    expect(() => receiverExists({ error: {} })).toThrow('Could not check a receiver address');
  });
});
