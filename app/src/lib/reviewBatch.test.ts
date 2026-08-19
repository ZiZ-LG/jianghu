import { describe, expect, it } from 'vitest';
import {
  clearStableBatchItemKey,
  removeSuccessfulSelections,
  runBatchWithProgress,
  stableBatchItemKey,
} from './reviewBatch';

type Item = {
  kind: 'proposal';
  id: string;
  decision: 'accept' | 'reject';
  overrideValue?: string;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

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

  it('aborts the whole batch when its session is cancelled instead of continuing with later writes', async () => {
    const first = deferred();
    const processed: string[] = [];
    let cancelled = false;
    const items: Item[] = [
      { kind: 'proposal', id: 'first', decision: 'accept' },
      { kind: 'proposal', id: 'second', decision: 'accept' },
    ];
    const pending = runBatchWithProgress(items, async (item) => {
      processed.push(item.id);
      if (item.id === 'first') await first.promise;
    }, undefined, {
      isCancelled: () => cancelled,
      cancellationError: () => new Error('session_reset'),
    });
    await Promise.resolve();
    expect(processed).toEqual(['first']);

    cancelled = true;
    first.resolve();

    await expect(pending).rejects.toThrow('session_reset');
    expect(processed).toEqual(['first']);
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
