import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../../store';
import { createCommitScheduler } from './commitScheduler';

const personAction = (name: string): Action => ({
  type: 'UPDATE_PERSON',
  accId: 'a1',
  personId: 'p1',
  patch: { name },
});

describe('commit scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid drafts and commits only the final value after 400ms', async () => {
    const committed: Action[] = [];
    const scheduler = createCommitScheduler(async (_key, action) => { committed.push(action); }, { delayMs: 400 });
    scheduler.schedule('person:p1', personAction('A'));
    scheduler.schedule('person:p1', personAction('AB'));
    scheduler.schedule('person:p1', personAction('ABC'));

    await vi.advanceTimersByTimeAsync(399);
    expect(committed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(committed).toEqual([personAction('ABC')]);
  });

  it('merges distinct patch fields instead of dropping an earlier draft', async () => {
    const committed: Action[] = [];
    const scheduler = createCommitScheduler(async (_key, action) => { committed.push(action); });
    const nameAction: Action = { type: 'UPDATE_PERSON', accId: 'a1', personId: 'p1', patch: { name: 'A' } };
    const titleAction: Action = { type: 'UPDATE_PERSON', accId: 'a1', personId: 'p1', patch: { title: 'CTO' } };
    scheduler.schedule('person:p1', nameAction);
    scheduler.schedule('person:p1', titleAction);
    await scheduler.flush('person:p1');

    expect(committed).toEqual([{ ...titleAction, patch: { name: 'A', title: 'CTO' } }]);
  });

  it('flushes pending work on blur or unmount', async () => {
    const committed: Action[] = [];
    const scheduler = createCommitScheduler(async (_key, action) => { committed.push(action); });
    scheduler.schedule('person:p1', personAction('blur'));
    await scheduler.flush('person:p1');
    const unmountAction: Action = { type: 'UPDATE_PERSON', accId: 'a1', personId: 'p2', patch: { name: 'unmount' } };
    scheduler.schedule('person:p2', unmountAction);
    await scheduler.flushAll();

    expect(committed).toEqual([
      personAction('blur'),
      unmountAction,
    ]);
  });

  it('supports a shorter coalescing window for drag writes', async () => {
    const committed: Action[] = [];
    const scheduler = createCommitScheduler(async (_key, action) => { committed.push(action); });
    scheduler.schedule('person:p1', personAction('drag'), { delayMs: 80 });
    await vi.advanceTimersByTimeAsync(79);
    expect(committed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(committed).toHaveLength(1);
  });

  it('cancels every pending draft on session reset', async () => {
    const committed: Action[] = [];
    const scheduler = createCommitScheduler(async (_key, action) => { committed.push(action); });
    scheduler.schedule('person:p1', personAction('old tenant'));
    scheduler.reset();
    await vi.advanceTimersByTimeAsync(500);
    expect(committed).toEqual([]);
  });

  it('preserves different action types for one entity in both orders', async () => {
    const committed: Action[] = [];
    const scheduler = createCommitScheduler(async (_key, action) => { committed.push(action); });
    const move: Action = { type: 'MOVE_PERSON', accId: 'a1', personId: 'p1', x: 20, y: 30 };
    scheduler.schedule('person:p1', move);
    scheduler.schedule('person:p1', personAction('after move'));
    await scheduler.flush('person:p1');
    expect(committed).toEqual([move, personAction('after move')]);

    committed.length = 0;
    scheduler.schedule('person:p1', personAction('before move'));
    scheduler.schedule('person:p1', move);
    await scheduler.flush('person:p1');
    expect(committed).toEqual([personAction('before move'), move]);
  });

  it('does not coalesce repeated non-draft commands merely because their types match', async () => {
    const committed: Action[] = [];
    const scheduler = createCommitScheduler(async (_key, action) => { committed.push(action); });
    const first = { type: 'ADD_LOG', accId: 'a1', personId: 'p1', log: { date: '2026-07-14', content: 'first' } } as Action;
    const second = { type: 'ADD_LOG', accId: 'a1', personId: 'p1', log: { date: '2026-07-14', content: 'second' } } as Action;
    scheduler.schedule('person:p1', first);
    scheduler.schedule('person:p1', second);
    await scheduler.flush('person:p1');
    expect(committed).toEqual([first, second]);
  });
});
