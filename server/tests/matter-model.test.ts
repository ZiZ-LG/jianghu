import { describe, expect, it } from 'vitest';
import { mapLegacyOpportunityStatus } from '../src/matter/lifecycle.js';
import {
  applyMatterFieldBackfill,
  applyMatterFieldBackfillForTenants,
  inspectMatterMigrationIntegrity,
  inspectTenantMatterMigration,
  verifyTenantMatterParity,
} from '../src/matter/migration.js';
import { createTestContext } from './helpers/testApp.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function seedMatterRows(
  context: Awaited<ReturnType<typeof createTestContext>>,
  statuses: readonly string[],
) {
  const accountId = `acc-matter-${context.tenant.id}`;
  await context.prisma.account.create({
    data: { id: accountId, tenantId: context.tenant.id, name: 'Matter migration account', customerType: 1 },
  });
  for (const [index, status] of statuses.entries()) {
    await context.prisma.opportunity.create({
      data: {
        id: `opp-matter-${context.tenant.id}-${index}`,
        tenantId: context.tenant.id,
        accountId,
        name: `Matter ${status}`,
        customerType: 1,
        pipelineStage: '线索',
        engageStage: '需求调研立项',
        status,
      },
    });
  }
  return accountId;
}

describe('CORE-103 Matter model expansion', () => {
  it('maps every supported legacy status without turning sales outcomes into lifecycle states', () => {
    expect(mapLegacyOpportunityStatus('active')).toEqual({ lifecycleStatus: 'active', outcomeKey: null });
    expect(mapLegacyOpportunityStatus('paused')).toEqual({ lifecycleStatus: 'paused', outcomeKey: null });
    expect(mapLegacyOpportunityStatus('won')).toEqual({ lifecycleStatus: 'completed', outcomeKey: 'won' });
    expect(mapLegacyOpportunityStatus('lost')).toEqual({ lifecycleStatus: 'completed', outcomeKey: 'lost' });
    expect(() => mapLegacyOpportunityStatus('future_status')).toThrow(/unsupported legacy Opportunity status/);
  });

  it('reports, applies, and verifies the SQLite-compatible backfill tenant by tenant', async () => {
    const context = await createTestContext();
    try {
      await seedMatterRows(context, ['active', 'paused', 'won', 'lost']);

      await expect(inspectTenantMatterMigration(context.prisma, context.tenant.id)).resolves.toEqual({
        tenantId: context.tenant.id,
        totalRows: 4,
        supportedRows: 4,
        unsupportedRows: 0,
        mappings: [
          { legacyStatus: 'active', lifecycleStatus: 'active', outcomeKey: null, count: 1 },
          { legacyStatus: 'lost', lifecycleStatus: 'completed', outcomeKey: 'lost', count: 1 },
          { legacyStatus: 'paused', lifecycleStatus: 'paused', outcomeKey: null, count: 1 },
          { legacyStatus: 'won', lifecycleStatus: 'completed', outcomeKey: 'won', count: 1 },
        ],
        unsupported: [],
      });

      await applyMatterFieldBackfill(context.prisma, context.tenant.id);
      await expect(verifyTenantMatterParity(context.prisma, context.tenant.id)).resolves.toEqual([]);

      const rows = await context.prisma.opportunity.findMany({
        where: { tenantId: context.tenant.id },
        orderBy: { status: 'asc' },
        select: { status: true, kind: true, lifecycleStatus: true, outcomeKey: true },
      });
      expect(rows).toEqual([
        { status: 'active', kind: 'sales_opportunity', lifecycleStatus: 'active', outcomeKey: null },
        { status: 'lost', kind: 'sales_opportunity', lifecycleStatus: 'completed', outcomeKey: 'lost' },
        { status: 'paused', kind: 'sales_opportunity', lifecycleStatus: 'paused', outcomeKey: null },
        { status: 'won', kind: 'sales_opportunity', lifecycleStatus: 'completed', outcomeKey: 'won' },
      ]);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed on an unsupported legacy status before changing its shadow fields', async () => {
    const context = await createTestContext();
    try {
      await seedMatterRows(context, ['future_status']);
      const report = await inspectTenantMatterMigration(context.prisma, context.tenant.id);
      expect(report.unsupported).toEqual([{ legacyStatus: 'future_status', count: 1 }]);
      await expect(applyMatterFieldBackfill(context.prisma, context.tenant.id))
        .rejects.toThrow(/unsupported legacy Opportunity status/);
      await expect(context.prisma.opportunity.findFirstOrThrow({
        where: { tenantId: context.tenant.id },
        select: { lifecycleStatus: true, outcomeKey: true },
      })).resolves.toEqual({ lifecycleStatus: 'active', outcomeKey: null });
    } finally {
      await context.cleanup();
    }
  });

  it('does not partially backfill earlier tenants when any tenant fails preflight', async () => {
    const context = await createTestContext();
    try {
      await seedMatterRows(context, ['won']);
      const secondTenantId = `tenant-matter-${context.tenant.id}`;
      const secondAccountId = `acc-matter-${secondTenantId}`;
      await context.prisma.tenant.create({ data: { id: secondTenantId, name: 'Second migration tenant' } });
      await context.prisma.account.create({
        data: { id: secondAccountId, tenantId: secondTenantId, name: 'Second account', customerType: 1 },
      });
      await context.prisma.opportunity.create({
        data: {
          id: `opp-matter-${secondTenantId}`,
          tenantId: secondTenantId,
          accountId: secondAccountId,
          name: 'Unsupported Matter',
          customerType: 1,
          pipelineStage: '线索',
          engageStage: '需求调研立项',
          status: 'future_status',
        },
      });

      await expect(applyMatterFieldBackfillForTenants(context.prisma, [context.tenant.id, secondTenantId]))
        .rejects.toThrow(/unsupported legacy Opportunity status/);
      await expect(context.prisma.opportunity.findFirstOrThrow({
        where: { tenantId: context.tenant.id },
        select: { status: true, lifecycleStatus: true, outcomeKey: true },
      })).resolves.toEqual({ status: 'won', lifecycleStatus: 'active', outcomeKey: null });
    } finally {
      await context.cleanup();
    }
  });

  it('fails before writes when Matter tenant or Account parentage is inconsistent', async () => {
    const context = await createTestContext();
    try {
      const accountId = await seedMatterRows(context, ['won']);
      const secondTenantId = `tenant-parentage-${context.tenant.id}`;
      await context.prisma.tenant.create({ data: { id: secondTenantId, name: 'Parentage tenant' } });
      await context.prisma.opportunity.createMany({
        data: [
          {
            id: `opp-cross-parent-${context.tenant.id}`,
            tenantId: secondTenantId,
            accountId,
            name: 'Cross-tenant parent',
            customerType: 1,
            pipelineStage: '线索',
            engageStage: '需求调研立项',
          },
          {
            id: `opp-missing-tenant-${context.tenant.id}`,
            tenantId: `missing-${context.tenant.id}`,
            accountId,
            name: 'Missing tenant',
            customerType: 1,
            pipelineStage: '线索',
            engageStage: '需求调研立项',
          },
        ],
      });

      await expect(inspectMatterMigrationIntegrity(context.prisma)).resolves.toEqual({
        totalRows: 3,
        missingTenantRows: 1,
        missingAccountRows: 0,
        accountTenantMismatchRows: 2,
      });
      await expect(applyMatterFieldBackfillForTenants(context.prisma, [context.tenant.id, secondTenantId]))
        .rejects.toThrow(/Matter migration integrity failed/);
      await expect(context.prisma.opportunity.findFirstOrThrow({
        where: { tenantId: context.tenant.id },
        select: { status: true, lifecycleStatus: true, outcomeKey: true },
      })).resolves.toEqual({ status: 'won', lifecycleStatus: 'active', outcomeKey: null });
    } finally {
      await context.cleanup();
    }
  });

  it('does not partially backfill any tenant after a non-sales Matter kind exists', async () => {
    const context = await createTestContext();
    try {
      await seedMatterRows(context, ['won']);
      const secondTenantId = `tenant-general-matter-${context.tenant.id}`;
      const secondAccountId = `acc-general-matter-${context.tenant.id}`;
      await context.prisma.tenant.create({ data: { id: secondTenantId, name: 'General Matter tenant' } });
      await context.prisma.account.create({
        data: { id: secondAccountId, tenantId: secondTenantId, name: 'General Matter account', customerType: 1 },
      });
      await context.prisma.opportunity.create({
        data: {
          id: `opp-general-matter-${context.tenant.id}`,
          tenantId: secondTenantId,
          accountId: secondAccountId,
          name: 'General Matter',
          customerType: 1,
          pipelineStage: '线索',
          engageStage: '需求调研立项',
          status: 'active',
          kind: 'general',
        },
      });

      await expect(applyMatterFieldBackfillForTenants(context.prisma, [context.tenant.id, secondTenantId]))
        .rejects.toThrow(/backfill is no longer safe after non-sales kinds exist/);
      await expect(context.prisma.opportunity.findMany({
        where: { tenantId: { in: [context.tenant.id, secondTenantId] } },
        orderBy: { tenantId: 'asc' },
        select: { tenantId: true, status: true, kind: true, lifecycleStatus: true, outcomeKey: true },
      })).resolves.toEqual(expect.arrayContaining([
        {
          tenantId: context.tenant.id,
          status: 'won',
          kind: 'sales_opportunity',
          lifecycleStatus: 'active',
          outcomeKey: null,
        },
        {
          tenantId: secondTenantId,
          status: 'active',
          kind: 'general',
          lifecycleStatus: 'active',
          outcomeKey: null,
        },
      ]));
    } finally {
      await context.cleanup();
    }
  });

  it('keeps legacy status writes and Matter shadow fields aligned', async () => {
    const context = await createTestContext();
    try {
      const accountId = await seedMatterRows(context, ['active']);
      const opportunity = await context.prisma.opportunity.findFirstOrThrow({ where: { tenantId: context.tenant.id } });
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: auth(context.token),
        payload: {
          action: {
            type: 'UPDATE_OPP',
            accId: accountId,
            oppId: opportunity.id,
            baseVersion: 0,
            patch: { status: 'won' },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } }))
        .resolves.toMatchObject({ status: 'won', lifecycleStatus: 'completed', outcomeKey: 'won', version: 1 });
    } finally {
      await context.cleanup();
    }
  });

  it('maps legacy status during ADD_OPP creation', async () => {
    const context = await createTestContext();
    try {
      const accountId = `acc-add-matter-${context.tenant.id}`;
      const opportunityId = `opp-add-matter-${context.tenant.id}`;
      await context.prisma.account.create({
        data: { id: accountId, tenantId: context.tenant.id, name: 'Matter creation account', customerType: 1 },
      });
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/mutate',
        headers: auth(context.token),
        payload: {
          action: {
            type: 'ADD_OPP',
            accId: accountId,
            opp: {
              id: opportunityId,
              name: 'Lost sales matter',
              customerType: 1,
              pipelineStage: '线索',
              engageStage: '需求调研立项',
              status: 'lost',
            },
          },
        },
      });
      expect(response.statusCode).toBe(200);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } }))
        .resolves.toMatchObject({ status: 'lost', lifecycleStatus: 'completed', outcomeKey: 'lost' });
    } finally {
      await context.cleanup();
    }
  });

  it('keeps repair status updates and Matter shadow fields aligned', async () => {
    const context = await createTestContext();
    try {
      await seedMatterRows(context, ['active']);
      const opportunity = await context.prisma.opportunity.findFirstOrThrow({ where: { tenantId: context.tenant.id } });
      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/opportunity/${opportunity.id}`,
        headers: auth(context.token),
        payload: { baseVersion: opportunity.version, status: 'won' },
      });
      expect(response.statusCode).toBe(200);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } }))
        .resolves.toMatchObject({ status: 'won', lifecycleStatus: 'completed', outcomeKey: 'won', version: 1 });
    } finally {
      await context.cleanup();
    }
  });

  it('returns unknown Matter kinds and the expanded fields without fallback to legacy status', async () => {
    const context = await createTestContext();
    try {
      await seedMatterRows(context, ['active']);
      const opportunity = await context.prisma.opportunity.findFirstOrThrow({ where: { tenantId: context.tenant.id } });
      await context.prisma.opportunity.update({
        where: { id: opportunity.id },
        data: {
          kind: 'partner_campaign',
          lifecycleStatus: 'paused',
          outcomeKey: null,
          priority: 'important',
          targetDate: '2026-10-01',
          primaryOwnerUserId: context.owner.id,
          activeMethodologyBindingId: 'binding-future',
        },
      });

      const state = (await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(context.token) })).json();
      expect(state.accounts[0].opportunities[0]).toMatchObject({
        id: opportunity.id,
        status: 'active',
        kind: 'partner_campaign',
        lifecycleStatus: 'paused',
        outcomeKey: null,
        priority: 'important',
        targetDate: '2026-10-01',
        primaryOwnerUserId: context.owner.id,
        activeMethodologyBindingId: 'binding-future',
      });
    } finally {
      await context.cleanup();
    }
  });
});
