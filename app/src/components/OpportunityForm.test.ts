import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Opportunity } from '../types';
import * as opportunityFormModule from './OpportunityForm';

const opportunity: Opportunity = {
  id: 'opp-repair',
  accountId: 'acc-repair',
  name: 'Repair opportunity',
  customerType: 2,
  pipelineStage: '客户立项',
  engageStage: '需求调研立项',
  changeMode: 'G',
  singleSalesGoal: 'Win the project',
  customerBusinessGoal: 'Forbidden broad-edit field',
  buyingMotivation: 'Forbidden broad-edit field',
  status: 'active',
  productSolution: 'Forbidden broad-edit field',
  competitor: 'Forbidden broad-edit field',
  competitiveSituation: '胶着',
  winProbability: 55,
  expectedSignDate: '2026-09-01',
  expectedAmountW: 300,
  c3Items: { C3_1: true },
  c5Items: { C5_1: true },
  roles: [],
  bis: [],
  ucvs: [],
  edges: [],
  version: 7,
};

describe('INT-301 OpportunityForm repair boundary', () => {
  it('builds an audited repair patch with only the approved opportunity fields', () => {
    const toOpportunityRepairPatch = (opportunityFormModule as unknown as {
      toOpportunityRepairPatch?: (value: Opportunity, original: Opportunity) => Record<string, unknown>;
    }).toOpportunityRepairPatch;
    expect(typeof toOpportunityRepairPatch).toBe('function');
    expect(toOpportunityRepairPatch!({ ...opportunity, name: 'Corrected opportunity' }, opportunity)).toEqual({
      baseVersion: 7,
      name: 'Corrected opportunity',
    });
  });

  it('renders only fields approved for the internal correction form', () => {
    const html = renderToStaticMarkup(createElement(opportunityFormModule.OpportunityForm, {
      opp: opportunity,
      onSave: vi.fn(),
      onClose: vi.fn(),
    }));
    for (const label of ['商机名称', '商机阶段', '商机状态', '预计金额', '预计签约日', '单一销售目标', '竞争态势']) {
      expect(html).toContain(label);
    }
    for (const forbidden of ['介入阶段', '客户变化模式', '客户业务目标', '购买动机', '赢单概率', '我方产品', '主要友商', 'C3', 'C5']) {
      expect(html).not.toContain(forbidden);
    }
  });

  it('turns a failed correction into an operator-visible message', () => {
    const repairFailureMessage = (opportunityFormModule as unknown as {
      repairFailureMessage?: (cause: unknown) => string;
    }).repairFailureMessage;
    expect(typeof repairFailureMessage).toBe('function');
    expect(repairFailureMessage!(new Error('服务器暂不可用'))).toBe('服务器暂不可用');
    expect(repairFailureMessage!({})).toBe('商机纠错保存失败');
  });

  it('keeps the opening baseline while a dirty draft receives newer cloud props', () => {
    const reconcileOpportunityDraft = (opportunityFormModule as unknown as {
      reconcileOpportunityDraft?: (
        current: Opportunity,
        incoming: Opportunity,
        baseline: Opportunity,
        dirty: boolean,
        openId: string,
      ) => { draft: Opportunity; baseline: Opportunity; dirty: boolean; openId: string };
    }).reconcileOpportunityDraft;
    expect(typeof reconcileOpportunityDraft).toBe('function');
    const dirtyDraft = { ...opportunity, status: 'paused' as const };
    const newerCloud = { ...opportunity, version: 8, expectedSignDate: '2026-10-01' };
    const reconciled = reconcileOpportunityDraft!(dirtyDraft, newerCloud, opportunity, true, opportunity.id);

    expect(reconciled.draft).toBe(dirtyDraft);
    expect(reconciled.baseline).toBe(opportunity);
    expect(opportunityFormModule.toOpportunityRepairPatch(reconciled.draft, reconciled.baseline)).toEqual({
      baseVersion: 7,
      status: 'paused',
    });
  });
});
