import { describe, expect, it } from 'vitest';
import { ActionSchema } from '@jianghu/domain-contracts';
import type { Account, Note, Opportunity, PlanAction, VisitNote } from './types';
import { toWireAction } from './wireAction';

describe('toWireAction', () => {
  it('strips account read-model collections before mutation submission', () => {
    const account: Account = {
      id: 'a',
      name: 'Account',
      customerType: 2,
      primaryOwner: 'Owner',
      primaryOwnerUserId: 'user-owner',
      persons: [],
      baseEdges: [],
      opportunities: [],
      visitNotes: [],
      notes: [],
      planActions: [],
      milestones: [],
      oppStages: [],
      strategyCards: [],
      strategyRisks: [],
      strategyResources: [],
    };

    const wire = toWireAction({ type: 'ADD_ACCOUNT', account });

    expect(wire).toEqual({ type: 'ADD_ACCOUNT', account: { id: 'a', name: 'Account', customerType: 2, primaryOwner: 'Owner', primaryOwnerUserId: 'user-owner' } });
    expect(ActionSchema.safeParse(wire).success).toBe(true);
  });

  it('strips nested opportunity state and read-only version fields', () => {
    const opp: Opportunity = {
      id: 'o',
      accountId: 'a',
      name: 'Opportunity',
      customerType: 2,
      pipelineStage: '线索',
      engageStage: '需求调研立项',
      singleSalesGoal: '',
      c3Items: {},
      c5Items: {},
      roles: [],
      bis: [],
      ucvs: [],
      edges: [],
      memberIds: [],
      evidenceEvents: [],
      version: 7,
    };

    const wire = toWireAction({ type: 'ADD_OPP', accId: 'a', opp });

    expect(wire).toEqual({
      type: 'ADD_OPP',
      accId: 'a',
      opp: {
        id: 'o',
        name: 'Opportunity',
        customerType: 2,
        pipelineStage: '线索',
        engageStage: '需求调研立项',
        singleSalesGoal: '',
        c3Items: {},
        c5Items: {},
      },
    });
    expect(ActionSchema.safeParse(wire).success).toBe(true);
  });

  it('removes non-writable fields from patches', () => {
    const patch: Partial<Opportunity> = { name: 'Renamed', roles: [], version: 9 };
    const wire = toWireAction({
      type: 'UPDATE_OPP',
      accId: 'a',
      oppId: 'o',
      patch,
      baseVersion: 8,
    });

    expect(wire).toEqual({
      type: 'UPDATE_OPP',
      accId: 'a',
      oppId: 'o',
      patch: { name: 'Renamed' },
      baseVersion: 8,
    });
  });

  it('preserves an open Relation kind on create and update payloads', () => {
    expect(toWireAction({
      type: 'ADD_EDGE', accId: 'a', oppId: 'o',
      edge: { id: 'e', source: 'p1', target: 'p2', kind: 'trusted_advisor', layer: 'L2', label: '顾问' },
    })).toMatchObject({ edge: { kind: 'trusted_advisor' } });
    expect(toWireAction({
      type: 'UPDATE_EDGE', accId: 'a', oppId: 'o', edgeId: 'e', patch: { kind: 'former_colleague' },
    })).toMatchObject({ patch: { kind: 'former_colleague' } });
  });

  it('strips server-owned createdBy from all create payloads', () => {
    const visit: VisitNote = {
      id: 'v', accountId: 'a', date: '2026-07-12', topic: 'Visit', summary: 'Summary', participants: [], createdBy: 'forged-user',
    };
    const note: Note = { id: 'n', accountId: 'a', content: 'Note', createdBy: 'forged-user' };
    const planAction: PlanAction = {
      id: 'pa', accountId: 'a', opportunityId: 'o', title: 'Plan', startDate: '2026-07-12', endDate: '2026-07-12', half: 'am', done: false, createdBy: 'forged-user',
    };

    expect([
      toWireAction({ type: 'ADD_VISIT', accId: 'a', visit }),
      toWireAction({ type: 'ADD_NOTE', accId: 'a', note }),
      toWireAction({ type: 'ADD_PLAN_ACTION', accId: 'a', oppId: 'o', planAction }),
    ]).toEqual([
      { type: 'ADD_VISIT', accId: 'a', visit: { id: 'v', date: '2026-07-12', topic: 'Visit', summary: 'Summary', participants: [] } },
      { type: 'ADD_NOTE', accId: 'a', note: { id: 'n', content: 'Note' } },
      { type: 'ADD_PLAN_ACTION', accId: 'a', oppId: 'o', planAction: { id: 'pa', title: 'Plan', startDate: '2026-07-12', endDate: '2026-07-12', half: 'am', done: false } },
    ]);
  });

  it('strips server-owned _mcpOrigin from account profile updates', () => {
    const patch: Partial<Account> = {
      profile: {
        business: 'Human verified business',
        _mcpOrigin: { source: 'mcp', at: '2026-07-12T00:00:00.000Z', needsReview: true },
      },
    };

    expect(toWireAction({ type: 'UPDATE_ACCOUNT', accId: 'a', patch })).toEqual({
      type: 'UPDATE_ACCOUNT',
      accId: 'a',
      patch: { profile: { business: 'Human verified business' } },
    });
  });
});
