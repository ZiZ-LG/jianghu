import { describe, expect, it } from 'vitest';
import {
  applyCommitmentBackfill,
  COMMITMENT_MIGRATION_KEY,
  inspectCommitmentMigration,
  verifyCommitmentBackfill,
} from '../src/commitment/migration.js';
import { createTestContext } from './helpers/testApp.js';

async function seedLegacyTree(context: Awaited<ReturnType<typeof createTestContext>>, suffix: string) {
  const accountId = `commitment-migration-account-${suffix}`;
  const opportunityId = `commitment-migration-matter-${suffix}`;
  const personId = `commitment-migration-person-${suffix}`;
  await context.prisma.account.create({ data: {
    id: accountId, tenantId: context.tenant.id, name: 'Customer', customerType: 1,
  } });
  await context.prisma.opportunity.create({ data: {
    id: opportunityId, tenantId: context.tenant.id, accountId, name: 'Matter',
    customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
  } });
  await context.prisma.person.create({ data: {
    id: personId, tenantId: context.tenant.id, accountId, name: 'Person', title: 'Owner',
  } });
  return { accountId, opportunityId, personId };
}

describe('CORE-106 Commitment migration', () => {
  it('scans tenant-scoped source rows, backfills atomically, and records parity', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedLegacyTree(context, 'valid');
      await context.prisma.planAction.createMany({ data: [{
        id: 'commitment-migration-planned', tenantId: context.tenant.id,
        accountId: tree.accountId, opportunityId: tree.opportunityId, personId: tree.personId,
        title: 'Plan', ownerId: context.owner.id, startDate: '2026-10-07', endDate: '2026-10-08',
        done: false, origin: 'workbuddy', createdBy: '',
        // Simulate the defaults left by a schema-only expansion before backfill.
        localDate: null, source: 'manual', ownerUserId: null,
      }, {
        id: 'commitment-migration-completed', tenantId: context.tenant.id,
        accountId: tree.accountId, opportunityId: tree.opportunityId,
        title: 'Done', ownerId: '', startDate: '2026-09-01', endDate: '2026-09-01',
        done: true, origin: '', createdBy: context.owner.id,
        localDate: null, source: 'manual', ownerUserId: null,
      }] });

      await expect(inspectCommitmentMigration(context.prisma)).resolves.toMatchObject({
        sourceRows: 2, candidateRows: 2, unassignedOwnerRows: 1, invalidRows: [],
      });
      await expect(applyCommitmentBackfill(context.prisma)).resolves.toEqual({
        candidateRows: 2, unassignedOwnerRows: 1, updatedRows: 2,
      });
      await expect(verifyCommitmentBackfill(context.prisma)).resolves.toEqual([]);
      await expect(context.prisma.dataMigrationState.findUnique({
        where: { key: COMMITMENT_MIGRATION_KEY }, select: { key: true },
      })).resolves.toEqual({ key: COMMITMENT_MIGRATION_KEY });
      await expect(context.prisma.planAction.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, ownerUserId: true, executionStatus: true, localDate: true, source: true },
      })).resolves.toEqual([
        {
          id: 'commitment-migration-completed', ownerUserId: null,
          executionStatus: 'completed', localDate: '2026-09-01', source: 'manual',
        },
        {
          id: 'commitment-migration-planned', ownerUserId: context.owner.id,
          executionStatus: 'planned', localDate: '2026-10-08', source: 'workbuddy',
        },
      ]);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a cross-tenant owner before writes and never leaves a completion marker', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedLegacyTree(context, 'foreign-owner');
      const foreignTenant = await context.prisma.tenant.create({ data: { id: 'commitment-migration-foreign', name: 'Foreign' } });
      const foreignOwner = await context.prisma.user.create({ data: {
        id: 'commitment-migration-foreign-owner', tenantId: foreignTenant.id,
        email: 'foreign-commitment-owner@example.test', passwordHash: 'unused', name: 'Foreign', role: 'owner',
      } });
      await context.prisma.planAction.create({ data: {
        id: 'commitment-migration-invalid-owner', tenantId: context.tenant.id,
        accountId: tree.accountId, opportunityId: tree.opportunityId,
        title: 'Invalid owner', ownerId: foreignOwner.id,
        startDate: '2026-10-08', endDate: '2026-10-08', done: false,
      } });

      await expect(inspectCommitmentMigration(context.prisma)).resolves.toMatchObject({
        sourceRows: 1,
        candidateRows: 0,
        invalidRows: [{
          tenantId: context.tenant.id,
          id: 'commitment-migration-invalid-owner',
          reason: 'invalid_owner_user',
        }],
      });
      await expect(applyCommitmentBackfill(context.prisma)).rejects.toThrow('invalid legacy PlanAction rows');
      await expect(context.prisma.dataMigrationState.findUnique({
        where: { key: COMMITMENT_MIGRATION_KEY },
      })).resolves.toBeNull();
      await expect(context.prisma.planAction.findUniqueOrThrow({
        where: { id: 'commitment-migration-invalid-owner' }, select: { localDate: true },
      })).resolves.toEqual({ localDate: null });
    } finally {
      await context.cleanup();
    }
  });

  it('detects post-backfill shadow drift instead of falling back to legacy fields', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedLegacyTree(context, 'drift');
      await context.prisma.planAction.create({ data: {
        id: 'commitment-migration-drift', tenantId: context.tenant.id,
        accountId: tree.accountId, opportunityId: tree.opportunityId,
        title: 'Drift', startDate: '2026-10-08', endDate: '2026-10-08', done: false,
      } });
      await applyCommitmentBackfill(context.prisma);
      await context.prisma.planAction.update({
        where: { id: 'commitment-migration-drift' }, data: { localDate: '2026-10-09' },
      });

      await expect(verifyCommitmentBackfill(context.prisma)).resolves.toEqual([
        {
          tenantId: context.tenant.id,
          id: 'commitment-migration-drift',
          field: 'localDate',
          expected: '2026-10-08',
          actual: '2026-10-09',
        },
      ]);
    } finally {
      await context.cleanup();
    }
  });
});
