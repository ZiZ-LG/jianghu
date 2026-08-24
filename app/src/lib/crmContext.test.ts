import type { CrmContextSnapshot } from '@jianghu/domain-contracts';
import { describe, expect, it } from 'vitest';
import {
  customerCategoryLabel,
  matterKindLabel,
  matterLifecycleLabel,
  relationKindLabel,
  selectCustomerContext,
  selectMatterContext,
  toQuickCaptureAccounts,
} from './crmContext';

const SNAPSHOT = {
  generatedAtUtc: '2026-08-23T23:50:00Z',
  customers: [{
    id: 'customer-1', name: '通用客户', categoryKey: 'strategic_partner',
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
  }, {
    id: 'customer-2', name: '另一客户', categoryKey: null,
    primaryOwnerUserId: null, archivedAt: null, version: 0,
  }],
  matters: [{
    id: 'matter-general', customerId: 'customer-1', title: '联合研究', kind: 'general',
    lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: null,
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
  }, {
    id: 'matter-sales', customerId: 'customer-1', title: '设备采购', kind: 'sales_opportunity',
    lifecycleStatus: 'paused', outcomeKey: null, priority: 'important', targetDate: '2026-10-01',
    primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
  }, {
    id: 'matter-unknown', customerId: 'customer-2', title: '生态共建', kind: 'ecosystem_cocreation',
    lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: null,
    primaryOwnerUserId: null, archivedAt: null, version: 0,
  }],
  people: [{
    id: 'person-1', customerId: 'customer-1', name: '李总', title: '负责人', archivedAt: null, version: 0,
  }, {
    id: 'person-2', customerId: 'customer-1', name: '王经理', title: null, archivedAt: null, version: 0,
  }, {
    id: 'person-3', customerId: 'customer-1', name: '陈顾问', title: '顾问', archivedAt: null, version: 0,
  }, {
    id: 'person-4', customerId: 'customer-2', name: '赵老师', title: null, archivedAt: null, version: 0,
  }],
  matterParticipants: [{
    id: 'participant-1', customerId: 'customer-1', matterId: 'matter-general', personId: 'person-1',
  }],
  relations: [{
    id: 'relation-base', customerId: 'customer-1', matterId: null,
    sourcePersonId: 'person-1', targetPersonId: 'person-2', kind: 'reports_to',
    label: '汇报', directed: true, version: 0,
  }, {
    id: 'relation-matter', customerId: 'customer-1', matterId: 'matter-general',
    sourcePersonId: 'person-2', targetPersonId: 'person-3', kind: 'trusted_advisor',
    label: null, directed: false, version: 0,
  }, {
    id: 'relation-other-matter', customerId: 'customer-1', matterId: 'matter-sales',
    sourcePersonId: 'person-1', targetPersonId: 'person-3', kind: 'unknown_open_relation',
    label: null, directed: false, version: 0,
  }],
} satisfies CrmContextSnapshot;

describe('generic CRM context presentation helpers', () => {
  it('uses neutral known labels and preserves unknown open keys', () => {
    expect(customerCategoryLabel(null)).toBe('未分类');
    expect(customerCategoryLabel('strategic_partner')).toBe('战略合作');
    expect(customerCategoryLabel('custom_category')).toBe('自定义分类 · custom_category');
    expect(matterKindLabel('general')).toBe('通用事项');
    expect(matterKindLabel('sales_opportunity')).toBe('销售事项');
    expect(matterKindLabel('ecosystem_cocreation')).toBe('自定义事项 · ecosystem_cocreation');
    expect(matterLifecycleLabel('active')).toBe('进行中');
    expect(matterLifecycleLabel('paused')).toBe('已暂停');
    expect(relationKindLabel('reports_to')).toBe('汇报关系');
    expect(relationKindLabel('unknown_open_relation')).toBe('自定义关系 · unknown_open_relation');
  });

  it('selects only Customer-level relations for Customer context', () => {
    expect(selectCustomerContext(SNAPSHOT, 'missing-customer')).toBeNull();
    const context = selectCustomerContext(SNAPSHOT, 'customer-1');
    expect(context).not.toBeNull();
    expect(context?.matters.map((matter) => matter.id)).toEqual(['matter-general', 'matter-sales']);
    expect(context?.people.map((person) => person.id)).toEqual(['person-1', 'person-2', 'person-3']);
    expect(context?.relations.map((relation) => relation.id)).toEqual(['relation-base']);
  });

  it('selects participants and both base/Matter relations for one Matter context', () => {
    expect(selectMatterContext(SNAPSHOT, 'missing-matter')).toBeNull();
    const context = selectMatterContext(SNAPSHOT, 'matter-general');
    expect(context).not.toBeNull();
    expect(context?.customer.id).toBe('customer-1');
    expect(context?.participants.map((person) => person.id)).toEqual(['person-1']);
    expect(context?.relations.map((relation) => relation.id)).toEqual(['relation-base', 'relation-matter']);
    expect(context?.people.map((person) => person.id)).toEqual(['person-1', 'person-2', 'person-3']);
    expect(context?.relations.map((relation) => relation.id)).not.toContain('relation-other-matter');
  });

  it('keeps a valid empty relation context without inventing graph data', () => {
    const emptyRelations: CrmContextSnapshot = { ...SNAPSHOT, relations: [] };
    expect(selectCustomerContext(emptyRelations, 'customer-1')?.relations).toEqual([]);
    expect(selectMatterContext(emptyRelations, 'matter-general')?.relations).toEqual([]);
  });

  it('derives Quick Capture choices only from the neutral CRM context contract', () => {
    expect(toQuickCaptureAccounts(SNAPSHOT)).toEqual([
      {
        id: 'customer-1',
        name: '通用客户',
        opportunities: [
          { id: 'matter-general', name: '联合研究' },
          { id: 'matter-sales', name: '设备采购' },
        ],
        persons: [
          { id: 'person-1', name: '李总' },
          { id: 'person-2', name: '王经理' },
          { id: 'person-3', name: '陈顾问' },
        ],
      },
      {
        id: 'customer-2',
        name: '另一客户',
        opportunities: [{ id: 'matter-unknown', name: '生态共建' }],
        persons: [{ id: 'person-4', name: '赵老师' }],
      },
    ]);
  });
});
