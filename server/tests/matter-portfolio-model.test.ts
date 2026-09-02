import { describe, expect, it } from 'vitest';
import type { InterventionItem } from '@jianghu/domain-contracts';
import {
  buildMatterPortfolio,
  type MatterPortfolioMatterFacts,
} from '../src/matterPortfolio/model.js';

const generatedAtUtc = '2026-09-02T06:00:00Z';

function anchor(index: number, priority: string | null = null): MatterPortfolioMatterFacts {
  const customerId = `customer-${index}`;
  const matterId = `matter-${index}`;
  return {
    customer: {
      id: customerId,
      name: `客户 ${index}`,
      categoryKey: null,
      primaryOwnerUserId: 'user-1',
      archivedAt: null,
      version: 1,
    },
    matter: {
      id: matterId,
      customerId,
      title: `事项 ${index}`,
      kind: 'customer_success',
      lifecycleStatus: 'active' as const,
      outcomeKey: null,
      priority,
      targetDate: null,
      primaryOwnerUserId: 'user-1',
      archivedAt: null,
      version: 2,
    },
    methodologyStage: null,
    salesEstimate: null,
    latestIntelligence: null,
    focusPersonId: null,
    hypotheses: [],
    interventions: [] as unknown[],
  };
}

function item(
  index: number,
  overrides: Partial<InterventionItem> = {},
): InterventionItem {
  const customerId = `customer-${index}`;
  const matterId = `matter-${index}`;
  return {
    id: `item-${index}`,
    section: 'follow_up',
    providerKey: 'core.today',
    title: '补一个下一步',
    context: { customerName: `客户 ${index}`, matterName: `事项 ${index}` },
    reasonCode: 'matter_without_next_commitment',
    explanation: '当前事项没有待执行的下一步承诺。',
    sourceRefs: [{ entityKind: 'matter', entityId: matterId, version: 2, scheduleVersion: null }],
    observedAtUtc: generatedAtUtc,
    ruleVersion: 'core.today.v1',
    time: { kind: 'observed', atUtc: generatedAtUtc, relation: 'missing', label: '缺少下一步' },
    suggestedAction: { kind: 'create_commitment', label: '补一个下一步', commandType: 'CREATE_COMMITMENT' },
    target: {
      entityKind: 'matter',
      entityId: matterId,
      customerId,
      matterId,
      commitmentId: null,
      version: 2,
      scheduleVersion: null,
    },
    ...overrides,
  };
}

describe('SAAS-209 Matter portfolio deterministic model', () => {
  it('orders all seven visible attention buckets without a hidden score', () => {
    const urgent = anchor(1);
    urgent.interventions = [item(1, {
      id: 'urgent-item',
      reasonCode: 'commitment_due',
      time: {
        kind: 'instant',
        atUtc: '2026-09-01T06:00:00Z',
        timeZone: 'Asia/Shanghai',
        relation: 'overdue',
        label: '已逾期',
      },
    })];
    const nextStep = anchor(2);
    nextStep.interventions = [item(2)];
    const relationship = anchor(3);
    relationship.interventions = [item(3, {
      providerKey: 'relationship_radar',
      reasonCode: 'role_coverage.gap',
      title: '补充正式参与人',
      suggestedAction: { kind: 'review_participants', label: '补充正式参与人', commandType: null },
    })];
    const intelligence = anchor(4);
    intelligence.latestIntelligence = {
      id: 'intel-4', version: 3, learnedAtUtc: '2026-08-02T05:59:59Z',
    };
    const hypothesis = anchor(5);
    hypothesis.hypotheses = [{
      id: 'hypothesis-5', version: 4, status: 'testing', personId: null,
      nextReviewAtUtc: '2026-09-07T06:00:00Z',
    }];
    const manual = anchor(6, 'high');
    const clear = anchor(7);

    const result = buildMatterPortfolio({
      generatedAtUtc,
      canPrepareActionDrafts: true,
      matters: [clear, hypothesis, relationship, manual, urgent, intelligence, nextStep],
    });

    expect(result.entries.map((entry) => entry.attentionBucket)).toEqual([
      'urgent', 'next_step', 'relationship', 'intelligence', 'hypothesis', 'manual', 'clear',
    ]);
    expect(result.entries.map((entry) => entry.matter.id)).toEqual([
      'matter-1', 'matter-2', 'matter-3', 'matter-4', 'matter-5', 'matter-6', 'matter-7',
    ]);
    expect(result).not.toHaveProperty('aggregateScore');
    expect(result.entries.every((entry) => !('score' in entry))).toBe(true);
  });

  it('puts overdue and pending-confirmation items before a next-step gap', () => {
    const facts = anchor(1);
    facts.interventions = [
      item(1, { id: 'next-step' }),
      item(1, {
        id: 'pending',
        section: 'pending_confirmation',
        reasonCode: 'confirmation_due',
        time: {
          kind: 'instant',
          atUtc: '2026-09-03T06:00:00Z',
          timeZone: 'Asia/Shanghai',
          relation: 'upcoming',
          label: '明天待确认',
        },
      }),
    ];

    const [entry] = buildMatterPortfolio({ generatedAtUtc, canPrepareActionDrafts: true, matters: [facts] }).entries;
    expect(entry!.attentionBucket).toBe('urgent');
    expect(entry!.attentionItems.map((value) => value.id)).toEqual(['pending', 'next-step']);
    expect(entry!.actionDraft).toMatchObject({ state: 'uncommitted', sourceItemId: 'pending' });
  });

  it('treats missing Intelligence as unknown and applies a strict older-than-30-day boundary', () => {
    const missing = anchor(1);
    const exactBoundary = anchor(2);
    exactBoundary.latestIntelligence = {
      id: 'intel-boundary', version: 1, learnedAtUtc: '2026-08-03T06:00:00Z',
    };
    const stale = anchor(3);
    stale.latestIntelligence = {
      id: 'intel-stale', version: 2, learnedAtUtc: '2026-08-03T05:59:59Z',
    };

    const result = buildMatterPortfolio({
      generatedAtUtc,
      canPrepareActionDrafts: true,
      matters: [stale, exactBoundary, missing],
    });
    const byId = new Map(result.entries.map((entry) => [entry.matter.id, entry]));
    expect(byId.get('matter-1')!.attentionBucket).toBe('clear');
    expect(byId.get('matter-2')!.attentionBucket).toBe('clear');
    expect(byId.get('matter-3')!.attentionBucket).toBe('intelligence');
    expect(byId.get('matter-3')!.attentionItems[0]).toMatchObject({
      providerKey: 'matter_portfolio.intelligence',
      reasonCode: 'intelligence_freshness.stale',
    });
  });

  it('promotes only current unverified Matter-level or Focus-person hypotheses due within seven days', () => {
    const facts = anchor(1);
    facts.focusPersonId = 'person-focus';
    facts.hypotheses = [
      { id: 'matter-level', version: 1, status: 'untested', personId: null, nextReviewAtUtc: '2026-09-09T06:00:00Z' },
      { id: 'focus-person', version: 2, status: 'testing', personId: 'person-focus', nextReviewAtUtc: '2026-09-03T06:00:00Z' },
      { id: 'other-person', version: 3, status: 'testing', personId: 'person-other', nextReviewAtUtc: '2026-09-03T06:00:00Z' },
      { id: 'supported', version: 4, status: 'supported', personId: null, nextReviewAtUtc: '2026-09-03T06:00:00Z' },
      { id: 'too-late', version: 5, status: 'untested', personId: null, nextReviewAtUtc: '2026-09-09T06:00:01Z' },
    ];

    const [entry] = buildMatterPortfolio({ generatedAtUtc, canPrepareActionDrafts: true, matters: [facts] }).entries;
    expect(entry!.attentionBucket).toBe('hypothesis');
    expect(entry!.attentionItems.map((value) => value.sourceRefs[1]?.entityId)).toEqual([
      'focus-person', 'matter-level',
    ]);
  });

  it('deduplicates equivalent next-step gaps and drops malformed or cross-parent interventions', () => {
    const facts = anchor(1);
    facts.interventions = [
      item(1, { id: 'core-gap' }),
      item(1, {
        id: 'radar-gap',
        providerKey: 'relationship_radar',
        reasonCode: 'next_step_completeness.gap',
      }),
      item(1, {
        id: 'cross-parent',
        target: {
          ...item(1).target,
          customerId: 'customer-elsewhere',
        },
      }),
      { unexpected: true },
    ];

    const [entry] = buildMatterPortfolio({ generatedAtUtc, canPrepareActionDrafts: true, matters: [facts] }).entries;
    expect(entry!.attentionItems.map((value) => value.id)).toEqual(['core-gap']);
  });

  it('keeps a sixth Matter and orders known manual priorities before unknown open keys', () => {
    const result = buildMatterPortfolio({
      generatedAtUtc,
      canPrepareActionDrafts: true,
      matters: [
        anchor(6, null),
        anchor(5, 'bespoke'),
        anchor(4, 'low'),
        anchor(3, 'normal'),
        anchor(2, 'medium'),
        anchor(1, 'critical'),
      ],
    });

    expect(result.entries).toHaveLength(6);
    expect(result.entries.map((entry) => entry.matter.id)).toEqual([
      'matter-1', 'matter-2', 'matter-3', 'matter-4', 'matter-5', 'matter-6',
    ]);
    expect(result.entries.map((entry) => entry.attentionBucket)).toEqual([
      'manual', 'manual', 'manual', 'manual', 'clear', 'clear',
    ]);
  });

  it('withholds draft controls for viewers and never propagates poisoned legacy inputs', () => {
    const facts = {
      ...anchor(1),
      interventions: [item(1)],
      primaryDPersonId: 'legacy-person',
      pipelineStage: 'legacy-stage',
      engageStage: 'legacy-engage-stage',
      ADURC: 'legacy-score',
      score: 99,
    };

    const [entry] = buildMatterPortfolio({
      generatedAtUtc,
      canPrepareActionDrafts: false,
      matters: [facts],
    }).entries;
    expect(entry!.actionDraft).toBeNull();
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('legacy-person');
    expect(serialized).not.toContain('legacy-stage');
    expect(serialized).not.toContain('legacy-score');
    expect(entry).not.toHaveProperty('score');
  });
});
