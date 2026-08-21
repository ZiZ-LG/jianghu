import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function addMember(context: TestContext, label: string) {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id,
    email: `${label}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name: label,
    role: 'member',
  } });
  const token = context.app.jwt.sign({
    userId: user.id,
    tenantId: context.tenant.id,
    role: 'member',
  });
  return { user, token };
}

function commitmentData(input: {
  id: string;
  tenantId: string;
  accountId: string;
  opportunityId: string | null;
  personId?: string;
  title: string;
  ownerUserId: string;
  localDate: string;
}) {
  return {
    id: input.id,
    tenantId: input.tenantId,
    accountId: input.accountId,
    opportunityId: input.opportunityId,
    personId: input.personId,
    title: input.title,
    ownerId: input.ownerUserId,
    ownerUserId: input.ownerUserId,
    startDate: input.localDate,
    endDate: input.localDate,
    localDate: input.localDate,
    executionStatus: 'planned',
    confirmationStatus: 'not_required',
    timeZone: 'Asia/Shanghai',
    isAllDay: true,
  };
}

describe('CORE-109 scoped state aggregation', () => {
  it('returns only a minimal Customer container plus the directly owned Matter subtree', async () => {
    const context = await createTestContext();
    try {
      const matterOwner = await addMember(context, 'Matter owner');
      const customerOwner = await addMember(context, 'Customer owner');
      const legacyMember = await addMember(context, 'Legacy member');
      const tenantId = context.tenant.id;
      const accountId = 'scope-state-customer';
      const visibleMatterId = 'scope-state-visible-matter';
      const hiddenMatterId = 'scope-state-hidden-matter';
      const visiblePersonId = 'scope-state-visible-person';
      const accountPersonOne = 'scope-state-account-person-one';
      const accountPersonTwo = 'scope-state-account-person-two';
      const hiddenPersonId = 'scope-state-hidden-person';

      await context.prisma.tenant.update({
        where: { id: tenantId },
        data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.account.create({ data: {
        id: accountId,
        tenantId,
        name: 'Shared Customer Header',
        customerType: 2,
        unifiedCreditCode: 'CUSTOMER_LEVEL_CREDIT_SECRET',
        externalRef: 'CUSTOMER_LEVEL_EXTERNAL_SECRET',
        region: 'CUSTOMER_LEVEL_REGION_SECRET',
        group: 'CUSTOMER_LEVEL_GROUP_SECRET',
        primaryOwner: 'CUSTOMER_LEVEL_OWNER_SECRET',
        primaryOwnerUserId: customerOwner.user.id,
        profile: JSON.stringify({ secret: 'CUSTOMER_LEVEL_PROFILE_SECRET' }),
      } });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: visibleMatterId,
          tenantId,
          accountId,
          name: 'VISIBLE_MATTER_A',
          customerType: 2,
          pipelineStage: 'lead',
          engageStage: 'discover',
          primaryOwnerUserId: matterOwner.user.id,
        },
        {
          id: hiddenMatterId,
          tenantId,
          accountId,
          name: 'HIDDEN_SIBLING_MATTER_SECRET',
          customerType: 2,
          pipelineStage: 'secret-stage',
          engageStage: 'secret-engagement',
          primaryOwnerUserId: customerOwner.user.id,
          singleSalesGoal: 'HIDDEN_SIBLING_GOAL_SECRET',
        },
      ] });
      await context.prisma.person.createMany({ data: [
        {
          id: visiblePersonId,
          tenantId,
          accountId,
          name: 'VISIBLE_MATTER_A_PERSON',
          title: 'Visible role',
          logs: JSON.stringify([{ date: '2026-08-21', content: 'VISIBLE_MATTER_A_LOG', visibility: 'org' }]),
        },
        {
          id: accountPersonOne,
          tenantId,
          accountId,
          name: 'CUSTOMER_LEVEL_PERSON_SECRET',
          title: 'Customer-only person',
          logs: JSON.stringify([{ date: '2026-08-21', content: 'CUSTOMER_LEVEL_LOG_SECRET', visibility: 'org' }]),
        },
        {
          id: accountPersonTwo,
          tenantId,
          accountId,
          name: 'CUSTOMER_LEVEL_SECOND_PERSON_SECRET',
          title: 'Customer-only endpoint',
        },
        {
          id: hiddenPersonId,
          tenantId,
          accountId,
          name: 'HIDDEN_SIBLING_PERSON_SECRET',
          title: 'Hidden role',
        },
      ] });
      await context.prisma.oppRole.createMany({ data: [
        {
          id: 'scope-state-visible-role', tenantId, opportunityId: visibleMatterId,
          personId: visiblePersonId, role: 'D', sentiment: 'plus', confidence: '明确',
        },
        {
          id: 'scope-state-hidden-role', tenantId, opportunityId: hiddenMatterId,
          personId: hiddenPersonId, role: 'D', sentiment: 'minus', confidence: '明确',
        },
      ] });
      await context.prisma.edge.create({ data: {
        id: 'scope-state-customer-edge',
        tenantId,
        accountId,
        source: accountPersonOne,
        target: accountPersonTwo,
        layer: 'L1',
        label: 'CUSTOMER_LEVEL_EDGE_SECRET',
      } });
      await context.prisma.note.createMany({ data: [
        {
          id: 'scope-state-customer-note', tenantId, accountId,
          content: 'CUSTOMER_LEVEL_NOTE_SECRET',
        },
        {
          id: 'scope-state-visible-note', tenantId, accountId,
          opportunityId: visibleMatterId, personId: visiblePersonId,
          content: 'VISIBLE_MATTER_A_NOTE',
        },
        {
          id: 'scope-state-hidden-note', tenantId, accountId,
          opportunityId: hiddenMatterId, personId: hiddenPersonId,
          content: 'HIDDEN_SIBLING_NOTE_SECRET',
        },
        {
          id: 'scope-state-unfiled-note', tenantId,
          content: 'UNFILED_TENANT_NOTE_SECRET',
        },
      ] });
      await context.prisma.planAction.createMany({ data: [
        commitmentData({
          id: 'scope-state-customer-commitment', tenantId, accountId,
          opportunityId: null, title: 'CUSTOMER_LEVEL_COMMITMENT_SECRET',
          ownerUserId: customerOwner.user.id, localDate: '2026-09-01',
        }),
        commitmentData({
          id: 'scope-state-visible-commitment', tenantId, accountId,
          opportunityId: visibleMatterId, personId: visiblePersonId,
          title: 'VISIBLE_MATTER_A_COMMITMENT', ownerUserId: matterOwner.user.id,
          localDate: '2026-09-02',
        }),
        commitmentData({
          id: 'scope-state-hidden-commitment', tenantId, accountId,
          opportunityId: hiddenMatterId, personId: hiddenPersonId,
          title: 'HIDDEN_SIBLING_COMMITMENT_SECRET', ownerUserId: customerOwner.user.id,
          localDate: '2026-09-03',
        }),
      ] });

      const partialResponse = await context.app.inject({
        method: 'GET', url: '/api/state', headers: auth(matterOwner.token),
      });
      expect(partialResponse.statusCode, partialResponse.body).toBe(200);
      const partial = partialResponse.json<any>();
      expect(partial.accounts).toHaveLength(1);
      const partialCustomer = partial.accounts[0];
      expect(partialCustomer).toMatchObject({
        id: accountId,
        name: 'Shared Customer Header',
        customerType: 2,
        region: '',
        group: '',
        primaryOwner: '',
        primaryOwnerUserId: null,
        profile: {},
      });
      expect(partialCustomer.unifiedCreditCode).toBeUndefined();
      expect(partialCustomer.externalRef).toBeUndefined();
      expect(partialCustomer.persons.map((person: any) => person.id)).toEqual([visiblePersonId]);
      expect(partialCustomer.baseEdges).toEqual([]);
      expect(partialCustomer.opportunities.map((matter: any) => matter.id)).toEqual([visibleMatterId]);
      expect(partialCustomer.notes.map((note: any) => note.id)).toEqual(['scope-state-visible-note']);
      expect(partialCustomer.commitments.map((commitment: any) => commitment.id))
        .toEqual(['scope-state-visible-commitment']);
      expect(partial.unfiledNotes).toEqual([]);

      const partialJson = JSON.stringify(partial);
      expect(partialJson).toContain('VISIBLE_MATTER_A');
      for (const secret of [
        'CUSTOMER_LEVEL_CREDIT_SECRET',
        'CUSTOMER_LEVEL_EXTERNAL_SECRET',
        'CUSTOMER_LEVEL_REGION_SECRET',
        'CUSTOMER_LEVEL_GROUP_SECRET',
        'CUSTOMER_LEVEL_OWNER_SECRET',
        'CUSTOMER_LEVEL_PROFILE_SECRET',
        'CUSTOMER_LEVEL_PERSON_SECRET',
        'CUSTOMER_LEVEL_SECOND_PERSON_SECRET',
        'CUSTOMER_LEVEL_LOG_SECRET',
        'CUSTOMER_LEVEL_EDGE_SECRET',
        'CUSTOMER_LEVEL_NOTE_SECRET',
        'CUSTOMER_LEVEL_COMMITMENT_SECRET',
        'HIDDEN_SIBLING_MATTER_SECRET',
        'HIDDEN_SIBLING_GOAL_SECRET',
        'HIDDEN_SIBLING_PERSON_SECRET',
        'HIDDEN_SIBLING_NOTE_SECRET',
        'HIDDEN_SIBLING_COMMITMENT_SECRET',
        'UNFILED_TENANT_NOTE_SECRET',
      ]) expect(partialJson).not.toContain(secret);

      const customerOwnerResponse = await context.app.inject({
        method: 'GET', url: '/api/state', headers: auth(customerOwner.token),
      });
      expect(customerOwnerResponse.statusCode, customerOwnerResponse.body).toBe(200);
      const customerOwnerJson = customerOwnerResponse.body;
      expect(customerOwnerJson).toContain('CUSTOMER_LEVEL_PROFILE_SECRET');
      expect(customerOwnerJson).toContain('CUSTOMER_LEVEL_PERSON_SECRET');
      expect(customerOwnerJson).toContain('CUSTOMER_LEVEL_NOTE_SECRET');
      expect(customerOwnerJson).toContain('CUSTOMER_LEVEL_COMMITMENT_SECRET');
      expect(customerOwnerJson).toContain('HIDDEN_SIBLING_MATTER_SECRET');
      expect(customerOwnerJson).not.toContain('UNFILED_TENANT_NOTE_SECRET');

      await context.prisma.tenant.update({
        where: { id: tenantId },
        data: { dataScopePolicy: 'legacy_tenant_shared' },
      });
      const legacyResponse = await context.app.inject({
        method: 'GET', url: '/api/state', headers: auth(legacyMember.token),
      });
      expect(legacyResponse.statusCode, legacyResponse.body).toBe(200);
      expect(legacyResponse.body).toContain('CUSTOMER_LEVEL_PROFILE_SECRET');
      expect(legacyResponse.body).toContain('HIDDEN_SIBLING_MATTER_SECRET');
      expect(legacyResponse.body).toContain('UNFILED_TENANT_NOTE_SECRET');
    } finally {
      await context.cleanup();
    }
  });
});
