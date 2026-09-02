import { describe, expect, it } from 'vitest';
import type { CommitmentCommand, QuickCaptureCommand } from '@jianghu/domain-contracts';
import { buildTodayReadModel } from '../src/today.js';
import { createTestContext } from './helpers/testApp.js';

const NOW = new Date('2026-08-23T19:00:00.000Z');
const CUSTOMER_ID = 'customer_11111111111111111111111111111111';
const COMMITMENT_ID = 'commitment_22222222222222222222222222222222';
const NEXT_COMMITMENT_ID = 'commitment_33333333333333333333333333333333';

const auth = (token: string, key?: string) => ({
  authorization: `Bearer ${token}`,
  ...(key ? { 'idempotency-key': key } : {}),
});

async function commitmentCommand(
  context: Awaited<ReturnType<typeof createTestContext>>,
  key: string,
  payload: CommitmentCommand,
) {
  return context.app.inject({
    method: 'POST',
    url: '/api/commands/commitment',
    headers: auth(context.token, key),
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

function findCommitmentItem(
  model: Awaited<ReturnType<typeof today>>,
  commitmentId: string,
) {
  const item = model.sections.flatMap((section) => section.items)
    .find((candidate) => candidate.target.commitmentId === commitmentId);
  if (!item) throw new Error(`missing Today item for ${commitmentId}`);
  return item;
}

describe('SAAS-106 commercial Free first-day stage gate', () => {
  it('closes Quick Capture through Today without WorkBuddy, methodology, Matter or hidden writes', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const me = await context.app.inject({
        method: 'GET', url: '/api/me', headers: auth(context.token),
      });
      expect(me.statusCode, me.body).toBe(200);
      expect(me.json().product).toMatchObject({
        valid: true,
        edition: 'commercial',
        shell: 'commercial',
        policy: { entitlements: ['crm.core'], permissions: [] },
      });
      expect(me.json().product.navigation.map((entry: { id: string }) => entry.id)).toEqual([
        'today', 'customers', 'matters', 'quick-capture',
      ]);

      const denied = await Promise.all([
        context.app.inject({
          method: 'POST', url: '/api/mcp', headers: auth(context.token),
          payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        }),
        context.app.inject({
          method: 'POST', url: '/api/commands/methodology', headers: auth(context.token), payload: {},
        }),
        context.app.inject({
          method: 'POST', url: '/api/mutate', headers: auth(context.token), payload: { action: {
            type: 'SET_ROLE', accId: 'missing-account', oppId: 'missing-opportunity',
            personId: 'missing-person', patch: { role: 'D' },
          } },
        }),
      ]);
      for (const response of denied) {
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toEqual({ error: '能力未启用', code: 'capability_denied' });
      }
      expect(await context.prisma.account.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.opportunity.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id } })).toBe(0);

      const quickCapture: QuickCaptureCommand = {
        customer: {
          mode: 'create',
          command: {
            type: 'CREATE_CUSTOMER',
            customer: {
              id: CUSTOMER_ID,
              name: '远山制造',
              categoryKey: null,
              primaryOwnerUserId: context.owner.id,
            },
          },
        },
        commitment: {
          type: 'CREATE_COMMITMENT',
          commitment: {
            id: COMMITMENT_ID,
            customerId: CUSTOMER_ID,
            matterId: null,
            personId: null,
            title: '确认下周方案交流时间',
            kind: 'follow_up',
            ownerUserId: context.owner.id,
            confirmationStatus: 'pending',
            scheduledAtUtc: '2026-08-24T18:00:00.000Z',
            dueAtUtc: null,
            timeZone: 'America/Los_Angeles',
            isAllDay: false,
            localDate: null,
            confirmationDueAtUtc: '2026-08-23T18:00:00.000Z',
            source: 'manual_quick_capture',
            sourceRef: null,
            hypothesisRef: null,
          },
        },
      };
      const captured = await context.app.inject({
        method: 'POST',
        url: '/api/commands/quick-capture',
        headers: auth(context.token, 'g3-first-day-quick-capture'),
        payload: quickCapture,
      });
      expect(captured.statusCode, captured.body).toBe(200);
      expect(captured.json()).toMatchObject({
        customer: {
          customerId: CUSTOMER_ID, categoryKey: null,
          primaryOwnerUserId: context.owner.id, version: 0, undoable: false,
        },
        commitment: {
          commitmentId: COMMITMENT_ID, customerId: CUSTOMER_ID, matterId: null,
          confirmationStatus: 'pending', executionStatus: 'planned',
          version: 0, scheduleVersion: 0, undoable: false,
        },
        replayed: false,
      });
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: CUSTOMER_ID } }))
        .resolves.toMatchObject({
          tenantId: context.tenant.id,
          categoryKey: null,
          customerType: null,
          primaryOwnerUserId: context.owner.id,
        });
      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id: COMMITMENT_ID } }))
        .resolves.toMatchObject({
          tenantId: context.tenant.id,
          accountId: CUSTOMER_ID,
          opportunityId: null,
          personId: null,
          confirmationStatus: 'pending',
          source: 'manual_quick_capture',
        });

      const initialItem = findCommitmentItem(await today(context), COMMITMENT_ID);
      expect(initialItem).toMatchObject({
        section: 'pending_confirmation',
        providerKey: 'core.today',
        reasonCode: 'confirmation_due',
        observedAtUtc: NOW.toISOString(),
        ruleVersion: 'core.today.v1',
        sourceRefs: [{
          entityKind: 'commitment', entityId: COMMITMENT_ID, version: 0, scheduleVersion: 0,
        }],
        time: {
          kind: 'instant', atUtc: '2026-08-23T18:00:00.000Z',
          timeZone: 'America/Los_Angeles', relation: 'overdue', label: '确认已逾期',
        },
        suggestedAction: {
          kind: 'confirm_commitment', label: '确认或调整时间', commandType: 'CONFIRM_COMMITMENT',
        },
        target: {
          entityKind: 'commitment', entityId: COMMITMENT_ID,
          customerId: CUSTOMER_ID, matterId: null, commitmentId: COMMITMENT_ID,
          version: 0, scheduleVersion: 0,
        },
      });
      const initialSource = initialItem.sourceRefs[0]!;
      const initialSourceView = await context.app.inject({
        method: 'POST', url: '/api/today/source', headers: auth(context.token), payload: initialSource,
      });
      expect(initialSourceView.statusCode, initialSourceView.body).toBe(200);

      const confirmed = await commitmentCommand(context, 'g3-first-day-confirm', {
        type: 'CONFIRM_COMMITMENT', customerId: CUSTOMER_ID, commitmentId: COMMITMENT_ID,
        baseVersion: 0, expectedScheduleVersion: 0, confirmedAtUtc: NOW.toISOString(),
      });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      expect(confirmed.json()).toMatchObject({ version: 1, scheduleVersion: 0, confirmationStatus: 'confirmed' });
      const confirmedSource = findCommitmentItem(await today(context), COMMITMENT_ID).sourceRefs[0]!;

      const rescheduled = await commitmentCommand(context, 'g3-first-day-reschedule', {
        type: 'RESCHEDULE_COMMITMENT', customerId: CUSTOMER_ID, commitmentId: COMMITMENT_ID,
        baseVersion: 1, expectedScheduleVersion: 0,
        schedule: {
          scheduledAtUtc: '2026-08-24T20:00:00.000Z',
          dueAtUtc: null,
          timeZone: 'America/Los_Angeles',
          isAllDay: false,
          localDate: null,
          confirmationDueAtUtc: '2026-08-23T18:30:00.000Z',
          requiresConfirmation: true,
        },
      });
      expect(rescheduled.statusCode, rescheduled.body).toBe(200);
      expect(rescheduled.json()).toMatchObject({ version: 2, scheduleVersion: 1, confirmationStatus: 'pending' });

      const staleSource = await context.app.inject({
        method: 'POST', url: '/api/today/source', headers: auth(context.token), payload: confirmedSource,
      });
      expect(staleSource.statusCode).toBe(404);
      const staleCommand = await commitmentCommand(context, 'g3-first-day-stale-confirm', {
        type: 'CONFIRM_COMMITMENT', customerId: CUSTOMER_ID, commitmentId: COMMITMENT_ID,
        baseVersion: 1, expectedScheduleVersion: 0, confirmedAtUtc: NOW.toISOString(),
      });
      expect(staleCommand.statusCode, staleCommand.body).toBe(409);

      const rescheduledItem = findCommitmentItem(await today(context), COMMITMENT_ID);
      expect(rescheduledItem).toMatchObject({
        reasonCode: 'confirmation_due',
        sourceRefs: [{
          entityKind: 'commitment', entityId: COMMITMENT_ID, version: 2, scheduleVersion: 1,
        }],
        target: { version: 2, scheduleVersion: 1 },
      });
      const reconfirmed = await commitmentCommand(context, 'g3-first-day-reconfirm', {
        type: 'CONFIRM_COMMITMENT', customerId: CUSTOMER_ID, commitmentId: COMMITMENT_ID,
        baseVersion: 2, expectedScheduleVersion: 1, confirmedAtUtc: NOW.toISOString(),
      });
      expect(reconfirmed.statusCode, reconfirmed.body).toBe(200);
      expect(reconfirmed.json()).toMatchObject({ version: 3, scheduleVersion: 1, confirmationStatus: 'confirmed' });

      const completed = await commitmentCommand(context, 'g3-first-day-complete', {
        type: 'COMPLETE_COMMITMENT', customerId: CUSTOMER_ID, commitmentId: COMMITMENT_ID,
        baseVersion: 3, expectedScheduleVersion: 1, completedAtUtc: NOW.toISOString(),
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(completed.json()).toMatchObject({ version: 4, scheduleVersion: 1, executionStatus: 'completed' });
      expect(findCommitmentItem(await today(context), COMMITMENT_ID)).toMatchObject({
        section: 'completed', reasonCode: 'commitment_completed',
        time: { relation: 'completed', label: '今天已完成' },
        suggestedAction: {
          kind: 'create_next_commitment', label: '补充下一步', commandType: 'CREATE_NEXT_COMMITMENT',
        },
        target: { version: 4, scheduleVersion: 1 },
      });

      const next = await commitmentCommand(context, 'g3-first-day-create-next', {
        type: 'CREATE_NEXT_COMMITMENT',
        previousCommitmentId: COMMITMENT_ID,
        expectedPreviousVersion: 4,
        commitment: {
          id: NEXT_COMMITMENT_ID,
          customerId: CUSTOMER_ID,
          matterId: null,
          personId: null,
          title: '整理并发送交流纪要',
          kind: 'follow_up',
          ownerUserId: context.owner.id,
          confirmationStatus: 'not_required',
          scheduledAtUtc: null,
          dueAtUtc: null,
          timeZone: 'America/Los_Angeles',
          isAllDay: true,
          localDate: '2026-08-25',
          confirmationDueAtUtc: null,
          source: 'manual_today',
          sourceRef: null,
        },
      });
      expect(next.statusCode, next.body).toBe(200);
      expect(next.json()).toMatchObject({
        commitmentId: NEXT_COMMITMENT_ID,
        customerId: CUSTOMER_ID,
        matterId: null,
        linkedFromCommitmentId: COMMITMENT_ID,
        version: 0,
        scheduleVersion: 0,
      });
      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id: COMMITMENT_ID } }))
        .resolves.toMatchObject({ nextCommitmentId: NEXT_COMMITMENT_ID, version: 5 });

      const actions = (await context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id }, select: { action: true },
      })).map((event) => event.action).sort();
      expect(actions).toEqual([
        'commitment_completed',
        'commitment_confirmed',
        'commitment_confirmed',
        'commitment_created',
        'commitment_created',
        'commitment_next_linked',
        'commitment_rescheduled',
        'customer_created',
      ]);

      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await context.prisma.methodologyPack.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.methodologyBinding.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.accessToken.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.syncRun.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.weComConfig.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.scheduleSync.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.opportunity.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      expect(await context.prisma.planAction.count({
        where: { tenantId: context.tenant.id, origin: 'workbuddy' },
      })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
