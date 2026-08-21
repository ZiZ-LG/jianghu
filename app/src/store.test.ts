// 乐观锁（#3 多人协作冲突检测）前端契约单测：
// ① injectBaseVersion 在 dispatch 前正确取出实体当前 version 作 baseVersion；
// ② reducer 对 UPDATE_PERSON/OPP/EDGE 乐观自增 version，保持本地与服务端步调一致。
import { describe, it, expect, vi } from 'vitest';
import { alignVersionAfterRetry, applyActionsSequentially, computeInverse, reducer, injectBaseVersion, invalidateHistory, transitionHistory, type Action, type StoreState } from './store';
import type { Account } from './types';

function baseState(): StoreState {
  const acc: Account = {
    id: 'acc1', name: 'A', customerType: 1,
    persons: [{
      id: 'p1', name: '张三', title: '', orgLevel: 3,
      form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} },
      logs: [], x: 0, y: 0, version: 3,
    }],
    baseEdges: [{ id: 'e1', source: 'p1', target: 'p2', layer: 'L1', label: '', version: 5 }],
    opportunities: [{
      id: 'opp1', accountId: 'acc1', name: 'O', customerType: 1,
      pipelineStage: '线索', engageStage: '需求调研立项', singleSalesGoal: '',
      c3Items: {}, c5Items: {}, roles: [], bis: [], ucvs: [],
      edges: [{ id: 'e2', source: 'p1', target: 'p3', layer: 'L2', label: '', version: 7 }],
      version: 9,
    }],
  };
  return { accounts: [acc] };
}

describe('乐观锁 · injectBaseVersion（dispatch 前取当前版本）', () => {
  it('UPDATE_PERSON 注入 person 当前 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: { name: '李四' } });
    expect((a as Extract<Action, { type: 'UPDATE_PERSON' }>).baseVersion).toBe(3);
  });
  it('UPDATE_OPP 注入 opp 当前 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_OPP', accId: 'acc1', oppId: 'opp1', patch: { name: 'X' } });
    expect((a as Extract<Action, { type: 'UPDATE_OPP' }>).baseVersion).toBe(9);
  });
  it('UPDATE_EDGE 从 baseEdges 命中并取 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e1', patch: { label: 'x' } });
    expect((a as Extract<Action, { type: 'UPDATE_EDGE' }>).baseVersion).toBe(5);
  });
  it('UPDATE_EDGE 从商机 edges 命中并取 version', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e2', patch: { label: 'x' } });
    expect((a as Extract<Action, { type: 'UPDATE_EDGE' }>).baseVersion).toBe(7);
  });
  it('实体不存在时 baseVersion 为 undefined（后端走兼容路径，不误判冲突）', () => {
    const a = injectBaseVersion(baseState(), { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'nope', patch: {} });
    expect((a as Extract<Action, { type: 'UPDATE_PERSON' }>).baseVersion).toBeUndefined();
  });
  it('非 UPDATE 类 action 原样返回（引用不变）', () => {
    const action: Action = { type: 'DELETE_PERSON', accId: 'acc1', personId: 'p1' };
    expect(injectBaseVersion(baseState(), action)).toBe(action);
  });
});

describe('乐观锁 · reducer 乐观自增 version', () => {
  it('UPDATE_PERSON 应用 patch 并 version+1', () => {
    const s = reducer(baseState(), { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: { name: '李四' } });
    const p = s.accounts[0].persons[0];
    expect(p.name).toBe('李四');
    expect(p.version).toBe(4);
  });
  it('UPDATE_OPP version+1', () => {
    const s = reducer(baseState(), { type: 'UPDATE_OPP', accId: 'acc1', oppId: 'opp1', patch: { name: 'X' } });
    expect(s.accounts[0].opportunities[0].version).toBe(10);
  });
  it('UPDATE_EDGE（baseEdges）version+1，其余边不动', () => {
    const s = reducer(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e1', patch: { label: 'x' } });
    expect(s.accounts[0].baseEdges[0].version).toBe(6);
    expect(s.accounts[0].opportunities[0].edges[0].version).toBe(7); // e2 未改
  });
  it('UPDATE_EDGE（商机 edges）version+1', () => {
    const s = reducer(baseState(), { type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e2', patch: { label: 'x' } });
    expect(s.accounts[0].opportunities[0].edges[0].version).toBe(8);
  });
  it('version 缺省（本地新建实体）时按 0 起增为 1', () => {
    const st = baseState();
    delete (st.accounts[0].persons[0] as { version?: number }).version;
    const s = reducer(st, { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: {} });
    expect(s.accounts[0].persons[0].version).toBe(1);
  });
});

describe('乐观锁 · retry 版本对齐', () => {
  it('保留本地草稿并将 Person 对齐到重试后版本', () => {
    const optimistic = reducer(baseState(), { type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: { name: '我的值' } });
    const aligned = alignVersionAfterRetry(optimistic, {
      type: 'UPDATE_PERSON', accId: 'acc1', personId: 'p1', patch: { name: '我的值' }, baseVersion: 8,
    }, 5);
    expect(aligned.accounts[0].persons[0]).toMatchObject({ name: '我的值', version: 9 });
  });

  it('对齐 Opportunity 和 Edge 版本时不覆盖其他本地字段', () => {
    const state = baseState();
    state.accounts[0].opportunities[0].name = '本地商机';
    state.accounts[0].baseEdges[0].label = '本地关系';
    const opp = alignVersionAfterRetry(state, {
      type: 'UPDATE_OPP', accId: 'acc1', oppId: 'opp1', patch: { name: '本地商机' }, baseVersion: 12,
    }, 4);
    const edge = alignVersionAfterRetry(opp, {
      type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e1', patch: { label: '本地关系' }, baseVersion: 14,
    }, 10);
    expect(edge.accounts[0].opportunities[0]).toMatchObject({ name: '本地商机', version: 13 });
    expect(edge.accounts[0].baseEdges[0]).toMatchObject({ label: '本地关系', version: 15 });
  });
});

describe('account-level edges', () => {
  it('adds an edge without oppId to baseEdges', () => {
    const state = reducer(baseState(), {
      type: 'ADD_EDGE',
      accId: 'acc1',
      edge: { id: 'e-base-new', source: 'p1', target: 'p2', layer: 'L1', label: '汇报' },
    });

    expect(state.accounts[0].baseEdges.map((edge) => edge.id)).toContain('e-base-new');
    expect(state.accounts[0].opportunities[0].edges.map((edge) => edge.id)).not.toContain('e-base-new');
  });

  it('keeps an unknown open Relation kind during optimistic add and update', () => {
    const added = reducer(baseState(), {
      type: 'ADD_EDGE', accId: 'acc1', oppId: 'opp1',
      edge: { id: 'e-open', source: 'p1', target: 'p2', kind: 'trusted_advisor', layer: 'L2', label: '顾问' },
    });
    expect((added.accounts[0].opportunities[0].edges.find((edge) => edge.id === 'e-open') as any).kind).toBe('trusted_advisor');
    const updated = reducer(added, {
      type: 'UPDATE_EDGE', accId: 'acc1', oppId: 'opp1', edgeId: 'e-open', patch: { kind: 'former_colleague' },
    });
    expect((updated.accounts[0].opportunities[0].edges.find((edge) => edge.id === 'e-open') as any).kind).toBe('former_colleague');
  });
});

describe('generic Matter participation projection', () => {
  it('adds participation when the sales adapter writes a role', () => {
    const next = reducer(baseState(), {
      type: 'SET_ROLE', accId: 'acc1', oppId: 'opp1', personId: 'p1', patch: { role: 'R' },
    });
    expect((next.accounts[0].opportunities[0] as any).participantIds).toEqual(['p1']);
  });
});

describe('G64111 selection optimism', () => {
  it('keeps only the newly selected P4 in local state', () => {
    const state = baseState();
    state.accounts[0].opportunities[0].roles = [
      { personId: 'p1', role: 'U', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
      { personId: 'p2', role: 'R', sentiment: 'plus', confidence: '明确', isKeyInfluencer: false },
    ];

    const next = reducer(state, {
      type: 'SET_ROLE', accId: 'acc1', oppId: 'opp1', personId: 'p2', patch: { isKeyInfluencer: true },
    });

    expect(next.accounts[0].opportunities[0].roles.filter((role) => role.isKeyInfluencer).map((role) => role.personId)).toEqual(['p2']);
  });

  it('restores the displaced P4 when selection is undone', () => {
    const state = baseState();
    state.accounts[0].opportunities[0].roles = [
      { personId: 'p1', role: 'U', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
      { personId: 'p2', role: 'R', sentiment: 'plus', confidence: '明确', isKeyInfluencer: false },
    ];
    const action: Action = {
      type: 'SET_ROLE', accId: 'acc1', oppId: 'opp1', personId: 'p2', patch: { isKeyInfluencer: true },
    };

    const inverse = computeInverse(action, state);
    const selected = reducer(state, action);
    const restored = inverse!.reduce((current, inverseAction) => reducer(current, inverseAction), selected);

    expect(restored.accounts[0].opportunities[0].roles).toEqual(state.accounts[0].opportunities[0].roles);
  });

  it.each(['SET_ROLE', 'REMOVE_ROLE'] as const)('restores primary D when %s is undone', (type) => {
    const state = baseState();
    state.accounts[0].opportunities[0].primaryDPersonId = 'p1';
    state.accounts[0].opportunities[0].roles = [
      { personId: 'p1', role: 'D', sentiment: 'plus', confidence: '明确' },
    ];
    const action: Action = type === 'SET_ROLE'
      ? { type, accId: 'acc1', oppId: 'opp1', personId: 'p1', patch: { role: 'R' } }
      : { type, accId: 'acc1', oppId: 'opp1', personId: 'p1' };

    const inverse = computeInverse(action, state);
    const changed = reducer(state, action);
    expect(changed.accounts[0].opportunities[0].primaryDPersonId).toBeNull();
    const restored = inverse!.reduce((current, inverseAction) => reducer(current, inverseAction), changed);

    expect(restored.accounts[0].opportunities[0].primaryDPersonId).toBe('p1');
    expect(restored.accounts[0].opportunities[0].roles[0].role).toBe('D');
  });

  it('clears primary D on DELETE_PERSON but does not create a lossy inverse from the ACL-trimmed client snapshot', () => {
    const state = baseState();
    const opportunity = state.accounts[0].opportunities[0];
    opportunity.primaryDPersonId = 'p1';
    opportunity.roles = [{ personId: 'p1', role: 'D', sentiment: 'plus', confidence: '明确' }];
    opportunity.bis = [{ id: 'bi-p1', personId: 'p1', description: '虚构问题', category: '业务', isPrivate: false, confidence: '明确' }];
    opportunity.ucvs = [{ id: 'ucv-p1', targetBiId: 'bi-p1', description: '虚构价值', competitorCannot: '虚构差异', status: '建议' }];
    opportunity.memberIds = ['p1'];
    const action: Action = { type: 'DELETE_PERSON', accId: 'acc1', personId: 'p1' };

    const inverse = computeInverse(action, state);
    const deleted = reducer(state, action);
    expect(deleted.accounts[0].opportunities[0].primaryDPersonId).toBeNull();
    expect(deleted.accounts[0].persons).toHaveLength(0);
    expect(inverse).toBeNull();
  });

  it('round-trips REMOVE_ROLE through undo and redo without losing primary D', () => {
    const state = baseState();
    state.accounts[0].opportunities[0].primaryDPersonId = 'p1';
    state.accounts[0].opportunities[0].roles = [
      { personId: 'p1', role: 'D', sentiment: 'star', confidence: '共识' },
    ];
    const before = structuredClone(state);
    const action: Action = { type: 'REMOVE_ROLE', accId: 'acc1', oppId: 'opp1', personId: 'p1' };
    const inverse = computeInverse(action, state)!;
    const removed = reducer(state, action);
    const restored = inverse.reduce((current, inverseAction) => reducer(current, inverseAction), removed);

    expect(restored.accounts[0].opportunities[0]).toMatchObject({
      primaryDPersonId: 'p1', roles: before.accounts[0].opportunities[0].roles,
    });
    expect(reducer(restored, action).accounts[0].opportunities[0]).toMatchObject({
      primaryDPersonId: null, roles: [],
    });
  });
});

describe('INT-103 destructive action compatibility', () => {
  it('does not remove accounts or opportunities when a legacy DELETE action reaches the reducer', () => {
    const state = baseState();
    const afterOpportunity = reducer(state, { type: 'DELETE_OPP', accId: 'acc1', oppId: 'opp1' });
    const afterAccount = reducer(state, { type: 'DELETE_ACCOUNT', accId: 'acc1' });

    expect(afterOpportunity).toBe(state);
    expect(afterAccount).toBe(state);
  });
});

describe('account profile provenance', () => {
  it('clears _mcpOrigin optimistically when a human updates the profile', () => {
    const state = baseState();
    state.accounts[0].profile = {
      business: 'Old business',
      group: 'Keep group',
      _mcpOrigin: { source: 'mcp', at: '2026-07-12T00:00:00.000Z', needsReview: true },
    };

    const updated = reducer(state, {
      type: 'UPDATE_ACCOUNT',
      accId: 'acc1',
      patch: { profile: { ...state.accounts[0].profile, business: 'Human verified business' } },
    });

    expect(updated.accounts[0].profile).toEqual({
      business: 'Human verified business',
      group: 'Keep group',
    });
  });
});

function planActionReferenceState(): StoreState {
  const state = baseState();
  state.accounts[0].planActions = [
    {
      id: 'plan-delete', accountId: 'acc1', opportunityId: 'opp1', title: 'Delete me',
      startDate: '2026-07-12', endDate: '2026-07-12', half: 'am', done: false,
    },
    {
      id: 'plan-keep-before', accountId: 'acc1', opportunityId: 'opp1', title: 'Keep before',
      startDate: '2026-07-13', endDate: '2026-07-13', half: 'am', done: false,
    },
    {
      id: 'plan-keep-after', accountId: 'acc1', opportunityId: 'opp1', title: 'Keep after',
      startDate: '2026-07-14', endDate: '2026-07-14', half: 'pm', done: false,
    },
  ];
  state.accounts[0].strategyCards = [
    {
      id: 'card-one', accountId: 'acc1', opportunityId: 'opp1', title: 'Card one',
      dispatchedActionIds: ['plan-keep-before', 'plan-delete', 'plan-keep-after', 'plan-delete'],
    },
    {
      id: 'card-two', accountId: 'acc1', opportunityId: 'opp1', title: 'Card two',
      dispatchedActionIds: ['plan-delete'],
    },
    {
      id: 'card-other-opp', accountId: 'acc1', opportunityId: 'opp-other', title: 'Other opp',
      dispatchedActionIds: ['plan-delete'],
    },
  ];
  return state;
}

describe('TOGGLE_PLAN_ACTION business date', () => {
  it('uses the Beijing completion day, preserves an explicit date, and clears it when reopened', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-14T16:30:00Z'));
      const completed = reducer(planActionReferenceState(), {
        type: 'TOGGLE_PLAN_ACTION', accId: 'acc1', actionId: 'plan-delete', done: true,
      });
      expect(completed.accounts[0].planActions?.[0].doneAt).toBe('2026-07-15');

      const explicit = reducer(planActionReferenceState(), {
        type: 'TOGGLE_PLAN_ACTION', accId: 'acc1', actionId: 'plan-delete', done: true, doneAt: '2026-07-10',
      });
      expect(explicit.accounts[0].planActions?.[0].doneAt).toBe('2026-07-10');

      const reopened = reducer(completed, {
        type: 'TOGGLE_PLAN_ACTION', accId: 'acc1', actionId: 'plan-delete', done: false,
      });
      expect(reopened.accounts[0].planActions?.[0].doneAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('DELETE_PLAN_ACTION reverse references and undo', () => {
  const action: Action = { type: 'DELETE_PLAN_ACTION', accId: 'acc1', actionId: 'plan-delete' };

  it('optimistically removes the deleted id only from StrategyCards in the PlanAction Opportunity', () => {
    const deleted = reducer(planActionReferenceState(), action);

    expect(deleted.accounts[0].planActions?.map((item) => item.id)).toEqual(['plan-keep-before', 'plan-keep-after']);
    expect(deleted.accounts[0].strategyCards?.map((card) => [card.id, card.dispatchedActionIds])).toEqual([
      ['card-one', ['plan-keep-before', 'plan-keep-after']],
      ['card-two', []],
      ['card-other-opp', ['plan-delete']],
    ]);
  });

  it('recreates the PlanAction first and then restores every exact prior card reference array', () => {
    const before = planActionReferenceState();
    const inverse = computeInverse(action, before);

    expect(inverse).toEqual([
      { type: 'ADD_PLAN_ACTION', accId: 'acc1', oppId: 'opp1', planAction: before.accounts[0].planActions?.[0] },
      { type: 'UPDATE_STRATEGY_CARD', accId: 'acc1', cardId: 'card-one', patch: { dispatchedActionIds: ['plan-keep-before', 'plan-delete', 'plan-keep-after', 'plan-delete'] } },
      { type: 'UPDATE_STRATEGY_CARD', accId: 'acc1', cardId: 'card-two', patch: { dispatchedActionIds: ['plan-delete'] } },
    ]);

    const deleted = reducer(before, action);
    const restored = inverse!.reduce((state, inverseAction) => reducer(state, inverseAction), deleted);
    expect(restored.accounts[0].planActions).toHaveLength(before.accounts[0].planActions!.length);
    expect(restored.accounts[0].planActions?.find((item) => item.id === 'plan-delete')).toEqual(before.accounts[0].planActions?.[0]);
    expect(restored.accounts[0].strategyCards).toEqual(before.accounts[0].strategyCards);
  });

  it('executes a dependent inverse batch sequentially', async () => {
    const events: string[] = [];
    await applyActionsSequentially([
      { type: 'DELETE_PERSON', accId: 'acc1', personId: 'first' },
      { type: 'DELETE_PERSON', accId: 'acc1', personId: 'second' },
    ], async (item) => {
      if (item.type !== 'DELETE_PERSON') throw new Error('unexpected action type');
      events.push(`start:${item.personId}`);
      await Promise.resolve();
      events.push(`end:${item.personId}`);
    });

    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
  });

  it('persists an immediate undo strictly after the delayed delete and keeps the inverse batch contiguous', async () => {
    const storeModule = await import('./store');
    const createQueue = (storeModule as unknown as {
      createActionPersistenceQueue?: (apply: (action: Action) => Promise<void>) => (actions: readonly Action[]) => Promise<void>;
    }).createActionPersistenceQueue;
    expect(createQueue).toBeTypeOf('function');
    if (!createQueue) return;

    let releaseDelete!: () => void;
    const deleteBlocked = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const calls: string[] = [];
    const queue = createQueue(async (item) => {
      calls.push(`start:${item.type}`);
      if (item.type === 'DELETE_PLAN_ACTION') await deleteBlocked;
      calls.push(`end:${item.type}`);
    });
    const deletePromise = queue([action]);
    const undoPromise = queue([
      { type: 'ADD_PLAN_ACTION', accId: 'acc1', oppId: 'opp1', planAction: planActionReferenceState().accounts[0].planActions![0] },
      { type: 'UPDATE_STRATEGY_CARD', accId: 'acc1', cardId: 'card-one', patch: { dispatchedActionIds: ['plan-delete'] } },
    ]);
    const laterMutation = queue([{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'later' }]);

    await Promise.resolve();
    expect(calls).toEqual(['start:DELETE_PLAN_ACTION']);
    releaseDelete();
    await Promise.all([deletePromise, undoPromise, laterMutation]);
    expect(calls).toEqual([
      'start:DELETE_PLAN_ACTION', 'end:DELETE_PLAN_ACTION',
      'start:ADD_PLAN_ACTION', 'end:ADD_PLAN_ACTION',
      'start:UPDATE_STRATEGY_CARD', 'end:UPDATE_STRATEGY_CARD',
      'start:DELETE_PERSON', 'end:DELETE_PERSON',
    ]);
  });

  for (const failureType of ['ADD_PLAN_ACTION', 'UPDATE_STRATEGY_CARD'] as const) {
    it(`keeps the undo stack item, refreshes state, and stops after a rejected ${failureType}`, async () => {
      const storeModule = await import('./store');
      const transition = (storeModule as unknown as {
        transitionHistory?: (
          source: Array<{ redo: Action[]; undo: Action[] }>,
          destination: Array<{ redo: Action[]; undo: Action[] }>,
          direction: 'undo' | 'redo',
          applyBatch: (actions: readonly Action[]) => Promise<void>,
          refresh: (failedActions: readonly Action[]) => Promise<void>,
        ) => Promise<string>;
      }).transitionHistory;
      expect(transition).toBeTypeOf('function');
      if (!transition) return;

      const item = {
        redo: [action],
        undo: [
          { type: 'ADD_PLAN_ACTION', accId: 'acc1', oppId: 'opp1', planAction: planActionReferenceState().accounts[0].planActions![0] },
          { type: 'UPDATE_STRATEGY_CARD', accId: 'acc1', cardId: 'card-one', patch: { dispatchedActionIds: ['plan-delete'] } },
          { type: 'UPDATE_STRATEGY_CARD', accId: 'acc1', cardId: 'card-two', patch: { dispatchedActionIds: ['plan-delete'] } },
        ] satisfies Action[],
      };
      const undoStack = [item];
      const redoStack: typeof undoStack = [];
      const calls: string[] = [];
      let refreshes = 0;
      let recoveredActions: readonly Action[] = [];

      const result = await transition(
        undoStack,
        redoStack,
        'undo',
        (actions) => applyActionsSequentially(actions, async (candidate) => {
          calls.push(candidate.type);
          if (candidate.type === failureType) throw new Error('synthetic persistence failure');
        }),
        async (failedActions) => { refreshes += 1; recoveredActions = failedActions; },
      );

      expect(result).toBe('failed');
      expect(undoStack).toEqual([item]);
      expect(redoStack).toEqual([]);
      expect(refreshes).toBe(1);
      expect(recoveredActions).toEqual(item.undo);
      expect(calls).toEqual(failureType === 'ADD_PLAN_ACTION'
        ? ['ADD_PLAN_ACTION']
        : ['ADD_PLAN_ACTION', 'UPDATE_STRATEGY_CARD']);
    });
  }

  it('claims the exact history item before awaiting and does not pop a later normal action', async () => {
    const storeModule = await import('./store');
    const transition = (storeModule as unknown as {
      transitionHistory: (
        source: Array<{ redo: Action[]; undo: Action[] }>,
        destination: Array<{ redo: Action[]; undo: Action[] }>,
        direction: 'undo' | 'redo',
        applyBatch: (actions: readonly Action[]) => Promise<void>,
        refresh: () => Promise<void>,
      ) => Promise<string>;
    }).transitionHistory;
    const original = { redo: [action], undo: [{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'original' }] satisfies Action[] };
    const later = { redo: [{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'later' }] satisfies Action[], undo: [action] };
    const undoStack: Array<{ redo: Action[]; undo: Action[] }> = [original];
    const redoStack: typeof undoStack = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const pending = transition(undoStack, redoStack, 'undo', async () => blocked, async () => {});
    await Promise.resolve();
    expect(undoStack).toEqual([]);
    undoStack.push(later);
    release();
    await expect(pending).resolves.toBe('applied');
    expect(undoStack).toEqual([later]);
    expect(redoStack).toEqual([original]);
  });

  it('rejects a second concurrent history transition with the same mutex', async () => {
    const storeModule = await import('./store');
    const transition = (storeModule as unknown as {
      transitionHistory: (
        source: Array<{ redo: Action[]; undo: Action[] }>,
        destination: Array<{ redo: Action[]; undo: Action[] }>,
        direction: 'undo' | 'redo',
        applyBatch: (actions: readonly Action[]) => Promise<void>,
        refresh: () => Promise<void>,
        options?: { lock?: { busy: boolean } },
      ) => Promise<string>;
    }).transitionHistory;
    const item = { redo: [action], undo: [{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'only' }] satisfies Action[] };
    const source = [item];
    const destination: typeof source = [];
    const lock = { busy: false };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = transition(source, destination, 'undo', async () => blocked, async () => {}, { lock });
    await Promise.resolve();
    await expect(transition(source, destination, 'undo', async () => {}, async () => {}, { lock })).resolves.toBe('busy');
    release();
    await expect(first).resolves.toBe('applied');
    expect(source).toEqual([]);
    expect(destination).toEqual([item]);
  });

  it('keeps a failed batch refresh inside the queue barrier before starting the next batch', async () => {
    const storeModule = await import('./store');
    const createQueue = (storeModule as unknown as {
      createActionPersistenceQueue: (
        apply: (action: Action) => Promise<void>,
        onBatchFailure?: () => Promise<void>,
      ) => (actions: readonly Action[]) => Promise<void>;
    }).createActionPersistenceQueue;
    const events: string[] = [];
    let releaseRefresh!: () => void;
    let markRefreshStarted!: () => void;
    const refreshBlocked = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const queue = createQueue(async (candidate) => {
      events.push(`apply:${candidate.type}`);
      if (candidate.type === 'ADD_PLAN_ACTION') throw new Error('synthetic batch failure');
    }, async () => {
      events.push('refresh:start');
      markRefreshStarted();
      await refreshBlocked;
      events.push('refresh:end');
    });

    const failed = queue([{ type: 'ADD_PLAN_ACTION', accId: 'acc1', oppId: 'opp1', planAction: planActionReferenceState().accounts[0].planActions![0] }]);
    const later = queue([{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'later' }]);
    await refreshStarted;
    expect(events).toEqual(['apply:ADD_PLAN_ACTION', 'refresh:start']);
    releaseRefresh();
    await expect(failed).rejects.toThrow('synthetic batch failure');
    await expect(later).resolves.toBeUndefined();
    expect(events).toEqual([
      'apply:ADD_PLAN_ACTION', 'refresh:start', 'refresh:end', 'apply:DELETE_PERSON',
    ]);
  });

  it('does not resurrect a claimed redo item after a later normal action invalidates redo', async () => {
    const storeModule = await import('./store');
    const transition = (storeModule as unknown as {
      transitionHistory: (
        source: Array<{ redo: Action[]; undo: Action[] }>,
        destination: Array<{ redo: Action[]; undo: Action[] }>,
        direction: 'undo' | 'redo',
        applyBatch: (actions: readonly Action[]) => Promise<void>,
        refresh: (() => Promise<void>) | undefined,
        options?: { canRestoreToSource?: () => boolean },
      ) => Promise<string>;
    }).transitionHistory;
    const claimed = { redo: [action], undo: [{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'claimed' }] satisfies Action[] };
    const redoStack: Array<{ redo: Action[]; undo: Action[] }> = [claimed];
    const undoStack: typeof redoStack = [];
    let revision = 0;
    const claimedRevision = revision;
    let rejectRedo!: (error: Error) => void;
    const blockedFailure = new Promise<void>((_resolve, reject) => { rejectRedo = reject; });

    const pending = transition(
      redoStack,
      undoStack,
      'redo',
      async () => blockedFailure,
      async () => {},
      { canRestoreToSource: () => revision === claimedRevision },
    );
    await Promise.resolve();
    expect(redoStack).toEqual([]);
    revision += 1; // later normal act：清空 redo 并使旧 redo 永久失效
    redoStack.length = 0;
    rejectRedo(new Error('synthetic redo failure'));

    await expect(pending).resolves.toBe('failed');
    expect(redoStack).toEqual([]);
    expect(undoStack).toEqual([]);
  });

  it('does not restore a partial batch history item when authoritative refresh also fails', async () => {
    const item = { redo: [action], undo: [{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'partial' }] satisfies Action[] };
    const source = [item];
    const destination: typeof source = [];
    let revision = 0;
    const claimedRevision = revision;
    const result = await transitionHistory(
      source,
      destination,
      'undo',
      async () => { throw new Error('batch failed'); },
      async () => { revision += 1; throw new Error('refresh failed'); },
      { canRestoreToSource: () => revision === claimedRevision },
    );
    expect(result).toBe('failed');
    expect(source).toEqual([]);
    expect(destination).toEqual([]);
  });

  it('invalidates stale undo and redo entries after choosing the cloud value', () => {
    const stale = { redo: [action], undo: [{ type: 'DELETE_PERSON', accId: 'acc1', personId: 'stale' }] satisfies Action[] };
    const undo = [stale];
    const redo = [stale];
    invalidateHistory(undo, redo);
    expect(undo).toEqual([]);
    expect(redo).toEqual([]);
  });
});
