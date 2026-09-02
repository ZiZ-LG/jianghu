import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';

type RuntimeSchema = {
  parse(value: unknown): unknown;
  safeParse(value: unknown): { success: boolean; data?: unknown };
};

const schema = (name: string): RuntimeSchema | undefined => (
  Reflect.get(contracts, name) as RuntimeSchema | undefined
);

const source = {
  kind: 'interaction',
  description: '客户线下会议纪要',
  refId: 'interaction-206',
  refVersion: 3,
};

const intelligenceItem = {
  id: 'intelligence-206',
  customerId: 'customer-206',
  matterId: 'matter-206',
  assertionType: 'reported',
  statement: '采购负责人转述，财务总监关注回款周期',
  source,
  occurredAt: null,
  learnedAt: '2026-08-27T10:00:00.000Z',
  confidence: 0.7,
  targets: [
    { kind: 'matter', id: 'matter-206' },
    { kind: 'person', id: 'person-206' },
  ],
  status: 'active',
  createdByUserId: 'user-206',
  version: 0,
  createdAt: '2026-08-27T10:01:00.000Z',
  updatedAt: '2026-08-27T10:01:00.000Z',
};

const focus = {
  id: 'focus-206',
  customerId: 'customer-206',
  matterId: 'matter-206',
  personId: 'person-206',
  desiredChange: '确认回款周期的内部审批边界',
  rationale: '该人是当前事项的活跃参与者，且能验证关键假设',
  evidenceGap: '缺少财务总监本人的一手确认',
  basisRefs: [{ kind: 'intelligence_item', id: 'intelligence-206', version: 0 }],
  validUntil: '2026-09-10T10:00:00.000Z',
  status: 'active',
  confirmedByUserId: 'user-206',
  confirmedAt: '2026-08-27T10:05:00.000Z',
  retiredByUserId: null,
  retiredAt: null,
  version: 0,
  createdAt: '2026-08-27T10:05:00.000Z',
  updatedAt: '2026-08-27T10:05:00.000Z',
};

describe('SAAS-206 IntelligenceItem contracts', () => {
  it('exports the standalone schemas without extending the legacy Action contract', () => {
    for (const name of [
      'IntelligenceAssertionTypeSchema',
      'IntelligenceSourceSchema',
      'IntelligenceTargetRefSchema',
      'IntelligenceItemViewSchema',
      'IntelligenceItemCommandSchema',
      'IntelligenceItemCommandReceiptSchema',
      'IntelligenceItemListQuerySchema',
      'IntelligenceItemListResponseSchema',
      'IntelligenceItemDetailResponseSchema',
    ]) {
      expect(schema(name), `${name} must be exported`).toBeDefined();
    }
  });

  it('defaults a human capture to reported/manual and preserves explicit provenance', () => {
    const command = schema('IntelligenceItemCommandSchema')!;
    const parsed = command.parse({
      type: 'CREATE_INTELLIGENCE_ITEM',
      item: {
        id: 'intelligence-206',
        customerId: 'customer-206',
        matterId: 'matter-206',
        statement: '客户转述了一个尚未核实的内部判断',
        source: { description: '销售人员当面转述' },
        learnedAt: '2026-08-27T10:00:00.000Z',
        confidence: 0.5,
        targets: [{ kind: 'matter', id: 'matter-206' }],
      },
    }) as { item: { assertionType: string; source: { kind: string; refId: null; refVersion: null }; occurredAt: null } };

    expect(parsed.item.assertionType).toBe('reported');
    expect(parsed.item.source).toMatchObject({ kind: 'manual', refId: null, refVersion: null });
    expect(parsed.item.occurredAt).toBeNull();

    expect(command.safeParse({
      type: 'CREATE_INTELLIGENCE_ITEM',
      item: {
        id: 'intelligence-206', customerId: 'customer-206', matterId: 'matter-206',
        assertionType: 'inferred', statement: '这是一个带来源的人工推断', source,
        learnedAt: '2026-08-27T10:00:00.000+08:00', confidence: 0.25,
        targets: [{ kind: 'person', id: 'person-206' }],
      },
    }).success).toBe(true);
  });

  it('requires coherent observed time and bounded finite confidence', () => {
    const command = schema('IntelligenceItemCommandSchema')!;
    const base = {
      type: 'CREATE_INTELLIGENCE_ITEM',
      item: {
        id: 'intelligence-206', customerId: 'customer-206', matterId: 'matter-206',
        assertionType: 'observed', statement: '直接观察到的行为',
        source: { kind: 'manual', description: '现场观察', refId: null, refVersion: null },
        occurredAt: '2026-08-27T09:00:00.000Z', learnedAt: '2026-08-27T10:00:00.000Z',
        confidence: 1, targets: [{ kind: 'person', id: 'person-206' }],
      },
    };
    expect(command.safeParse(base).success).toBe(true);
    expect(command.safeParse({ ...base, item: { ...base.item, occurredAt: null } }).success).toBe(false);
    expect(command.safeParse({
      ...base,
      item: { ...base.item, occurredAt: '2026-08-27T11:00:00.000Z' },
    }).success).toBe(false);
    expect(command.safeParse({ ...base, item: { ...base.item, confidence: -0.01 } }).success).toBe(false);
    expect(command.safeParse({ ...base, item: { ...base.item, confidence: 1.01 } }).success).toBe(false);
    expect(command.safeParse({ ...base, item: { ...base.item, confidence: Number.NaN } }).success).toBe(false);
    expect(command.safeParse({ ...base, item: { ...base.item, learnedAt: '2026-08-27' } }).success).toBe(false);
  });

  it('requires exact linked-source snapshots and forbids references on manual sources', () => {
    const sourceSchema = schema('IntelligenceSourceSchema')!;
    expect(sourceSchema.safeParse(source).success).toBe(true);
    expect(sourceSchema.safeParse({ ...source, kind: 'evidence', refVersion: 0 }).success).toBe(true);
    expect(sourceSchema.safeParse({ ...source, refId: null }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...source, refVersion: null }).success).toBe(false);
    expect(sourceSchema.safeParse({ ...source, refVersion: -1 }).success).toBe(false);
    expect(sourceSchema.safeParse({
      kind: 'manual', description: '人工记录', refId: 'must-not-link', refVersion: 0,
    }).success).toBe(false);
    expect(sourceSchema.safeParse({
      kind: 'manual', description: '人工记录', refId: null, refVersion: null, rawBody: '禁止',
    }).success).toBe(false);
  });

  it('accepts only bounded unique targets and strict bounded text', () => {
    const command = schema('IntelligenceItemCommandSchema')!;
    const item = {
      id: 'intelligence-206', customerId: 'customer-206', matterId: 'matter-206',
      statement: 'x', source: { description: 'y' },
      learnedAt: '2026-08-27T10:00:00.000Z', confidence: 0,
      targets: [{ kind: 'customer', id: 'customer-206' }],
    };
    expect(command.safeParse({ type: 'CREATE_INTELLIGENCE_ITEM', item }).success).toBe(true);
    expect(command.safeParse({
      type: 'CREATE_INTELLIGENCE_ITEM', item: { ...item, targets: [] },
    }).success).toBe(false);
    expect(command.safeParse({
      type: 'CREATE_INTELLIGENCE_ITEM',
      item: { ...item, targets: [item.targets[0], item.targets[0]] },
    }).success).toBe(false);
    expect(command.safeParse({
      type: 'CREATE_INTELLIGENCE_ITEM',
      item: { ...item, targets: Array.from({ length: 13 }, (_, index) => ({ kind: 'person', id: `person-${index}` })) },
    }).success).toBe(false);
    expect(command.safeParse({
      type: 'CREATE_INTELLIGENCE_ITEM', item: { ...item, statement: 'x'.repeat(2_001) },
    }).success).toBe(false);
    expect(command.safeParse({
      type: 'CREATE_INTELLIGENCE_ITEM',
      item: { ...item, source: { description: 'x'.repeat(1_001) } },
    }).success).toBe(false);
    expect(command.safeParse({
      type: 'CREATE_INTELLIGENCE_ITEM', item: { ...item, unknown: true },
    }).success).toBe(false);
  });

  it('locks the six exact command variants and optimistic concurrency shapes', () => {
    const command = schema('IntelligenceItemCommandSchema')!;
    const update = {
      type: 'UPDATE_INTELLIGENCE_ITEM',
      intelligenceItemId: 'intelligence-206',
      expectedVersion: 0,
      changes: { confidence: 0.8 },
    };
    expect(command.safeParse(update).success).toBe(true);
    expect(command.safeParse({ ...update, changes: {} }).success).toBe(false);
    expect(command.safeParse({ ...update, expectedVersion: -1 }).success).toBe(false);
    expect(command.safeParse({
      type: 'ARCHIVE_INTELLIGENCE_ITEM', intelligenceItemId: 'intelligence-206',
      expectedVersion: 1, reason: '已被后续信息取代',
    }).success).toBe(true);
    expect(command.safeParse({
      type: 'RESTORE_INTELLIGENCE_ITEM', intelligenceItemId: 'intelligence-206', expectedVersion: 2,
    }).success).toBe(true);
    for (const forbiddenType of ['CREATE_EVIDENCE', 'PROMOTE_INTELLIGENCE_TO_EVIDENCE', 'VERIFY_INTELLIGENCE']) {
      expect(command.safeParse({ ...update, type: forbiddenType }).success).toBe(false);
    }
  });

  it('keeps command receipts body-free and strict', () => {
    const receipt = schema('IntelligenceItemCommandReceiptSchema')!;
    const safe = {
      type: 'CREATE_INTELLIGENCE_ITEM',
      intelligenceItemId: 'intelligence-206',
      customerId: 'customer-206',
      matterId: 'matter-206',
      assertionType: 'reported',
      sourceKind: 'manual',
      status: 'active',
      version: 0,
      replayed: false,
      undoable: false,
    };
    expect(receipt.safeParse(safe).success).toBe(true);
    for (const forbidden of ['statement', 'sourceDescription', 'rationale', 'evidenceGap', 'rawBody']) {
      expect(receipt.safeParse({ ...safe, [forbidden]: '不得进入幂等摘要' }).success).toBe(false);
    }
  });

  it('defines strict list/detail projections and bounded cursors', () => {
    const view = schema('IntelligenceItemViewSchema')!;
    const query = schema('IntelligenceItemListQuerySchema')!;
    const list = schema('IntelligenceItemListResponseSchema')!;
    const detail = schema('IntelligenceItemDetailResponseSchema')!;
    expect(view.safeParse(intelligenceItem).success).toBe(true);
    expect(view.safeParse({ ...intelligenceItem, evidenceId: 'must-not-promote' }).success).toBe(false);
    expect(query.safeParse({ customerId: 'customer-206', matterId: 'matter-206' }).success).toBe(true);
    expect(query.safeParse({ customerId: 'customer-206' }).success).toBe(false);
    expect(query.safeParse({ customerId: 'customer-206', matterId: 'matter-206', limit: 51 }).success).toBe(false);
    expect(query.safeParse({ customerId: 'customer-206', matterId: 'matter-206', cursor: 'x'.repeat(201) }).success).toBe(false);
    expect(list.safeParse({ items: [intelligenceItem], nextCursor: null }).success).toBe(true);
    expect(list.safeParse({ items: Array.from({ length: 51 }, () => intelligenceItem), nextCursor: null }).success).toBe(false);
    expect(detail.safeParse({ item: intelligenceItem }).success).toBe(true);
    expect(detail.safeParse({ item: intelligenceItem, tenantId: 'must-not-leak' }).success).toBe(false);
  });
});

describe('SAAS-206 StakeholderFocus contracts', () => {
  it('exports method-neutral focus schemas and never accepts methodology fields', () => {
    for (const name of [
      'StakeholderFocusBasisRefSchema',
      'StakeholderFocusViewSchema',
      'StakeholderFocusCommandSchema',
      'StakeholderFocusCommandReceiptSchema',
      'StakeholderFocusListQuerySchema',
      'StakeholderFocusListResponseSchema',
      'StakeholderFocusDetailResponseSchema',
    ]) {
      expect(schema(name), `${name} must be exported`).toBeDefined();
    }
    const view = schema('StakeholderFocusViewSchema')!;
    expect(view.safeParse(focus).success).toBe(true);
    for (const forbidden of ['primaryDPersonId', 'g64111Role', 'adurc', 'methodologyVersionId']) {
      expect(view.safeParse({ ...focus, [forbidden]: 'forbidden' }).success).toBe(false);
    }
  });

  it('requires a bounded unique basis or an explicit evidence gap', () => {
    const command = schema('StakeholderFocusCommandSchema')!;
    const focusInput = {
      id: 'focus-206', customerId: 'customer-206', matterId: 'matter-206', personId: 'person-206',
      desiredChange: '确认关键利益人的书面承诺', rationale: '该变化能验证当前事项的核心假设',
      evidenceGap: null,
      basisRefs: [{ kind: 'intelligence_item', id: 'intelligence-206', version: 0 }],
      validUntil: '2026-09-10T10:00:00.000Z',
    };
    const set = {
      type: 'SET_STAKEHOLDER_FOCUS', focus: focusInput,
      expectedCurrentFocusId: null, expectedCurrentFocusVersion: null,
    };
    expect(command.safeParse(set).success).toBe(true);
    expect(command.safeParse({
      ...set, focus: { ...focusInput, evidenceGap: '仍需当事人直接确认', basisRefs: [] },
    }).success).toBe(true);
    expect(command.safeParse({
      ...set, focus: { ...focusInput, evidenceGap: null, basisRefs: [] },
    }).success).toBe(false);
    expect(command.safeParse({
      ...set, focus: { ...focusInput, basisRefs: [focusInput.basisRefs[0], focusInput.basisRefs[0]] },
    }).success).toBe(false);
    expect(command.safeParse({
      ...set,
      focus: {
        ...focusInput,
        basisRefs: Array.from({ length: 9 }, (_, index) => ({ kind: 'interaction', id: `interaction-${index}`, version: 0 })),
      },
    }).success).toBe(false);
  });

  it('requires an exact nullable current-focus CAS pair and explicit retirement CAS', () => {
    const command = schema('StakeholderFocusCommandSchema')!;
    const base = {
      type: 'SET_STAKEHOLDER_FOCUS',
      focus: {
        id: 'focus-207', customerId: 'customer-206', matterId: 'matter-206', personId: 'person-206',
        desiredChange: '取得关键人的明确确认', rationale: '当前事项需要一个有限期的人员聚焦',
        evidenceGap: '尚无一手证据', basisRefs: [],
        validUntil: '2026-09-10T10:00:00.000Z',
      },
      expectedCurrentFocusId: 'focus-206', expectedCurrentFocusVersion: 0,
    };
    expect(command.safeParse(base).success).toBe(true);
    expect(command.safeParse({ ...base, expectedCurrentFocusId: null }).success).toBe(false);
    expect(command.safeParse({ ...base, expectedCurrentFocusVersion: null }).success).toBe(false);
    expect(command.safeParse({
      type: 'RETIRE_STAKEHOLDER_FOCUS', stakeholderFocusId: 'focus-206',
      expectedVersion: 0, reason: '聚焦已达成或失效',
    }).success).toBe(true);
    expect(command.safeParse({
      type: 'RETIRE_STAKEHOLDER_FOCUS', stakeholderFocusId: 'focus-206', reason: '缺少版本',
    }).success).toBe(false);
  });

  it('keeps confirmer server-owned, validates chronology, and keeps receipts body-free', () => {
    const command = schema('StakeholderFocusCommandSchema')!;
    const view = schema('StakeholderFocusViewSchema')!;
    const receipt = schema('StakeholderFocusCommandReceiptSchema')!;
    const set = {
      type: 'SET_STAKEHOLDER_FOCUS',
      focus: {
        id: 'focus-206', customerId: 'customer-206', matterId: 'matter-206', personId: 'person-206',
        desiredChange: '确认一个变化', rationale: '有限期聚焦', evidenceGap: '待验证', basisRefs: [],
        validUntil: '2026-09-10T10:00:00.000Z',
      },
      expectedCurrentFocusId: null, expectedCurrentFocusVersion: null,
    };
    expect(command.safeParse({ ...set, confirmedByUserId: 'forged-user' }).success).toBe(false);
    expect(view.safeParse({ ...focus, validUntil: '2026-08-27T10:04:59.000Z' }).success).toBe(false);
    expect(view.safeParse({ ...focus, status: 'retired' }).success).toBe(false);
    expect(view.safeParse({
      ...focus, status: 'retired', retiredByUserId: 'user-206', retiredAt: '2026-08-28T10:00:00.000Z', version: 1,
    }).success).toBe(true);

    const safe = {
      type: 'SET_STAKEHOLDER_FOCUS',
      stakeholderFocusId: 'focus-206', customerId: 'customer-206', matterId: 'matter-206',
      personId: 'person-206', status: 'active', version: 0, replayed: false, undoable: false,
    };
    expect(receipt.safeParse(safe).success).toBe(true);
    for (const forbidden of ['desiredChange', 'rationale', 'evidenceGap', 'statement', 'sourceDescription']) {
      expect(receipt.safeParse({ ...safe, [forbidden]: '不得进入幂等摘要' }).success).toBe(false);
    }
  });

  it('defines strict focus list/detail projections with bounded pagination', () => {
    const query = schema('StakeholderFocusListQuerySchema')!;
    const list = schema('StakeholderFocusListResponseSchema')!;
    const detail = schema('StakeholderFocusDetailResponseSchema')!;
    expect(query.safeParse({ customerId: 'customer-206', matterId: 'matter-206' }).success).toBe(true);
    expect(query.safeParse({ customerId: 'customer-206', matterId: 'matter-206', includeRetired: true, limit: 50 }).success).toBe(true);
    expect(query.safeParse({ customerId: 'customer-206', matterId: 'matter-206', limit: 0 }).success).toBe(false);
    expect(query.safeParse({ customerId: 'customer-206', matterId: 'matter-206', cursor: 'x'.repeat(201) }).success).toBe(false);
    expect(list.safeParse({ items: [focus], nextCursor: null }).success).toBe(true);
    expect(list.safeParse({ items: Array.from({ length: 51 }, () => focus), nextCursor: null }).success).toBe(false);
    expect(detail.safeParse({ item: focus }).success).toBe(true);
    expect(detail.safeParse({ item: focus, primaryDPersonId: 'must-not-exist' }).success).toBe(false);
  });
});
