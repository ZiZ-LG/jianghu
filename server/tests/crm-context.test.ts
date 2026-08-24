import { randomUUID } from 'node:crypto';
import { CrmContextSnapshotSchema } from '@jianghu/domain-contracts';
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function addUser(context: TestContext, input: {
  label: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
}) {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id,
    email: `${input.label}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name: input.label,
    role: input.role,
  } });
  const token = context.app.jwt.sign({
    tenantId: context.tenant.id,
    userId: user.id,
    // Deliberately forged: authenticate + EffectiveResourceScope must reload the database role.
    role: 'owner',
  });
  return { user, token };
}

describe('SAAS-105 generic CRM context read model', () => {
  it('serves a strict no-store crm.core snapshot only to authenticated users', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const unauthenticated = await context.app.inject({ method: 'GET', url: '/api/crm/context' });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toEqual({ error: 'unauthorized' });

      const response = await context.app.inject({
        method: 'GET', url: '/api/crm/context', headers: auth(context.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(CrmContextSnapshotSchema.parse(response.json())).toEqual({
        generatedAtUtc: expect.stringMatching(/Z$/),
        customers: [],
        matters: [],
        people: [],
        matterParticipants: [],
        relations: [],
      });
    } finally {
      await context.cleanup();
    }
  });

  it('projects general, sales, and unknown kinds without reading sales or methodology fields', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const tenantId = context.tenant.id;
      const customerId = 'crm-context-customer';
      await context.prisma.account.create({ data: {
        id: customerId,
        tenantId,
        name: '远山制造',
        categoryKey: 'strategic_partner',
        customerType: 4,
        primaryOwnerUserId: context.owner.id,
        profile: JSON.stringify({ hidden: 'PROFILE_SHOULD_NOT_BE_READ' }),
      } });
      await context.prisma.opportunity.createMany({ data: [{
        id: 'crm-context-general', tenantId, accountId: customerId,
        name: '联合研究', kind: 'general', lifecycleStatus: 'active',
        customerType: 1, pipelineStage: 'PIPELINE_SECRET_GENERAL', engageStage: 'ENGAGE_SECRET_GENERAL',
        primaryOwnerUserId: context.owner.id, primaryDPersonId: null,
      }, {
        id: 'crm-context-sales', tenantId, accountId: customerId,
        name: '设备采购', kind: 'sales_opportunity', lifecycleStatus: 'active', priority: 'important',
        customerType: 2, pipelineStage: 'PIPELINE_SECRET_SALES', engageStage: 'ENGAGE_SECRET_SALES',
        primaryOwnerUserId: context.owner.id, primaryDPersonId: 'crm-context-person-1',
      }, {
        id: 'crm-context-unknown', tenantId, accountId: customerId,
        name: '生态共建', kind: 'ecosystem_cocreation', lifecycleStatus: 'paused',
        customerType: 3, pipelineStage: 'PIPELINE_SECRET_UNKNOWN', engageStage: 'ENGAGE_SECRET_UNKNOWN',
        primaryOwnerUserId: context.owner.id,
      }] });
      await context.prisma.person.createMany({ data: [{
        id: 'crm-context-person-1', tenantId, accountId: customerId, name: '李总', title: '负责人',
      }, {
        id: 'crm-context-person-2', tenantId, accountId: customerId, name: '王经理', title: '',
      }] });
      await context.prisma.matterParticipant.create({ data: {
        id: 'crm-context-participant', tenantId, accountId: customerId,
        opportunityId: 'crm-context-general', personId: 'crm-context-person-1',
      } });
      await context.prisma.edge.createMany({ data: [{
        id: 'crm-context-customer-relation', tenantId, accountId: customerId,
        source: 'crm-context-person-1', target: 'crm-context-person-2',
        kind: 'trusted_advisor', layer: 'L4', label: '可信顾问', directed: true,
      }, {
        id: 'crm-context-matter-relation', tenantId, accountId: customerId,
        opportunityId: 'crm-context-sales', source: 'crm-context-person-2', target: 'crm-context-person-1',
        kind: 'unknown_open_relation', layer: 'L2', label: '', directed: false,
      }] });

      const response = await context.app.inject({
        method: 'GET', url: '/api/crm/context', headers: auth(context.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const snapshot = CrmContextSnapshotSchema.parse(response.json());
      expect(snapshot.customers).toEqual([expect.objectContaining({
        id: customerId, categoryKey: 'strategic_partner', primaryOwnerUserId: context.owner.id,
      })]);
      expect(snapshot.matters.map((matter) => matter.kind)).toEqual([
        'general', 'sales_opportunity', 'ecosystem_cocreation',
      ]);
      expect(snapshot.relations).toEqual([
        expect.objectContaining({ id: 'crm-context-customer-relation', kind: 'trusted_advisor', matterId: null }),
        expect.objectContaining({ id: 'crm-context-matter-relation', kind: 'unknown_open_relation', matterId: 'crm-context-sales', label: null }),
      ]);
      expect(snapshot.people.find((person) => person.id === 'crm-context-person-2')?.title).toBeNull();

      const json = JSON.stringify(response.json());
      for (const forbidden of [
        'customerType', 'pipelineStage', 'engageStage', 'primaryDPersonId', 'roles',
        'layer', 'PROFILE_SHOULD_NOT_BE_READ', 'PIPELINE_SECRET', 'ENGAGE_SECRET', 'G64111', 'PDE',
      ]) expect(json).not.toContain(forbidden);
    } finally {
      await context.cleanup();
    }
  });

  it('returns only the visible Matter subtree for a container-only Customer and reloads live scope', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const tenantId = context.tenant.id;
      const matterOwner = await addUser(context, { label: 'matter-owner', role: 'member' });
      const customerOwner = await addUser(context, { label: 'customer-owner', role: 'member' });
      await context.prisma.tenant.update({
        where: { id: tenantId }, data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.account.create({ data: {
        id: 'crm-scope-customer', tenantId, name: '共享客户标题', categoryKey: 'partner',
        customerType: 2, primaryOwnerUserId: customerOwner.user.id,
      } });
      await context.prisma.opportunity.createMany({ data: [{
        id: 'crm-scope-visible-matter', tenantId, accountId: 'crm-scope-customer',
        name: '可见事项', kind: 'general', customerType: 2, pipelineStage: 'visible', engageStage: 'visible',
        primaryOwnerUserId: matterOwner.user.id,
      }, {
        id: 'crm-scope-hidden-matter', tenantId, accountId: 'crm-scope-customer',
        name: 'HIDDEN_SIBLING_MATTER', kind: 'secret_kind', customerType: 2,
        pipelineStage: 'hidden', engageStage: 'hidden', primaryOwnerUserId: customerOwner.user.id,
      }] });
      await context.prisma.person.createMany({ data: [{
        id: 'crm-scope-visible-person', tenantId, accountId: 'crm-scope-customer',
        name: '可见参与人', title: '参与人',
      }, {
        id: 'crm-scope-visible-endpoint', tenantId, accountId: 'crm-scope-customer',
        name: '可见关系端点', title: '协作人',
      }, {
        id: 'crm-scope-hidden-person', tenantId, accountId: 'crm-scope-customer',
        name: 'HIDDEN_SIBLING_PERSON', title: 'Hidden',
      }, {
        id: 'crm-scope-customer-person-a', tenantId, accountId: 'crm-scope-customer',
        name: 'CUSTOMER_LEVEL_PERSON_A', title: 'Hidden',
      }, {
        id: 'crm-scope-customer-person-b', tenantId, accountId: 'crm-scope-customer',
        name: 'CUSTOMER_LEVEL_PERSON_B', title: 'Hidden',
      }] });
      await context.prisma.matterParticipant.createMany({ data: [{
        id: 'crm-scope-visible-participant', tenantId, accountId: 'crm-scope-customer',
        opportunityId: 'crm-scope-visible-matter', personId: 'crm-scope-visible-person',
      }, {
        id: 'crm-scope-hidden-participant', tenantId, accountId: 'crm-scope-customer',
        opportunityId: 'crm-scope-hidden-matter', personId: 'crm-scope-hidden-person',
      }] });
      await context.prisma.edge.createMany({ data: [{
        id: 'crm-scope-visible-relation', tenantId, accountId: 'crm-scope-customer',
        opportunityId: 'crm-scope-visible-matter', source: 'crm-scope-visible-person',
        target: 'crm-scope-visible-endpoint', kind: 'collaborates_with', layer: 'L3', label: '协作',
      }, {
        id: 'crm-scope-hidden-relation', tenantId, accountId: 'crm-scope-customer',
        opportunityId: 'crm-scope-hidden-matter', source: 'crm-scope-hidden-person',
        target: 'crm-scope-visible-person', kind: 'hidden_kind', layer: 'L4', label: 'HIDDEN_SIBLING_RELATION',
      }, {
        id: 'crm-scope-customer-relation', tenantId, accountId: 'crm-scope-customer',
        source: 'crm-scope-customer-person-a', target: 'crm-scope-customer-person-b',
        kind: 'customer_secret', layer: 'L1', label: 'CUSTOMER_LEVEL_RELATION',
      }] });

      const response = await context.app.inject({
        method: 'GET', url: '/api/crm/context', headers: auth(matterOwner.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const snapshot = CrmContextSnapshotSchema.parse(response.json());
      expect(snapshot.customers).toEqual([expect.objectContaining({
        id: 'crm-scope-customer', name: '共享客户标题', categoryKey: 'partner', primaryOwnerUserId: null,
      })]);
      expect(snapshot.matters.map((matter) => matter.id)).toEqual(['crm-scope-visible-matter']);
      expect(snapshot.people.map((person) => person.id).sort()).toEqual([
        'crm-scope-visible-endpoint', 'crm-scope-visible-person',
      ]);
      expect(snapshot.matterParticipants.map((participant) => participant.id)).toEqual(['crm-scope-visible-participant']);
      expect(snapshot.relations.map((relation) => relation.id)).toEqual(['crm-scope-visible-relation']);
      for (const secret of [
        'HIDDEN_SIBLING_MATTER', 'HIDDEN_SIBLING_PERSON', 'HIDDEN_SIBLING_RELATION',
        'CUSTOMER_LEVEL_PERSON_A', 'CUSTOMER_LEVEL_PERSON_B', 'CUSTOMER_LEVEL_RELATION',
      ]) expect(response.body).not.toContain(secret);

      await context.prisma.opportunity.update({
        where: { id: 'crm-scope-visible-matter' }, data: { primaryOwnerUserId: customerOwner.user.id },
      });
      const revoked = await context.app.inject({
        method: 'GET', url: '/api/crm/context', headers: auth(matterOwner.token),
      });
      expect(CrmContextSnapshotSchema.parse(revoked.json())).toMatchObject({
        customers: [], matters: [], people: [], matterParticipants: [], relations: [],
      });
    } finally {
      await context.cleanup();
    }
  });

  it('allows a current viewer to read only their owned Customer and drops malformed relation parentage', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const tenantId = context.tenant.id;
      const viewer = await addUser(context, { label: 'viewer', role: 'viewer' });
      await context.prisma.tenant.update({
        where: { id: tenantId }, data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.account.createMany({ data: [{
        id: 'crm-viewer-customer', tenantId, name: 'Viewer 客户', primaryOwnerUserId: viewer.user.id,
      }, {
        id: 'crm-other-customer', tenantId, name: '其他客户', primaryOwnerUserId: context.owner.id,
      }] });
      await context.prisma.opportunity.createMany({ data: [{
        id: 'crm-viewer-matter', tenantId, accountId: 'crm-viewer-customer', name: 'Viewer 事项',
        kind: 'general', customerType: 1, pipelineStage: 'hidden-adapter', engageStage: 'hidden-adapter',
      }, {
        id: 'crm-other-matter', tenantId, accountId: 'crm-other-customer', name: '其他事项',
        kind: 'general', customerType: 1, pipelineStage: 'hidden-adapter', engageStage: 'hidden-adapter',
      }] });
      await context.prisma.person.createMany({ data: [{
        id: 'crm-viewer-person-a', tenantId, accountId: 'crm-viewer-customer', name: '甲', title: 'A',
      }, {
        id: 'crm-viewer-person-b', tenantId, accountId: 'crm-viewer-customer', name: '乙', title: 'B',
      }, {
        id: 'crm-other-person', tenantId, accountId: 'crm-other-customer', name: '其他人', title: 'C',
      }, {
        id: 'crm-archived-person', tenantId, accountId: 'crm-viewer-customer', name: '已归档', title: 'D',
        archivedAt: new Date('2026-08-01T00:00:00Z'),
      }] });
      await context.prisma.edge.createMany({ data: [{
        id: 'crm-valid-relation', tenantId, accountId: 'crm-viewer-customer',
        source: 'crm-viewer-person-a', target: 'crm-viewer-person-b', kind: 'related', layer: 'L1', label: '认识',
      }, {
        id: 'crm-dangling-relation', tenantId, accountId: 'crm-viewer-customer',
        source: 'crm-viewer-person-a', target: 'missing-person', kind: 'dangling', layer: 'L1', label: 'DANGLING_SECRET',
      }, {
        id: 'crm-cross-customer-relation', tenantId, accountId: 'crm-viewer-customer',
        source: 'crm-viewer-person-a', target: 'crm-other-person', kind: 'cross_customer', layer: 'L1', label: 'CROSS_CUSTOMER_SECRET',
      }, {
        id: 'crm-archived-endpoint-relation', tenantId, accountId: 'crm-viewer-customer',
        source: 'crm-viewer-person-a', target: 'crm-archived-person', kind: 'archived_endpoint', layer: 'L1', label: 'ARCHIVED_ENDPOINT_SECRET',
      }, {
        id: 'crm-foreign-tenant-relation', tenantId: 'foreign-tenant', accountId: 'crm-viewer-customer',
        source: 'crm-viewer-person-a', target: 'crm-viewer-person-b', kind: 'foreign_tenant', layer: 'L1', label: 'FOREIGN_TENANT_SECRET',
      }] });

      const response = await context.app.inject({
        method: 'GET', url: '/api/crm/context', headers: auth(viewer.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const snapshot = CrmContextSnapshotSchema.parse(response.json());
      expect(snapshot.customers.map((customer) => customer.id)).toEqual(['crm-viewer-customer']);
      expect(snapshot.matters.map((matter) => matter.id)).toEqual(['crm-viewer-matter']);
      expect(snapshot.people.map((person) => person.id).sort()).toEqual([
        'crm-viewer-person-a', 'crm-viewer-person-b',
      ]);
      expect(snapshot.relations.map((relation) => relation.id)).toEqual(['crm-valid-relation']);
      for (const secret of [
        'DANGLING_SECRET', 'CROSS_CUSTOMER_SECRET', 'ARCHIVED_ENDPOINT_SECRET',
        'FOREIGN_TENANT_SECRET', '其他客户', '其他事项', '其他人',
      ]) {
        expect(response.body).not.toContain(secret);
      }
    } finally {
      await context.cleanup();
    }
  });
});
