import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from './helpers/testApp.js';
import { runPatrol } from '../src/jobs.js';
import {
  computeCommitmentReminders,
  computeMatterWithoutNextReminder,
  type PatrolCommitment,
} from '../src/patrol.js';

const NOW = new Date('2026-08-21T04:00:00.000Z');

function commitment(patch: Partial<PatrolCommitment> = {}): PatrolCommitment {
  return {
    tenantId: 'tenant-a',
    accountId: 'customer-a',
    accountName: '客户 A',
    matterId: 'matter-a',
    matterName: '事项 A',
    commitmentId: 'commitment-a',
    title: '确认下次交流',
    ownerUserId: 'owner-a',
    executionStatus: 'planned',
    confirmationStatus: 'pending',
    scheduledAtUtc: new Date('2026-08-21T03:00:00.000Z'),
    dueAtUtc: null,
    timeZone: 'Asia/Shanghai',
    isAllDay: false,
    localDate: null,
    confirmationDueAtUtc: new Date('2026-08-20T03:00:00.000Z'),
    scheduleVersion: 3,
    archivedAt: null,
    ...patch,
  };
}

describe('CORE-108 Commitment deterministic reminder derivation', () => {
  it('derives confirmation and due reminders from generic fields with scheduleVersion keys', () => {
    const drafts = computeCommitmentReminders(commitment(), NOW);

    expect(drafts.map((draft) => [draft.kind, draft.dedupeKey])).toEqual([
      ['confirmation_due', 'tenant-a:commitment-a:confirmation_due:3'],
      ['commitment_due', 'tenant-a:commitment-a:commitment_due:3'],
    ]);
    expect(drafts).toEqual(expect.arrayContaining([
      expect.objectContaining({ opportunityId: 'matter-a', entityId: 'commitment-a' }),
    ]));
  });

  it.each([
    { executionStatus: 'completed' },
    { executionStatus: 'canceled' },
    { executionStatus: 'missed' },
    { confirmationStatus: 'declined' },
    { archivedAt: new Date('2026-08-20T00:00:00.000Z') },
  ])('ends all current reminders for terminal or declined state %#', (patch) => {
    expect(computeCommitmentReminders(commitment(patch as Partial<PatrolCommitment>), NOW)).toEqual([]);
  });

  it('uses the Commitment time zone for an all-day due date without inventing UTC midnight', () => {
    const drafts = computeCommitmentReminders(commitment({
      confirmationStatus: 'not_required',
      confirmationDueAtUtc: null,
      scheduledAtUtc: null,
      isAllDay: true,
      localDate: '2026-08-21',
      timeZone: 'Asia/Shanghai',
    }), NOW);

    expect(drafts).toEqual([
      expect.objectContaining({ kind: 'commitment_due', dedupeKey: 'tenant-a:commitment-a:commitment_due:3' }),
    ]);
  });

  it('derives a weekly Matter gap reminder and stops it as soon as a valid next Commitment exists', () => {
    const base = {
      tenantId: 'tenant-a', accountId: 'customer-a', accountName: '客户 A',
      matterId: 'matter-a', matterName: '事项 A', businessTimeZone: 'Asia/Shanghai',
    };

    expect(computeMatterWithoutNextReminder({ ...base, hasValidNextCommitment: false }, NOW)).toMatchObject({
      kind: 'matter_without_next_commitment',
      entityId: 'matter-a',
      dedupeKey: 'tenant-a:matter-a:matter_without_next_commitment:2026-08-17',
    });
    expect(computeMatterWithoutNextReminder({ ...base, hasValidNextCommitment: true }, NOW)).toBeNull();
  });
});

describe('CORE-108 Commitment patrol lifecycle', () => {
  it('resolves old revisions and Matter gaps without mutating formal business rows', async () => {
    const context = await createTestContext();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const accountId = 'customer-reminder-lifecycle';
      const matterId = 'matter-reminder-lifecycle';
      const gapMatterId = 'matter-reminder-gap';
      const commitmentId = 'commitment-reminder-lifecycle';
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: '提醒客户', customerType: 1,
      } });
      await context.prisma.opportunity.createMany({ data: [{
        id: matterId, tenantId: context.tenant.id, accountId, name: '提醒事项', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项', status: 'active', lifecycleStatus: 'active',
      }, {
        id: gapMatterId, tenantId: context.tenant.id, accountId, name: '缺下一步事项', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项', status: 'active', lifecycleStatus: 'active',
      }] });
      await context.prisma.planAction.create({ data: {
        id: commitmentId, tenantId: context.tenant.id, accountId, opportunityId: matterId,
        title: '已到期的客户确认', startDate: '2026-08-21', endDate: '2026-08-21',
        ownerId: context.owner.id, ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'pending',
        scheduledAtUtc: new Date('2026-08-21T03:00:00.000Z'), dueAtUtc: null,
        timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
        confirmationDueAtUtc: new Date('2026-08-20T03:00:00.000Z'), scheduleVersion: 0, version: 0,
      } });

      const formalBefore = await context.prisma.planAction.findUniqueOrThrow({ where: { id: commitmentId } });
      await runPatrol();
      const formalAfter = await context.prisma.planAction.findUniqueOrThrow({ where: { id: commitmentId } });
      expect(formalAfter).toEqual(formalBefore);
      await expect(context.prisma.reminder.findMany({ where: {
        tenantId: context.tenant.id, entityId: commitmentId, status: 'pending',
      }, orderBy: { kind: 'asc' } })).resolves.toEqual([
        expect.objectContaining({
          kind: 'commitment_due',
          dedupeKey: `${context.tenant.id}:${commitmentId}:commitment_due:0`,
        }),
        expect.objectContaining({
          kind: 'confirmation_due',
          dedupeKey: `${context.tenant.id}:${commitmentId}:confirmation_due:0`,
        }),
      ]);
      await expect(context.prisma.reminder.findFirstOrThrow({ where: {
        tenantId: context.tenant.id, entityId: gapMatterId, kind: 'matter_without_next_commitment',
      } })).resolves.toMatchObject({ status: 'pending' });

      await context.prisma.planAction.update({ where: { id: commitmentId }, data: {
        confirmationStatus: 'confirmed', confirmedAtUtc: NOW, confirmedByUserId: context.owner.id, version: { increment: 1 },
      } });
      await runPatrol();
      await expect(context.prisma.reminder.findUniqueOrThrow({ where: { tenantId_dedupeKey: {
        tenantId: context.tenant.id,
        dedupeKey: `${context.tenant.id}:${commitmentId}:confirmation_due:0`,
      } } })).resolves.toMatchObject({ status: 'done' });

      await context.prisma.planAction.update({ where: { id: commitmentId }, data: {
        confirmationStatus: 'pending', confirmedAtUtc: null, confirmedByUserId: null,
        scheduledAtUtc: new Date('2026-08-23T03:00:00.000Z'),
        confirmationDueAtUtc: new Date('2026-08-22T03:00:00.000Z'),
        scheduleVersion: { increment: 1 }, version: { increment: 1 },
      } });
      await runPatrol();
      await expect(context.prisma.reminder.findUniqueOrThrow({ where: { tenantId_dedupeKey: {
        tenantId: context.tenant.id,
        dedupeKey: `${context.tenant.id}:${commitmentId}:commitment_due:0`,
      } } })).resolves.toMatchObject({ status: 'done' });
      expect(await context.prisma.reminder.count({ where: {
        tenantId: context.tenant.id, entityId: commitmentId, status: 'pending',
      } })).toBe(0);

      await context.prisma.planAction.create({ data: {
        id: 'commitment-gap-next', tenantId: context.tenant.id, accountId, opportunityId: gapMatterId,
        title: '有效下一步', startDate: '2026-08-24', endDate: '2026-08-24',
        ownerId: context.owner.id, ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        scheduledAtUtc: new Date('2026-08-24T03:00:00.000Z'), dueAtUtc: null,
        timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
        confirmationDueAtUtc: null, scheduleVersion: 0, version: 0,
      } });
      await runPatrol();
      await expect(context.prisma.reminder.findFirstOrThrow({ where: {
        tenantId: context.tenant.id, entityId: gapMatterId, kind: 'matter_without_next_commitment',
      } })).resolves.toMatchObject({ status: 'done' });
    } finally {
      vi.useRealTimers();
      await context.cleanup();
    }
  });
});
