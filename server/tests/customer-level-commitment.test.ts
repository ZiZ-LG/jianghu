import { describe, expect, it, vi } from 'vitest';
import { runPatrol } from '../src/jobs.js';
import { createTestContext } from './helpers/testApp.js';

const auth = (token: string, key?: string) => ({
  authorization: `Bearer ${token}`,
  ...(key ? { 'idempotency-key': key } : {}),
});

const commitmentId = (suffix: string) => `commitment_${suffix.padEnd(32, '0').slice(0, 32)}`;

describe('CORE-108 customer-level Commitment cutover', () => {
  it('projects only through generic state and fails closed in legacy/StrategyCard consumers', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'customer-level-account';
      const matterId = 'customer-level-sales-matter';
      const personId = 'customer-level-person';
      const id = commitmentId('d');
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: '客户级承诺客户', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: matterId, tenantId: context.tenant.id, accountId, name: '销售事项', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项', lifecycleStatus: 'active',
      } });
      await context.prisma.person.create({ data: {
        id: personId, tenantId: context.tenant.id, accountId, name: '客户联系人', title: '负责人',
      } });

      const created = await context.app.inject({
        method: 'POST', url: '/api/commands/commitment',
        headers: auth(context.token, 'customer-level-create-key'),
        payload: {
          type: 'CREATE_COMMITMENT',
          commitment: {
            id, customerId: accountId, matterId: null, personId,
            title: '客户级续约回访', kind: 'follow_up', ownerUserId: context.owner.id,
            confirmationStatus: 'not_required', scheduledAtUtc: null, dueAtUtc: null,
            timeZone: 'Asia/Shanghai', isAllDay: true, localDate: '2026-09-20',
            confirmationDueAtUtc: null, source: 'manual', sourceRef: null,
          },
        },
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json()).toMatchObject({ commitmentId: id, matterId: null, replayed: false });

      const state = await context.app.inject({
        method: 'GET', url: '/api/state', headers: auth(context.token),
      });
      expect(state.statusCode, state.body).toBe(200);
      const account = state.json<any>().accounts.find((row: any) => row.id === accountId);
      expect(account.commitments).toEqual([expect.objectContaining({
        id, customerId: accountId, matterId: null, personId,
      })]);
      expect(account.planActions).toEqual([]);

      for (const action of [
        { type: 'UPDATE_PLAN_ACTION', accId: accountId, actionId: id, patch: { title: 'legacy overwrite' } },
        { type: 'TOGGLE_PLAN_ACTION', accId: accountId, actionId: id, done: true },
        { type: 'DELETE_PLAN_ACTION', accId: accountId, actionId: id },
      ]) {
        const response = await context.app.inject({
          method: 'POST', url: '/api/mutate', headers: auth(context.token), payload: { action },
        });
        expect(response.statusCode, response.body).toBe(404);
      }
      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({
        title: '客户级续约回访', opportunityId: null, done: false, executionStatus: 'planned', version: 0,
      });

      const strategyCard = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: auth(context.token), payload: { action: {
          type: 'ADD_STRATEGY_CARD', accId: accountId, oppId: matterId,
          card: { id: 'customer-level-card', title: '不得引用客户级承诺', dispatchedActionIds: [id] },
        } },
      });
      expect(strategyCard.statusCode, strategyCard.body).toBe(404);
      expect(await context.prisma.strategyCard.count({ where: { tenantId: context.tenant.id } })).toBe(0);

      const wrongMatter = await context.app.inject({
        method: 'POST', url: '/api/commands/action-feedback',
        headers: auth(context.token, 'customer-level-wrong-matter'),
        payload: {
          accountId, opportunityId: matterId, actionId: id, outcome: 'up', occurredAt: '2026-09-20',
          baseVersion: 0, expectedScheduleVersion: 0,
        },
      });
      expect(wrongMatter.statusCode, wrongMatter.body).toBe(404);

      const feedback = await context.app.inject({
        method: 'POST', url: '/api/commands/action-feedback',
        headers: auth(context.token, 'customer-level-feedback'),
        payload: {
          accountId, opportunityId: null, actionId: id, outcome: 'up', occurredAt: '2026-09-20',
          baseVersion: 0, expectedScheduleVersion: 0,
        },
      });
      expect(feedback.statusCode, feedback.body).toBe(200);
      expect(feedback.json()).toEqual({ replayed: false });
      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({
        opportunityId: null, done: true, executionStatus: 'completed', version: 1,
      });
      expect(await context.prisma.evidenceEvent.count({ where: { tenantId: context.tenant.id } })).toBe(0);
      const audit = await context.prisma.auditEvent.findFirstOrThrow({ where: {
        tenantId: context.tenant.id, entityKind: 'commitment', entityId: id, action: 'action_feedback',
      } });
      expect(JSON.parse(audit.changedFields)).toEqual(['executionStatus', 'version', 'done', 'doneAt']);
      expect(audit.sourceRef).toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('creates and retires a customer-level due reminder without writing formal business state', async () => {
    const context = await createTestContext();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-21T04:00:00.000Z'));
    try {
      const accountId = 'customer-level-reminder-account';
      const id = commitmentId('e');
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: '客户级提醒客户', customerType: 1,
      } });
      await context.prisma.planAction.create({ data: {
        id, tenantId: context.tenant.id, accountId, opportunityId: null,
        title: '客户级到期承诺', ownerId: context.owner.id, ownerUserId: context.owner.id,
        startDate: '2026-08-20', endDate: '2026-08-20', localDate: '2026-08-20',
        executionStatus: 'planned', confirmationStatus: 'not_required',
        timeZone: 'Asia/Shanghai', isAllDay: true, scheduleVersion: 2, version: 0,
      } });
      const before = await context.prisma.planAction.findUniqueOrThrow({ where: { id } });

      await runPatrol();

      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id } })).resolves.toEqual(before);
      await expect(context.prisma.reminder.findUniqueOrThrow({ where: { tenantId_dedupeKey: {
        tenantId: context.tenant.id,
        dedupeKey: `${context.tenant.id}:${id}:commitment_due:2`,
      } } })).resolves.toMatchObject({
        accountId, opportunityId: null, entityId: id, kind: 'commitment_due', status: 'pending',
      });
      expect(await context.prisma.reminder.count({ where: {
        tenantId: context.tenant.id, kind: 'matter_without_next_commitment',
      } })).toBe(0);

      await context.prisma.planAction.update({ where: { id }, data: {
        executionStatus: 'canceled', version: { increment: 1 },
      } });
      await runPatrol();
      await expect(context.prisma.reminder.findUniqueOrThrow({ where: { tenantId_dedupeKey: {
        tenantId: context.tenant.id,
        dedupeKey: `${context.tenant.id}:${id}:commitment_due:2`,
      } } })).resolves.toMatchObject({ status: 'done' });
    } finally {
      vi.useRealTimers();
      await context.cleanup();
    }
  });
});
