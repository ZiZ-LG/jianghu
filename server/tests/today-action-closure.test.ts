import { describe, expect, it } from 'vitest';
import type { CommitmentCommand } from '@jianghu/domain-contracts';
import { buildTodayReadModel } from '../src/today.js';
import { createTestContext } from './helpers/testApp.js';

const NOW = new Date('2026-08-23T19:00:00.000Z');
const CUSTOMER_ID = 'today-action-customer';
const MATTER_ID = 'today-action-matter';

const auth = (token: string, key?: string) => ({
  authorization: `Bearer ${token}`,
  ...(key ? { 'idempotency-key': key } : {}),
});

async function command(
  context: Awaited<ReturnType<typeof createTestContext>>,
  key: string,
  payload: CommitmentCommand,
  token = context.token,
) {
  return context.app.inject({
    method: 'POST',
    url: '/api/commands/commitment',
    headers: auth(token, key),
    payload,
  });
}

async function today(context: Awaited<ReturnType<typeof createTestContext>>) {
  return buildTodayReadModel({
    tenantId: context.tenant.id,
    userId: context.owner.id,
    role: 'owner',
  }, NOW, context.prisma);
}

function findItem(
  model: Awaited<ReturnType<typeof today>>,
  commitmentId: string,
) {
  const item = model.sections.flatMap((section) => section.items)
    .find((candidate) => candidate.target.commitmentId === commitmentId);
  if (!item) throw new Error(`missing Today item for ${commitmentId}`);
  return item;
}

describe('SAAS-104 Today Commitment action closure', () => {
  it('drives every formal outcome from exact Today revisions with CAS, audit, scope and explicit missed', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      await context.prisma.account.create({ data: {
        id: CUSTOMER_ID,
        tenantId: context.tenant.id,
        name: '远山制造',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.create({ data: {
        id: MATTER_ID,
        tenantId: context.tenant.id,
        accountId: CUSTOMER_ID,
        name: '方案交流',
        customerType: 1,
        pipelineStage: 'lead',
        engageStage: 'discover',
        lifecycleStatus: 'active',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.planAction.createMany({ data: [
        {
          id: 'today-action-pending', tenantId: context.tenant.id,
          accountId: CUSTOMER_ID, opportunityId: MATTER_ID,
          title: '确认方案会议', kind: 'meeting', ownerUserId: context.owner.id,
          executionStatus: 'planned', confirmationStatus: 'pending',
          scheduledAtUtc: new Date('2026-08-24T18:00:00.000Z'),
          confirmationDueAtUtc: new Date('2026-08-23T18:00:00.000Z'),
          timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
        },
        {
          id: 'today-action-complete', tenantId: context.tenant.id,
          accountId: CUSTOMER_ID, opportunityId: MATTER_ID,
          title: '发送方案', kind: 'follow_up', ownerUserId: context.owner.id,
          executionStatus: 'planned', confirmationStatus: 'not_required',
          scheduledAtUtc: new Date('2026-08-23T18:00:00.000Z'),
          timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
        },
        {
          id: 'today-action-cancel', tenantId: context.tenant.id,
          accountId: CUSTOMER_ID, opportunityId: MATTER_ID,
          title: '准备旧版材料', kind: 'follow_up', ownerUserId: context.owner.id,
          executionStatus: 'planned', confirmationStatus: 'not_required',
          scheduledAtUtc: new Date('2026-08-24T17:00:00.000Z'),
          timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
        },
        {
          id: 'today-action-missed', tenantId: context.tenant.id,
          accountId: CUSTOMER_ID, opportunityId: MATTER_ID,
          title: '已经错过的回访', kind: 'follow_up', ownerUserId: context.owner.id,
          executionStatus: 'planned', confirmationStatus: 'not_required',
          scheduledAtUtc: new Date('2026-08-23T17:00:00.000Z'),
          timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
        },
      ] });

      const initial = await today(context);
      const pending = findItem(initial, 'today-action-pending');
      const pendingSource = pending.sourceRefs[0]!;
      expect(pending.reasonCode).toBe('confirmation_due');

      const confirmed = await command(context, 'today-action-confirm', {
        type: 'CONFIRM_COMMITMENT', customerId: CUSTOMER_ID,
        commitmentId: 'today-action-pending', baseVersion: pending.target.version,
        expectedScheduleVersion: pending.target.scheduleVersion!,
        confirmedAtUtc: NOW.toISOString(),
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({ version: 1, scheduleVersion: 0, confirmationStatus: 'confirmed' });

      const staleSource = await context.app.inject({
        method: 'POST', url: '/api/today/source', headers: auth(context.token), payload: pendingSource,
      });
      expect(staleSource.statusCode).toBe(404);

      const rescheduled = await command(context, 'today-action-reschedule', {
        type: 'RESCHEDULE_COMMITMENT', customerId: CUSTOMER_ID,
        commitmentId: 'today-action-pending', baseVersion: 1, expectedScheduleVersion: 0,
        schedule: {
          scheduledAtUtc: '2026-08-24T20:00:00.000Z', dueAtUtc: null,
          timeZone: 'America/Los_Angeles', isAllDay: false, localDate: null,
          confirmationDueAtUtc: '2026-08-23T18:30:00.000Z', requiresConfirmation: true,
        },
      });
      expect(rescheduled.statusCode, rescheduled.body).toBe(200);
      expect(rescheduled.json()).toMatchObject({ version: 2, scheduleVersion: 1, confirmationStatus: 'pending' });
      const newPending = findItem(await today(context), 'today-action-pending');
      expect(newPending.target).toMatchObject({ version: 2, scheduleVersion: 1 });

      const declined = await command(context, 'today-action-decline', {
        type: 'DECLINE_COMMITMENT', customerId: CUSTOMER_ID,
        commitmentId: 'today-action-pending', baseVersion: 2, expectedScheduleVersion: 1,
        declinedAtUtc: NOW.toISOString(),
      });
      expect(declined.statusCode, declined.body).toBe(200);
      expect(declined.json()).toMatchObject({ version: 3, scheduleVersion: 1, confirmationStatus: 'declined' });

      const completedTarget = findItem(initial, 'today-action-complete').target;
      const completed = await command(context, 'today-action-complete', {
        type: 'COMPLETE_COMMITMENT', customerId: CUSTOMER_ID,
        commitmentId: 'today-action-complete', baseVersion: completedTarget.version,
        expectedScheduleVersion: completedTarget.scheduleVersion!, completedAtUtc: NOW.toISOString(),
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.json()).toMatchObject({ executionStatus: 'completed', version: 1 });

      const nextId = 'commitment_33333333333333333333333333333333';
      const linked = await command(context, 'today-action-create-next', {
        type: 'CREATE_NEXT_COMMITMENT', previousCommitmentId: 'today-action-complete',
        expectedPreviousVersion: 1,
        commitment: {
          id: nextId, customerId: CUSTOMER_ID, matterId: MATTER_ID, personId: null,
          title: '确认采购评审人', kind: 'follow_up', ownerUserId: context.owner.id,
          confirmationStatus: 'not_required', scheduledAtUtc: null, dueAtUtc: null,
          timeZone: 'America/Los_Angeles', isAllDay: true, localDate: '2026-08-25',
          confirmationDueAtUtc: null, source: 'manual_today', sourceRef: null,
        },
      });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json()).toMatchObject({ commitmentId: nextId, linkedFromCommitmentId: 'today-action-complete' });

      const secondRegistration = await context.app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'today-action-other-tenant@example.test', password: 'test-password',
          name: 'Other Owner', tenantName: 'Other Tenant',
        },
      });
      expect(secondRegistration.statusCode, secondRegistration.body).toBe(200);
      const otherToken = secondRegistration.json<{ token: string }>().token;
      const tenantBoundary = await command(context, 'today-action-foreign-cancel', {
        type: 'CANCEL_COMMITMENT', customerId: CUSTOMER_ID,
        commitmentId: 'today-action-cancel', baseVersion: 0, expectedScheduleVersion: 0,
        canceledAtUtc: NOW.toISOString(),
      }, otherToken);
      expect(tenantBoundary.statusCode).toBe(404);

      const canceled = await command(context, 'today-action-cancel', {
        type: 'CANCEL_COMMITMENT', customerId: CUSTOMER_ID,
        commitmentId: 'today-action-cancel', baseVersion: 0, expectedScheduleVersion: 0,
        canceledAtUtc: NOW.toISOString(), reason: '材料路线已调整',
      });
      expect(canceled.statusCode, canceled.body).toBe(200);
      expect(canceled.json()).toMatchObject({ executionStatus: 'canceled', version: 1 });

      expect(await context.prisma.planAction.findUniqueOrThrow({
        where: { id: 'today-action-missed' },
      })).toMatchObject({ executionStatus: 'planned' });
      expect(findItem(await today(context), 'today-action-missed').time.relation).toBe('overdue');
      const missed = await command(context, 'today-action-missed', {
        type: 'MARK_COMMITMENT_MISSED', customerId: CUSTOMER_ID,
        commitmentId: 'today-action-missed', baseVersion: 0, expectedScheduleVersion: 0,
        missedAtUtc: NOW.toISOString(),
      });
      expect(missed.statusCode, missed.body).toBe(200);
      expect(missed.json()).toMatchObject({ executionStatus: 'missed', version: 1 });

      const rescheduleAudit = await context.prisma.auditEvent.findFirstOrThrow({
        where: {
          tenantId: context.tenant.id, entityId: 'today-action-pending', action: 'commitment_rescheduled',
        },
      });
      expect(JSON.parse(rescheduleAudit.metadata)).toMatchObject({
        fromScheduleVersion: 0,
        toScheduleVersion: 1,
        previousConfirmation: { status: 'confirmed', stale: true },
      });
      const actions = (await context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id, entityKind: 'commitment' },
        select: { action: true },
      })).map((event) => event.action);
      expect(actions).toEqual(expect.arrayContaining([
        'commitment_confirmed', 'commitment_rescheduled', 'commitment_declined',
        'commitment_completed', 'commitment_created', 'commitment_next_linked',
        'commitment_canceled', 'commitment_missed',
      ]));
    } finally {
      await context.cleanup();
    }
  });
});
