import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';

const headers = (token: string, key: string) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

describe('CORE-108 action-feedback Commitment adapter', () => {
  it('uses generic version/schedule CAS and audits the Commitment authority', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'feedback-customer';
      const matterId = 'feedback-matter';
      const personId = 'feedback-person';
      const commitmentId = 'feedback-commitment';
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: '反馈客户', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: matterId, tenantId: context.tenant.id, accountId, name: '反馈事项', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项', lifecycleStatus: 'active',
      } });
      await context.prisma.person.create({ data: {
        id: personId, tenantId: context.tenant.id, accountId, name: '反馈联系人', title: '负责人',
      } });
      await context.prisma.planAction.create({ data: {
        id: commitmentId, tenantId: context.tenant.id, accountId, opportunityId: matterId,
        personId, title: '已发生的客户互动', startDate: '2026-08-21', endDate: '2026-08-21',
        ownerId: context.owner.id, ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        isAllDay: true, localDate: '2026-08-21', timeZone: 'Asia/Shanghai',
        version: 2, scheduleVersion: 1,
      } });
      const payload = {
        accountId, opportunityId: matterId, actionId: commitmentId,
        outcome: 'up', occurredAt: '2026-08-21',
        baseVersion: 2, expectedScheduleVersion: 1,
      };

      const stale = await context.app.inject({
        method: 'POST', url: '/api/commands/action-feedback',
        headers: headers(context.token, 'feedback-stale-version'),
        payload: { ...payload, baseVersion: 1 },
      });
      expect(stale.statusCode, stale.body).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'commitment_version_conflict' });
      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id: commitmentId } }))
        .resolves.toMatchObject({ executionStatus: 'planned', version: 2, scheduleVersion: 1 });

      const first = await context.app.inject({
        method: 'POST', url: '/api/commands/action-feedback',
        headers: headers(context.token, 'feedback-current-version'), payload,
      });
      const replay = await context.app.inject({
        method: 'POST', url: '/api/commands/action-feedback',
        headers: headers(context.token, 'feedback-current-version'), payload,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ replayed: false, evidenceId: expect.any(String) });
      expect(replay.json()).toEqual({ ...first.json(), replayed: true });
      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id: commitmentId } }))
        .resolves.toMatchObject({ executionStatus: 'completed', done: true, version: 3, scheduleVersion: 1 });
      await expect(context.prisma.auditEvent.findFirstOrThrow({ where: {
        tenantId: context.tenant.id, action: 'action_feedback', entityId: commitmentId,
      } })).resolves.toMatchObject({
        entityKind: 'commitment',
        changedFields: JSON.stringify(['executionStatus', 'version', 'done', 'doneAt', 'evidenceId']),
      });
    } finally {
      await context.cleanup();
    }
  });

  it('rechecks the current actor role inside the transaction', async () => {
    const context = await createTestContext();
    try {
      const viewer = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: `feedback-downgrade-${randomUUID()}@example.test`,
        passwordHash: 'unused', name: '反馈成员', role: 'member',
      } });
      const staleMemberToken = context.app.jwt.sign({
        userId: viewer.id, tenantId: context.tenant.id, role: 'member',
      });
      await context.prisma.user.update({ where: { id: viewer.id }, data: { role: 'viewer' } });

      const response = await context.app.inject({
        method: 'POST', url: '/api/commands/action-feedback',
        headers: headers(staleMemberToken, 'feedback-role-downgrade'),
        payload: {
          accountId: 'missing', opportunityId: 'missing', actionId: 'missing',
          outcome: 'flat', occurredAt: '2026-08-21', baseVersion: 0, expectedScheduleVersion: 0,
        },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(await context.prisma.commandRun.count({ where: {
        tenantId: context.tenant.id, kind: 'action-feedback',
      } })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
