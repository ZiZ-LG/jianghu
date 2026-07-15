import { describe, expect, it } from 'vitest';
import {
  clearStableBatchItemKey,
  removeSuccessfulSelections,
  stableBatchItemKey,
} from './reviewBatch';

type Item = {
  kind: 'proposal';
  id: string;
  decision: 'accept' | 'reject';
  overrideValue?: string;
};

describe('batch review idempotency keys', () => {
  it('reuses one key across two manual attempts and rotates after confirmed success', () => {
    const cache = new Map();
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;
    const item: Item = { kind: 'proposal', id: 'proposal-1', decision: 'accept', overrideValue: 'plus' };

    expect(stableBatchItemKey(cache, item, createKey)).toBe('key-1');
    expect(stableBatchItemKey(cache, { ...item }, createKey)).toBe('key-1');

    clearStableBatchItemKey(cache, item);
    expect(stableBatchItemKey(cache, { ...item }, createKey)).toBe('key-2');
  });

  it('uses a different key when decision or payload changes for the same logical item', () => {
    const cache = new Map();
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;
    const accepted: Item = { kind: 'proposal', id: 'proposal-1', decision: 'accept', overrideValue: 'plus' };

    expect(stableBatchItemKey(cache, accepted, createKey)).toBe('key-1');
    expect(stableBatchItemKey(cache, { ...accepted, decision: 'reject' }, createKey)).toBe('key-2');
    expect(stableBatchItemKey(cache, { ...accepted, overrideValue: 'star' }, createKey)).toBe('key-3');
  });

  it('retains failed selection and key while removing and clearing a confirmed success', () => {
    const cache = new Map();
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;
    const success: Item = { kind: 'proposal', id: 'success', decision: 'accept' };
    const failure: Item = { kind: 'proposal', id: 'failure', decision: 'accept' };
    const selected = new Set(['proposal:success', 'proposal:failure']);

    expect(stableBatchItemKey(cache, success, createKey)).toBe('key-1');
    expect(stableBatchItemKey(cache, failure, createKey)).toBe('key-2');
    clearStableBatchItemKey(cache, success);

    expect([...removeSuccessfulSelections(selected, [success])]).toEqual(['proposal:failure']);
    expect(stableBatchItemKey(cache, failure, createKey)).toBe('key-2');
    expect(stableBatchItemKey(cache, success, createKey)).toBe('key-3');
  });
});
