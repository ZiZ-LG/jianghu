import { describe, expect, it } from 'vitest';
import type { Account, PlanAction } from '../types';
import type { InboxEvidence } from '../api';
import {
  buildMomentFlow,
  resolveQuickReviewDecision,
  visitActionView,
} from './momentFlowModel';
import { removeSuccessfulSelections, runBatchWithProgress } from './reviewBatch';

const action = (patch: Partial<PlanAction>): PlanAction => ({
  id: 'action', accountId: 'acc-1', opportunityId: 'opp-1', personId: 'person-1',
  title: '拜访客户', startDate: '2026-07-01', endDate: '2026-07-01', half: 'am', done: false,
  ...patch,
});

const account = (actions: PlanAction[]): Account => ({
  id: 'acc-1', name: '虚构客户', customerType: 1,
  persons: [{
    id: 'person-1', name: '测试联系人', title: '负责人', orgLevel: 1, x: 0, y: 0, logs: [],
    form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} },
  }],
  baseEdges: [],
  opportunities: [{
    id: 'opp-1', accountId: 'acc-1', name: '虚构商机', customerType: 1, expectedAmountW: 0,
    engageStage: '需求调研立项', pipelineStage: '线索', singleSalesGoal: '', competitiveSituation: '',
    c3Items: {}, c5Items: {}, roles: [], edges: [], bis: [], ucvs: [],
  }],
  planActions: actions,
});

const emptyInbox = {
  proposals: [], persons: [], rels: [], reminders: [], evidences: [], total: 0,
};

describe('buildMomentFlow', () => {
  it('sorts overdue actions before today across accounts by effective due date and stable tie-breakers', () => {
    const accountWithId = (id: string, actions: PlanAction[]): Account => ({
      ...account(actions),
      id,
      persons: account(actions).persons.map((person) => ({ ...person, id: `person-${id}` })),
      opportunities: account(actions).opportunities.map((opportunity) => ({ ...opportunity, id: `opp-${id}`, accountId: id })),
      planActions: actions.map((item) => ({ ...item, accountId: id, opportunityId: `opp-${id}`, personId: `person-${id}` })),
    });
    const storedFirst = accountWithId('acc-z', [
      action({ id: 'today-z', startDate: '2026-07-15', endDate: '2026-07-15' }),
      action({ id: 'tie-z', startDate: '2026-07-09', endDate: '2026-07-13' }),
      action({ id: 'completed-z', startDate: '2026-07-01', endDate: '2026-07-01', done: true }),
    ]);
    const storedSecond = accountWithId('acc-a', [
      action({ id: 'future-a', startDate: '2026-07-16', endDate: '2026-07-16' }),
      action({ id: 'fallback-a', startDate: '2026-07-10', endDate: '' }),
      action({ id: 'end-only-a', startDate: '', endDate: '2026-07-11' }),
      action({ id: 'tie-b', startDate: '2026-07-09', endDate: '2026-07-13' }),
      action({ id: 'tie-a', startDate: '2026-07-09', endDate: '2026-07-13' }),
      action({ id: 'today-a', startDate: '2026-07-15', endDate: '' }),
    ]);

    const model = buildMomentFlow({
      accounts: [storedFirst, storedSecond],
      inbox: emptyInbox,
      todayYmd: '2026-07-15',
    });

    expect(model.todayActions.map((item) => item.id)).toEqual([
      'fallback-a', 'end-only-a', 'tie-a', 'tie-b', 'tie-z', 'today-a', 'today-z',
    ]);
  });

  it('keeps unfinished overdue actions in today flow and excludes completed ones', () => {
    const model = buildMomentFlow({
      accounts: [account([
        action({ id: 'overdue', endDate: '2026-07-10' }),
        action({ id: 'completed', endDate: '2026-07-10', done: true }),
        action({ id: 'future', startDate: '2026-07-20', endDate: '2026-07-20' }),
      ])],
      inbox: emptyInbox,
      todayYmd: '2026-07-15',
    });

    expect(model.todayActions.map((item) => item.id)).toEqual(['overdue']);
  });

  it('does not silently drop overdue actions after the fifth card', () => {
    const actions = Array.from({ length: 6 }, (_, index) => action({ id: `overdue-${index}` }));
    const model = buildMomentFlow({ accounts: [account(actions)], inbox: emptyInbox, todayYmd: '2026-07-15' });

    expect(model.todayActions.map((item) => item.id)).toEqual(actions.map((item) => item.id));
  });

  it('builds an Evidence-only quick-review queue', () => {
    const evidence: InboxEvidence = {
      id: 'evidence-1', accountId: 'acc-1', accountName: '虚构客户', opportunityId: 'opp-1', oppName: '虚构商机',
      personId: 'person-1', personName: '测试联系人', signalKey: 'test_signal', signalLabel: '虚构信号',
      direction: 1, tier: 'mid', rawContent: '虚构证据原文', occurredAt: '2026-07-14', origin: 'ai',
    };

    const model = buildMomentFlow({
      accounts: [account([])],
      inbox: { ...emptyInbox, evidences: [evidence], total: 1 },
      todayYmd: '2026-07-15',
    });

    expect(model.reviewQueue).toEqual([expect.objectContaining({ kind: 'evidence', id: 'evidence-1' })]);
  });

  it('carries explicit account, opportunity, and person context into a visit action', () => {
    const model = buildMomentFlow({
      accounts: [account([action({ id: 'visit' })])], inbox: emptyInbox, todayYmd: '2026-07-15',
    });

    expect(model.todayActions[0].visitContext).toEqual({
      accId: 'acc-1', oppId: 'opp-1', personId: 'person-1',
    });
  });

  it('does not offer visit capture when its explicit opportunity context is invalid', () => {
    const model = buildMomentFlow({
      accounts: [account([action({ id: 'invalid-visit', opportunityId: 'missing-opp' })])],
      inbox: emptyInbox,
      todayYmd: '2026-07-15',
    });

    expect(model.todayActions[0].visitContext).toBeUndefined();
  });

  it('marks an invalid visit card unavailable instead of claiming it is ready', () => {
    const model = buildMomentFlow({
      accounts: [account([action({ id: 'invalid-visit', opportunityId: 'missing-opp' })])],
      inbox: emptyInbox,
      todayYmd: '2026-07-15',
    });

    expect(visitActionView(model.todayActions[0])).toEqual({
      canOpen: false,
      status: '拜访上下文不可用 · 请回作战室重新选择',
    });
  });

  it('marks only a valid model visitContext as ready', () => {
    const model = buildMomentFlow({ accounts: [account([action({ id: 'visit' })])], inbox: emptyInbox, todayYmd: '2026-07-15' });

    expect(visitActionView(model.todayActions[0])).toEqual({ canOpen: true, status: '❓ 拜访卡已备好 ›' });
  });
});

describe('quick review state', () => {
  it('keeps the current card and returns a Chinese error when review fails', async () => {
    const result = await resolveQuickReviewDecision(2, async () => {
      throw new Error('服务暂不可用');
    });

    expect(result).toEqual({ index: 2, error: '审核失败：服务暂不可用' });
  });

  it('advances only after review succeeds', async () => {
    let completed = false;
    const result = await resolveQuickReviewDecision(2, async () => { completed = true; });

    expect(completed).toBe(true);
    expect(result).toEqual({ index: 3, error: '' });
  });
});

describe('batch review progress', () => {
  it('reports per-item progress and keeps processing after an item fails', async () => {
    const snapshots: Array<{ processed: number; succeeded: number; failed: number }> = [];
    const items = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];

    const result = await runBatchWithProgress(
      items,
      async (item) => { if (item.id === 'two') throw new Error('第二项失败'); },
      (progress) => snapshots.push({
        processed: progress.processed,
        succeeded: progress.successes.length,
        failed: progress.failures.length,
      }),
    );

    expect(snapshots).toEqual([
      { processed: 0, succeeded: 0, failed: 0 },
      { processed: 1, succeeded: 1, failed: 0 },
      { processed: 2, succeeded: 1, failed: 1 },
      { processed: 3, succeeded: 2, failed: 1 },
    ]);
    expect(result.successes.map((item) => item.id)).toEqual(['one', 'three']);
    expect(result.failures).toEqual([{ item: { id: 'two' }, error: '第二项失败' }]);
  });

  it('removes successful selections and leaves failed items selected for retry', () => {
    const selected = new Set(['proposal:one', 'rel:two']);

    expect([...removeSuccessfulSelections(selected, [{ kind: 'proposal', id: 'one' }])]).toEqual(['rel:two']);
  });
});
