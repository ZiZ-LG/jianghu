import { describe, expect, it, vi } from 'vitest';
import type { Action } from '../../store';
import { ApiError } from '../../api';
import { createMutationCoordinator, createMutationExecutionGate, discardAfterCloudRefresh, entityKeyForAction } from './mutationCoordinator';

const personAction = (name: string): Action => ({
  type: 'UPDATE_PERSON',
  accId: 'a1',
  personId: 'p1',
  patch: { name },
});

describe('mutation coordinator', () => {
  it('uses one entity key across different mutation kinds for the same person', () => {
    expect(entityKeyForAction(personAction('A'))).toBe('person:p1');
    expect(entityKeyForAction({ type: 'MOVE_PERSON', accId: 'a1', personId: 'p1', x: 1, y: 2 })).toBe('person:p1');
  });

  it('does not collapse different BI or UCV entities into their opportunity key', () => {
    const bi: Action = { type: 'UPDATE_BI', accId: 'a1', oppId: 'o1', biId: 'bi1', patch: { description: 'x' } };
    const ucv: Action = { type: 'UPDATE_UCV', accId: 'a1', oppId: 'o1', ucvId: 'u1', patch: { description: 'y' } };
    expect(entityKeyForAction(bi)).toBe('bi:bi1');
    expect(entityKeyForAction(ucv)).toBe('ucv:u1');
  });

  it('uses the same key for create and later writes across every entity family', () => {
    const pairs: Array<[Action, Action, string]> = [
      [{ type: 'ADD_ACCOUNT', account: { id: 'a1' } } as Action, { type: 'UPDATE_ACCOUNT', accId: 'a1', patch: {} } as Action, 'account:a1'],
      [{ type: 'ADD_OPP', accId: 'a1', opp: { id: 'o1' } } as Action, { type: 'UPDATE_OPP', accId: 'a1', oppId: 'o1', patch: {} } as Action, 'opportunity:o1'],
      [{ type: 'ADD_PERSON', accId: 'a1', person: { id: 'p1' } } as Action, personAction('x'), 'person:p1'],
      [{ type: 'ADD_EDGE', accId: 'a1', edge: { id: 'e1' } } as Action, { type: 'DELETE_EDGE', accId: 'a1', oppId: 'o1', edgeId: 'e1' } as Action, 'edge:e1'],
      [{ type: 'ADD_BI', accId: 'a1', oppId: 'o1', bi: { id: 'b1' } } as Action, { type: 'DELETE_BI', accId: 'a1', oppId: 'o1', biId: 'b1' } as Action, 'bi:b1'],
      [{ type: 'ADD_UCV', accId: 'a1', oppId: 'o1', ucv: { id: 'u1' } } as Action, { type: 'DELETE_UCV', accId: 'a1', oppId: 'o1', ucvId: 'u1' } as Action, 'ucv:u1'],
      [{ type: 'ADD_VISIT', accId: 'a1', visit: { id: 'v1' } } as Action, { type: 'UPDATE_VISIT', accId: 'a1', visitId: 'v1', patch: {} } as Action, 'visit:v1'],
      [{ type: 'ADD_NOTE', accId: 'a1', note: { id: 'n1' } } as Action, { type: 'DELETE_NOTE', accId: 'a1', noteId: 'n1' } as Action, 'note:n1'],
      [{ type: 'ADD_PLAN_ACTION', accId: 'a1', oppId: 'o1', planAction: { id: 'pa1' } } as Action, { type: 'TOGGLE_PLAN_ACTION', accId: 'a1', actionId: 'pa1', done: true } as Action, 'plan-action:pa1'],
      [{ type: 'ADD_MILESTONE', accId: 'a1', oppId: 'o1', milestone: { id: 'm1' } } as Action, { type: 'DELETE_MILESTONE', accId: 'a1', milestoneId: 'm1' } as Action, 'milestone:m1'],
      [{ type: 'ADD_OPP_STAGE', accId: 'a1', oppId: 'o1', stage: { id: 's1' } } as Action, { type: 'UPDATE_OPP_STAGE', accId: 'a1', stageId: 's1', patch: {} } as Action, 'stage:s1'],
      [{ type: 'ADD_STRATEGY_CARD', accId: 'a1', oppId: 'o1', card: { id: 'c1' } } as Action, { type: 'DELETE_STRATEGY_CARD', accId: 'a1', cardId: 'c1' } as Action, 'strategy-card:c1'],
      [{ type: 'ADD_STRATEGY_RISK', accId: 'a1', oppId: 'o1', risk: { id: 'r1' } } as Action, { type: 'DELETE_STRATEGY_RISK', accId: 'a1', riskId: 'r1' } as Action, 'strategy-risk:r1'],
      [{ type: 'ADD_STRATEGY_RESOURCE', accId: 'a1', oppId: 'o1', resource: { id: 'rs1' } } as Action, { type: 'DELETE_STRATEGY_RESOURCE', accId: 'a1', resourceId: 'rs1' } as Action, 'strategy-resource:rs1'],
      [{ type: 'ADD_EVIDENCE', accId: 'a1', oppId: 'o1', evidence: { id: 'ev1' } } as Action, { type: 'DELETE_EVIDENCE', accId: 'a1', oppId: 'o1', evidenceId: 'ev1' } as Action, 'evidence:ev1'],
    ];
    for (const [created, later, expected] of pairs) {
      expect(entityKeyForAction(created)).toBe(expected);
      expect(entityKeyForAction(later)).toBe(expected);
    }
    expect(entityKeyForAction(pairs[6][0])).not.toBe(entityKeyForAction(pairs[7][0]));
  });

  it('serializes writes for the same entity', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let callIndex = 0;
    const send = vi.fn(async (action: Action) => {
      if (action.type !== 'UPDATE_PERSON') throw new Error('unexpected action');
      order.push(`start:${String(action.patch.name)}`);
      if (callIndex++ === 0) await firstGate;
      order.push(`end:${String(action.patch.name)}`);
    });
    const coordinator = createMutationCoordinator(send);

    const a = coordinator.enqueue('person:p1', personAction('A'));
    const b = coordinator.enqueue('person:p1', personAction('B'));
    await Promise.resolve();
    expect(order).toEqual(['start:A']);
    releaseFirst();
    await Promise.all([a, b]);

    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
    expect(coordinator.state('person:p1').phase).toBe('saved');
  });

  it('allows different entities to save in parallel', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = createMutationCoordinator(async (action) => {
      if (action.type !== 'UPDATE_PERSON') throw new Error('unexpected action');
      started.push(String(action.patch.name));
      await gate;
    });

    const first = coordinator.enqueue('person:p1', personAction('A'));
    const secondAction: Action = { type: 'UPDATE_PERSON', accId: 'a1', personId: 'p2', patch: { name: 'B' } };
    const second = coordinator.enqueue('person:p2', secondAction);
    await Promise.resolve();
    expect(started).toEqual(['A', 'B']);
    release();
    await Promise.all([first, second]);
  });

  it('retains a failed action and clears it after retry succeeds', async () => {
    let attempts = 0;
    const coordinator = createMutationCoordinator(async () => {
      attempts += 1;
      if (attempts === 1) throw new ApiError({ status: 503, code: 'unavailable', message: 'offline', retryable: true });
    });
    const action = personAction('A');

    await expect(coordinator.enqueue('person:p1', action)).rejects.toMatchObject({ status: 503 });
    expect(coordinator.state('person:p1')).toMatchObject({ phase: 'failed', failedAction: action });
    await coordinator.retry('person:p1');
    expect(coordinator.state('person:p1').phase).toBe('saved');
    expect(coordinator.state('person:p1').failedAction).toBeUndefined();
  });

  it('pauses later same-entity writes until the failed action is retried', async () => {
    const sent: string[] = [];
    let attempts = 0;
    const coordinator = createMutationCoordinator(async (action) => {
      if (action.type !== 'UPDATE_PERSON') throw new Error('unexpected action');
      sent.push(String(action.patch.name));
      attempts += 1;
      if (attempts === 1) throw new ApiError({ status: 503, message: 'offline', retryable: true });
    });

    await expect(coordinator.enqueue('person:p1', personAction('A'))).rejects.toMatchObject({ status: 503 });
    const later = coordinator.enqueue('person:p1', personAction('B'));
    await Promise.resolve();
    expect(sent).toEqual(['A']);
    await coordinator.retry('person:p1');
    await later;
    expect(sent).toEqual(['A', 'A', 'B']);
    expect(coordinator.state('person:p1').phase).toBe('saved');
  });

  it('routes 401 centrally and preserves 409 as a conflict with the local action', async () => {
    const authFailures: ApiError[] = [];
    const authCoordinator = createMutationCoordinator(
      async () => { throw new ApiError({ status: 401, code: 'unauthorized', message: 'expired', retryable: false }); },
      { onUnauthorized: (error) => authFailures.push(error) },
    );
    await expect(authCoordinator.enqueue('person:p1', personAction('A'))).rejects.toMatchObject({ status: 401 });
    expect(authFailures).toHaveLength(1);

    const localAction = personAction('mine');
    const conflictCoordinator = createMutationCoordinator(async () => {
      throw new ApiError({ status: 409, code: 'version_conflict', message: 'conflict', retryable: false });
    });
    await expect(conflictCoordinator.enqueue('person:p1', localAction)).rejects.toMatchObject({ status: 409 });
    expect(conflictCoordinator.state('person:p1')).toMatchObject({
      phase: 'conflict',
      failedAction: localAction,
    });
  });

  it('does not blindly retry an ambiguous create after a network failure', async () => {
    const send = vi.fn(async () => { throw new ApiError({ code: 'timeout', message: 'timeout', retryable: true }); });
    const coordinator = createMutationCoordinator(send);
    const create = { type: 'ADD_PERSON', accId: 'a1', person: { id: 'p1' } } as Action;
    await expect(coordinator.enqueue('person:p1', create)).rejects.toMatchObject({ code: 'ambiguous_outcome' });
    expect(coordinator.state('person:p1')).toMatchObject({ phase: 'conflict', canRetry: false });
    await expect(coordinator.retry('person:p1')).rejects.toMatchObject({ code: 'ambiguous_outcome' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('delegates pending draft cancellation by entity key', () => {
    const cancelled: string[] = [];
    const coordinator = createMutationCoordinator(async () => undefined, {
      onCancelDraft: (key) => cancelled.push(key),
    });
    coordinator.cancelDraft('person:p1');
    expect(cancelled).toEqual(['person:p1']);
  });

  it('keeps conflict and pending draft when viewing cloud fails', async () => {
    const cancelled: string[] = [];
    const coordinator = createMutationCoordinator(async () => {
      throw new ApiError({ status: 409, code: 'version_conflict', message: 'conflict' });
    }, { onCancelDraft: (key) => cancelled.push(key) });
    await expect(coordinator.enqueue('person:p1', personAction('mine'))).rejects.toMatchObject({ status: 409 });
    await expect(discardAfterCloudRefresh(coordinator, 'person:p1', async () => {
      throw new ApiError({ code: 'network_error', message: 'offline', retryable: true });
    })).rejects.toMatchObject({ code: 'network_error' });
    expect(cancelled).toEqual([]);
    expect(coordinator.state('person:p1').phase).toBe('conflict');
  });

  it('rebases the local action before keep-mine retries a conflict', async () => {
    const sent: Action[] = [];
    const retried: Action[] = [];
    const coordinator = createMutationCoordinator(async (action) => {
      sent.push(action);
      if (sent.length === 1) throw new ApiError({ status: 409, code: 'version_conflict', message: 'conflict' });
    }, {
      prepareConflictRetry: async (action) => ({ ...action, baseVersion: 7 } as Action),
      onRetrySuccess: (_original, action) => retried.push(action),
    });
    await expect(coordinator.enqueue('person:p1', personAction('mine'))).rejects.toMatchObject({ status: 409 });
    await coordinator.retry('person:p1');

    expect(sent[1]).toMatchObject({ baseVersion: 7, patch: { name: 'mine' } });
    expect(retried[0]).toMatchObject({ baseVersion: 7 });
    expect(coordinator.state('person:p1').phase).toBe('saved');
  });

  it('rebases queued optimistic writes after a conflict retry succeeds', async () => {
    const bases: Array<number | undefined> = [];
    let first = true;
    const coordinator = createMutationCoordinator(async (action) => {
      bases.push('baseVersion' in action ? action.baseVersion : undefined);
      if (first) {
        first = false;
        throw new ApiError({ status: 409, code: 'version_conflict', message: 'conflict' });
      }
    }, {
      prepareConflictRetry: async (action) => ({ ...action, baseVersion: 5 } as Action),
    });
    const a = { ...personAction('A'), baseVersion: 0 } as Action;
    const b = { ...personAction('B'), baseVersion: 1 } as Action;
    await expect(coordinator.enqueue('person:p1', a)).rejects.toMatchObject({ status: 409 });
    const later = coordinator.enqueue('person:p1', b);
    await coordinator.retry('person:p1');
    await later;
    expect(bases).toEqual([0, 5, 6]);
    expect(coordinator.state('person:p1').phase).toBe('saved');
  });

  it('atomically clears queued work and ignores stale completion after session reset', async () => {
    const sent: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = createMutationCoordinator(async (action) => {
      if (action.type === 'UPDATE_PERSON') sent.push(String(action.patch.name));
      if (sent.length === 1) await gate;
    });
    const running = coordinator.enqueue('person:p1', personAction('A'));
    const queued = coordinator.enqueue('person:p1', personAction('B'));
    coordinator.reset();
    await expect(queued).rejects.toMatchObject({ code: 'session_reset' });
    expect(coordinator.globalState().phase).toBe('idle');
    await coordinator.enqueue('person:p1', personAction('new tenant'));
    expect(sent).toEqual(['A', 'new tenant']);
    release();
    await expect(running).rejects.toMatchObject({ code: 'session_reset' });
    expect(coordinator.globalState().phase).toBe('saved');
  });

  it('keeps dependency batches exclusive without serializing ordinary singles', async () => {
    const order: string[] = [];
    let releaseSingles!: () => void;
    let releaseBatch!: () => void;
    const singlesGate = new Promise<void>((resolve) => { releaseSingles = resolve; });
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const gate = createMutationExecutionGate(async (action) => {
      if (action.type !== 'UPDATE_PERSON') throw new Error('unexpected action');
      const name = String(action.patch.name);
      order.push(`start:${name}`);
      if (name === 'A' || name === 'B') await singlesGate;
      if (name === 'C') await batchGate;
      order.push(`end:${name}`);
    });

    const a = gate.run(personAction('A'));
    const b = gate.run(personAction('B'));
    await Promise.resolve();
    expect(order).toEqual(['start:A', 'start:B']);

    const batch = gate.runBatch([personAction('C'), personAction('D')]);
    const later = gate.run(personAction('E'));
    releaseSingles();
    await Promise.all([a, b]);
    await vi.waitFor(() => expect(order).toContain('start:C'));
    expect(order).not.toContain('start:E');
    releaseBatch();
    await batch;
    await later;
    expect(order.indexOf('end:D')).toBeLessThan(order.indexOf('start:E'));
  });

  it('keeps later mutations behind a failed batch recovery barrier', async () => {
    const order: string[] = [];
    let releaseBatch!: () => void;
    let releaseRecovery!: () => void;
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    const recoveryGate = new Promise<void>((resolve) => { releaseRecovery = resolve; });
    const gate = createMutationExecutionGate(async (action) => {
      if (action.type !== 'UPDATE_PERSON') throw new Error('unexpected action');
      const name = String(action.patch.name);
      order.push(`apply:${name}`);
      if (name === 'batch') {
        await batchGate;
        throw new Error('batch failed');
      }
    });

    const batch = gate.runBatch([personAction('batch')], async () => {
      order.push('recovery:start');
      await recoveryGate;
      order.push('recovery:end');
    });
    await vi.waitFor(() => expect(order).toEqual(['apply:batch']));
    const later = gate.run(personAction('later'), () => order.push('history:later'));
    releaseBatch();
    await vi.waitFor(() => expect(order).toContain('recovery:start'));
    expect(order).toEqual(['apply:batch', 'recovery:start']);
    releaseRecovery();
    await expect(batch).rejects.toThrow('batch failed');
    await later;
    expect(order).toEqual(['apply:batch', 'recovery:start', 'recovery:end', 'history:later', 'apply:later']);
  });
});
