import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

async function loadParticipantMigration(): Promise<any> {
  const modulePath = '../src/matter/participants.js';
  return import(modulePath).catch(() => null);
}

async function seedParticipantTree(
  context: Awaited<ReturnType<typeof createTestContext>>,
  suffix: string,
) {
  const accountId = `participant-account-${suffix}`;
  const opportunityId = `participant-matter-${suffix}`;
  await context.prisma.account.create({ data: {
    id: accountId, tenantId: context.tenant.id, name: 'Participant account', customerType: 1,
  } });
  await context.prisma.opportunity.create({ data: {
    id: opportunityId, tenantId: context.tenant.id, accountId, name: 'Participant Matter',
    customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
  } });
  await context.prisma.person.createMany({ data: ['one', 'two'].map((key) => ({
    id: `participant-${suffix}-${key}`, tenantId: context.tenant.id, accountId, name: key, title: key,
  })) });
  return {
    accountId,
    opportunityId,
    firstPersonId: `participant-${suffix}-one`,
    secondPersonId: `participant-${suffix}-two`,
  };
}

describe('CORE-105 MatterParticipant migration', () => {
  it('scopes every legacy source-row scan to one enumerated tenant', async () => {
    const migration = await loadParticipantMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const roleScan = vi.fn(async (args: any) => {
      expect(args.where).toEqual({ tenantId: 'participant-scan-tenant' });
      return [];
    });
    const memberScan = vi.fn(async (args: any) => {
      expect(args.where).toEqual({ tenantId: 'participant-scan-tenant' });
      return [];
    });
    const db = {
      $queryRawUnsafe: vi.fn(async () => [{ sourceRows: 0, missingTenantRows: 0 }]),
      tenant: { findMany: vi.fn(async () => [{ id: 'participant-scan-tenant' }]) },
      oppRole: { findMany: roleScan },
      opportunityMember: { findMany: memberScan },
      opportunity: { findMany: vi.fn(async () => []) },
      person: { findMany: vi.fn(async () => []) },
    };

    await expect(migration.inspectMatterParticipantMigration(db as any)).resolves.toMatchObject({
      sourceRows: 0,
      candidateRows: 0,
      invalidRows: [],
    });
    expect(roleScan).toHaveBeenCalledOnce();
    expect(memberScan).toHaveBeenCalledOnce();
  });

  it('dry-runs the union, collapses duplicate legacy semantics, and applies idempotently', async () => {
    const migration = await loadParticipantMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const context = await createTestContext();
    try {
      const tree = await seedParticipantTree(context, 'union');
      await context.prisma.oppRole.create({ data: {
        id: 'participant-role-union', tenantId: context.tenant.id, opportunityId: tree.opportunityId,
        personId: tree.firstPersonId, role: 'R', sentiment: 'plus', confidence: '明确',
      } });
      await context.prisma.opportunityMember.createMany({ data: [
        { id: 'participant-member-union-one', tenantId: context.tenant.id, opportunityId: tree.opportunityId, personId: tree.firstPersonId },
        { id: 'participant-member-union-two', tenantId: context.tenant.id, opportunityId: tree.opportunityId, personId: tree.secondPersonId },
      ] });

      await expect(migration.inspectMatterParticipantMigration(context.prisma)).resolves.toEqual({
        sourceRows: 3,
        roleRows: 1,
        legacyVisibilityRows: 2,
        candidateRows: 2,
        duplicateSourceRows: 1,
        invalidRows: [],
      });
      await expect(context.prisma.matterParticipant.count()).resolves.toBe(0);

      await expect(migration.applyMatterParticipantBackfill(context.prisma)).resolves.toEqual({
        candidateRows: 2, createdRows: 2, existingRows: 0,
      });
      await expect(migration.hasMatterParticipantMigrationMarker(context.prisma)).resolves.toBe(true);
      await expect(migration.applyMatterParticipantBackfill(context.prisma)).resolves.toEqual({
        candidateRows: 2, createdRows: 0, existingRows: 2,
      });
      await expect(migration.verifyMatterParticipantBackfill(context.prisma)).resolves.toEqual([]);
      await expect(context.prisma.matterParticipant.findMany({
        orderBy: { personId: 'asc' },
        select: { tenantId: true, accountId: true, opportunityId: true, personId: true },
      })).resolves.toEqual([
        { tenantId: context.tenant.id, accountId: tree.accountId, opportunityId: tree.opportunityId, personId: tree.firstPersonId },
        { tenantId: context.tenant.id, accountId: tree.accountId, opportunityId: tree.opportunityId, personId: tree.secondPersonId },
      ]);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed before writes when a legacy source crosses the customer parent tree', async () => {
    const migration = await loadParticipantMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const context = await createTestContext();
    try {
      const tree = await seedParticipantTree(context, 'invalid');
      await context.prisma.account.create({ data: {
        id: 'participant-invalid-other-account', tenantId: context.tenant.id, name: 'Other account', customerType: 1,
      } });
      await context.prisma.person.create({ data: {
        id: 'participant-invalid-other-person', tenantId: context.tenant.id,
        accountId: 'participant-invalid-other-account', name: 'Other', title: 'Other',
      } });
      await context.prisma.oppRole.create({ data: {
        id: 'participant-invalid-role', tenantId: context.tenant.id, opportunityId: tree.opportunityId,
        personId: 'participant-invalid-other-person', role: 'R', sentiment: 'unknown', confidence: '不清',
      } });

      await expect(migration.inspectMatterParticipantMigration(context.prisma)).resolves.toEqual({
        sourceRows: 1,
        roleRows: 1,
        legacyVisibilityRows: 0,
        candidateRows: 0,
        duplicateSourceRows: 0,
        invalidRows: [{
          sourceKind: 'opp_role', sourceId: 'participant-invalid-role', tenantId: context.tenant.id,
          opportunityId: tree.opportunityId, personId: 'participant-invalid-other-person', reason: 'account_mismatch',
        }],
      });
      await expect(migration.applyMatterParticipantBackfill(context.prisma))
        .rejects.toThrow(/invalid MatterParticipant legacy parentage/);
      await expect(context.prisma.matterParticipant.count()).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('does not mark the backfill complete when an existing participant has the wrong customer', async () => {
    const migration = await loadParticipantMigration();
    expect(migration).not.toBeNull();
    if (!migration) return;

    const context = await createTestContext();
    try {
      const tree = await seedParticipantTree(context, 'existing-mismatch');
      await context.prisma.account.create({ data: {
        id: 'participant-existing-other-account', tenantId: context.tenant.id,
        name: 'Other account', customerType: 1,
      } });
      await context.prisma.oppRole.create({ data: {
        id: 'participant-existing-role', tenantId: context.tenant.id,
        opportunityId: tree.opportunityId, personId: tree.firstPersonId,
        role: 'R', sentiment: 'unknown', confidence: '不清',
      } });
      await context.prisma.matterParticipant.create({ data: {
        tenantId: context.tenant.id,
        accountId: 'participant-existing-other-account',
        opportunityId: tree.opportunityId,
        personId: tree.firstPersonId,
      } });

      await expect(migration.applyMatterParticipantBackfill(context.prisma))
        .rejects.toThrow(/existing MatterParticipant customer mismatch/);
      await expect(migration.hasMatterParticipantMigrationMarker(context.prisma)).resolves.toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  it('enforces tenant-scoped parent combinations at the database boundary', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedParticipantTree(context, 'constraint');
      await context.prisma.tenant.create({ data: {
        id: 'participant-constraint-other-tenant', name: 'Other tenant',
      } });
      await context.prisma.account.create({ data: {
        id: 'participant-constraint-other-account', tenantId: 'participant-constraint-other-tenant', name: 'Other account', customerType: 1,
      } });
      await context.prisma.person.create({ data: {
        id: 'participant-constraint-other-person', tenantId: 'participant-constraint-other-tenant',
        accountId: 'participant-constraint-other-account', name: 'Other', title: 'Other',
      } });

      await expect(context.prisma.matterParticipant.create({ data: {
        tenantId: context.tenant.id,
        accountId: tree.accountId,
        opportunityId: tree.opportunityId,
        personId: 'participant-constraint-other-person',
      } })).rejects.toThrow();
      await expect(context.prisma.matterParticipant.count()).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('drops a same-tenant participant whose redundant accountId disagrees with the Matter tree', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedParticipantTree(context, 'state-guard');
      await context.prisma.account.create({ data: {
        id: 'participant-state-other-account', tenantId: context.tenant.id, name: 'Other account', customerType: 1,
      } });
      await context.prisma.matterParticipant.create({ data: {
        tenantId: context.tenant.id,
        accountId: 'participant-state-other-account',
        opportunityId: tree.opportunityId,
        personId: tree.firstPersonId,
      } });

      const response = await context.app.inject({
        method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${context.token}` },
      });
      expect(response.statusCode).toBe(200);
      const account = response.json<any>().accounts.find(({ id }: { id: string }) => id === tree.accountId);
      expect(account.opportunities[0].participantIds).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });
});
