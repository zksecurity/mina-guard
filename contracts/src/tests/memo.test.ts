import { Field } from 'o1js';
import { memoToField } from '../memo.js';
import { describe, expect, it } from 'bun:test';

describe('memoToField', () => {
  it('returns Field(0) for the empty string', () => {
    expect(memoToField('').toString()).toEqual(Field(0).toString());
  });

  it('produces distinct commitments for distinct memos', () => {
    expect(memoToField('hello').toString()).not.toEqual(
      memoToField('world').toString()
    );
  });

  it('is deterministic', () => {
    expect(memoToField('rent payment').toString()).toEqual(
      memoToField('rent payment').toString()
    );
  });
});
