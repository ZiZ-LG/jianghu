import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  safeParse(value: unknown): { success: boolean };
};

const runtimeSchema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const pendingItem = {
  id: 'today:confirmation_due:commitment-1:v0:s0',
  section: 'pending_confirmation',
  providerKey: 'core.today',
  title: '周四与客户交流方案',
  context: { customerName: '远山制造', matterName: null },
  reasonCode: 'confirmation_due',
  explanation: '这条下一步仍待确认，确认截止时间已经到达。',
  sourceRefs: [{
    entityKind: 'commitment',
    entityId: 'commitment-1',
    version: 0,
    scheduleVersion: 0,
  }],
  observedAtUtc: '2026-08-23T19:00:00Z',
  ruleVersion: 'core.today.v1',
  time: {
    kind: 'instant',
    atUtc: '2026-08-23T18:00:00Z',
    timeZone: 'Asia/Shanghai',
    relation: 'overdue',
    label: '确认已逾期',
  },
  suggestedAction: {
    kind: 'confirm_commitment',
    label: '确认或调整时间',
    commandType: 'CONFIRM_COMMITMENT',
  },
  target: {
    entityKind: 'commitment',
    entityId: 'commitment-1',
    customerId: 'customer-1',
    matterId: null,
    commitmentId: 'commitment-1',
    version: 0,
    scheduleVersion: 0,
  },
};

const readModel = {
  generatedAtUtc: '2026-08-23T19:00:00Z',
  sections: [
    { key: 'pending_confirmation', label: '待确认', items: [pendingItem] },
    { key: 'follow_up', label: '待跟进', items: [] },
    { key: 'completed', label: '已完成', items: [] },
  ],
};

describe('SAAS-103 intervention contract', () => {
  it('publishes one strict item schema inside the fixed three-section Today envelope', () => {
    const itemSchema = runtimeSchema('InterventionItemSchema');
    const todaySchema = runtimeSchema('TodayReadModelSchema');
    const sourceViewSchema = runtimeSchema('TodaySourceViewSchema');

    expect(itemSchema, 'InterventionItemSchema must be exported').toBeDefined();
    expect(todaySchema, 'TodayReadModelSchema must be exported').toBeDefined();
    expect(sourceViewSchema, 'TodaySourceViewSchema must be exported').toBeDefined();
    expect(itemSchema!.safeParse(pendingItem).success).toBe(true);
    expect(todaySchema!.safeParse(readModel).success).toBe(true);

    const wrongOrder = {
      ...readModel,
      sections: [readModel.sections[1], readModel.sections[0], readModel.sections[2]],
    };
    expect(todaySchema!.safeParse(wrongOrder).success).toBe(false);

    expect(sourceViewSchema!.safeParse({
      sourceRef: pendingItem.sourceRefs[0],
      customerId: 'customer-1',
      matterId: null,
      label: '周四与客户交流方案',
      detail: '计划中 · 待确认',
    }).success).toBe(true);
  });

  it('binds a suggested command to the same revisioned target exposed in sourceRefs', () => {
    const itemSchema = runtimeSchema('InterventionItemSchema');
    expect(itemSchema).toBeDefined();

    expect(itemSchema!.safeParse({
      ...pendingItem,
      sourceRefs: [{
        entityKind: 'commitment',
        entityId: 'another-commitment',
        version: 0,
        scheduleVersion: 0,
      }],
    }).success).toBe(false);

    expect(itemSchema!.safeParse({
      ...pendingItem,
      target: {
        entityKind: 'matter',
        entityId: 'matter-1',
        customerId: 'customer-1',
        matterId: 'matter-1',
        commitmentId: null,
        version: 0,
        scheduleVersion: null,
      },
    }).success).toBe(false);

    expect(itemSchema!.safeParse({
      ...pendingItem,
      suggestedAction: {
        kind: 'create_commitment',
        label: '补一个下一步',
        commandType: 'CREATE_COMMITMENT',
      },
    }).success).toBe(false);
  });

  it('does not silently cap a Today section without a pagination contract', () => {
    const todaySchema = runtimeSchema('TodayReadModelSchema');
    expect(todaySchema).toBeDefined();

    const items = Array.from({ length: 201 }, (_, index) => ({
      ...pendingItem,
      id: `today:confirmation_due:commitment-${index}:v0:s0`,
      sourceRefs: [{
        entityKind: 'commitment',
        entityId: `commitment-${index}`,
        version: 0,
        scheduleVersion: 0,
      }],
      target: {
        ...pendingItem.target,
        entityId: `commitment-${index}`,
        commitmentId: `commitment-${index}`,
      },
    }));

    expect(todaySchema!.safeParse({
      ...readModel,
      sections: [
        { key: 'pending_confirmation', label: '待确认', items },
        readModel.sections[1],
        readModel.sections[2],
      ],
    }).success).toBe(true);
  });

  it('rejects duplicate intervention identities across sections', () => {
    const todaySchema = runtimeSchema('TodayReadModelSchema');
    expect(todaySchema).toBeDefined();

    expect(todaySchema!.safeParse({
      ...readModel,
      sections: [
        readModel.sections[0],
        {
          key: 'follow_up',
          label: '待跟进',
          items: [{ ...pendingItem, section: 'follow_up' }],
        },
        readModel.sections[2],
      ],
    }).success).toBe(false);
  });

  it('keeps source entity identities compatible with existing CRM ids without unbounding intervention ids', () => {
    const itemSchema = runtimeSchema('InterventionItemSchema');
    expect(itemSchema).toBeDefined();
    const legacyEntityId = `legacy-${'x'.repeat(300)}`;

    expect(itemSchema!.safeParse({
      ...pendingItem,
      sourceRefs: [{
        entityKind: 'commitment',
        entityId: legacyEntityId,
        version: 0,
        scheduleVersion: 0,
      }],
      target: {
        ...pendingItem.target,
        entityId: legacyEntityId,
        commitmentId: legacyEntityId,
      },
    }).success).toBe(true);

    expect(itemSchema!.safeParse({
      ...pendingItem,
      id: 'x'.repeat(241),
    }).success).toBe(false);
  });
});
