import { describe, expect, it } from 'vitest';
import {
  applyCommitmentBackfill,
  COMMITMENT_CUTOVER_KEY,
  COMMITMENT_MIGRATION_KEY,
  hasCommitmentCutoverMarker,
  inspectCommitmentMigration,
  isCommitmentMatterNullable,
  markCommitmentCutover,
  verifyCommitmentBackfill,
  verifyCurrentCommitmentIntegrity,
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

describe('CORE-108 Commitment migration cutover', () => {
  it('rejects a next Commitment link that escapes the current customer tree', async () => {
    const context = await createTestContext();
    try {
      const first = await seedLegacyTree(context, 'next-first');
      const second = await seedLegacyTree(context, 'next-second');
      await context.prisma.planAction.createMany({ data: [{
        id: 'commitment-cutover-next-source', tenantId: context.tenant.id,
        accountId: first.accountId, opportunityId: null,
        title: 'Source', localDate: '2026-10-10', isAllDay: true,
        timeZone: 'Asia/Shanghai', source: 'manual',
      }, {
        id: 'commitment-cutover-next-foreign-customer', tenantId: context.tenant.id,
        accountId: second.accountId, opportunityId: null,
        title: 'Wrong customer target', localDate: '2026-10-11', isAllDay: true,
        timeZone: 'Asia/Shanghai', source: 'manual',
      }] });
      await context.prisma.planAction.update({
        where: { id: 'commitment-cutover-next-source' },
        data: { nextCommitmentId: 'commitment-cutover-next-foreign-customer' },
      });

      await expect(verifyCurrentCommitmentIntegrity(context.prisma)).resolves.toEqual([{
        tenantId: context.tenant.id,
        id: 'commitment-cutover-next-source',
        field: 'nextCommitmentId',
        expected: 'valid',
        actual: 'commitment-cutover-next-foreign-customer',
      }]);
    } finally {
      await context.cleanup();
    }
  });

  it('marks only a nullable, valid generic authority and never compares it back to legacy fields', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'commitment-cutover-account';
      const commitmentId = 'commitment-cutover-customer-level';
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: 'Cutover customer', customerType: 1,
      } });
      await context.prisma.dataMigrationState.create({ data: {
        key: COMMITMENT_MIGRATION_KEY, details: '{}',
      } });
      await context.prisma.planAction.create({ data: {
        id: commitmentId, tenantId: context.tenant.id, accountId, opportunityId: null,
        title: 'Generic customer follow-up', ownerId: context.owner.id, ownerUserId: context.owner.id,
        startDate: '1999-01-01', endDate: '1999-01-01',
        localDate: '2026-10-10', isAllDay: true, timeZone: 'Asia/Shanghai',
        executionStatus: 'planned', confirmationStatus: 'not_required', source: 'manual',
      } });

      await expect(isCommitmentMatterNullable(context.prisma)).resolves.toBe(true);
      await expect(verifyCurrentCommitmentIntegrity(context.prisma)).resolves.toEqual([]);

      await context.prisma.planAction.update({
        where: { id: commitmentId }, data: { ownerUserId: 'missing-tenant-user' },
      });
      await expect(markCommitmentCutover(context.prisma)).rejects.toThrow('Commitment cutover preflight failed');
      await expect(context.prisma.dataMigrationState.findUnique({
        where: { key: COMMITMENT_CUTOVER_KEY },
      })).resolves.toBeNull();

      await context.prisma.planAction.update({
        where: { id: commitmentId }, data: {
          ownerUserId: context.owner.id,
          // Intentional valid generic/legacy divergence after cutover.
          localDate: '2026-10-11',
        },
      });
      await expect(markCommitmentCutover(context.prisma)).resolves.toBeUndefined();
      await expect(hasCommitmentCutoverMarker(context.prisma)).resolves.toBe(true);
      await expect(verifyCurrentCommitmentIntegrity(context.prisma)).resolves.toEqual([]);
      await expect(verifyCommitmentBackfill(context.prisma)).resolves.toEqual([]);
    } finally {
      await context.cleanup();
    }
  });
});
