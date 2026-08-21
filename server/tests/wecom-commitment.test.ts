import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from './helpers/testApp.js';
import { enc } from '../src/ai.js';

const outbound = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../src/security/outboundUrl.js', () => ({
  deploymentOutboundPolicy: () => ({}),
  fetchOutbound: outbound.fetch,
}));

import { syncCommitmentToWeCom } from '../src/wecom.js';

describe('CORE-108 Commitment WeCom calendar consumer', () => {
  it('uses generic UTC schedule and stable owner, adopts the legacy map, then deletes on completion', async () => {
    const context = await createTestContext();
    try {
      const corpId = `corp-${randomUUID()}`;
      const accountId = 'wecom-commitment-customer';
      const matterId = 'wecom-commitment-matter';
      const commitmentId = 'wecom-commitment-id';
      await context.prisma.weComConfig.create({ data: {
        tenantId: context.tenant.id, corpId, agentId: '100001', secretEnc: enc('secret'),
      } });
      await context.prisma.weComUserBind.create({ data: {
        id: 'wecom-commitment-bind', tenantId: context.tenant.id,
        userId: context.owner.id, wecomUserid: 'wx-owner',
      } });
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: '企微客户', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: matterId, tenantId: context.tenant.id, accountId, name: '企微事项', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项', lifecycleStatus: 'active',
      } });
      await context.prisma.planAction.create({ data: {
        id: commitmentId, tenantId: context.tenant.id, accountId, opportunityId: matterId,
        title: '通用承诺日程', startDate: '1999-01-01', endDate: '1999-01-01', half: 'eve',
        ownerId: 'legacy-name-must-not-be-used', ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        scheduledAtUtc: new Date('2026-09-10T02:00:00.000Z'),
        dueAtUtc: new Date('2026-09-10T03:30:00.000Z'),
        timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
        scheduleVersion: 4, version: 7,
      } });
      await context.prisma.scheduleSync.create({ data: {
        id: 'legacy-plan-map', tenantId: context.tenant.id, kind: 'plan_action', refId: commitmentId,
        wecomScheduleId: 'legacy-schedule-id', status: 'synced',
      } });

      outbound.fetch.mockReset();
      outbound.fetch
        .mockResolvedValueOnce({ status: 200, json: async () => ({ errcode: 0, access_token: 'commitment-token', expires_in: 7200 }) })
        .mockResolvedValueOnce({ status: 200, json: async () => ({ errcode: 0 }) });
      await syncCommitmentToWeCom(context.tenant.id, commitmentId);

      const updateCall = outbound.fetch.mock.calls[1];
      expect(String(updateCall?.[0])).toContain('/cgi-bin/oa/schedule/update');
      expect(JSON.parse(String(updateCall?.[1]?.body))).toMatchObject({
        schedule: {
          schedule_id: 'legacy-schedule-id',
          organizer: 'wx-owner',
          summary: '通用承诺日程',
          description: '客户：企微客户 · 事项：企微事项',
          start_time: Date.parse('2026-09-10T02:00:00.000Z') / 1000,
          end_time: Date.parse('2026-09-10T03:30:00.000Z') / 1000,
        },
      });
      expect(JSON.stringify(updateCall)).not.toContain('1999-01-01');
      await expect(context.prisma.scheduleSync.findUniqueOrThrow({ where: { id: 'legacy-plan-map' } }))
        .resolves.toMatchObject({ kind: 'commitment', status: 'synced', wecomScheduleId: 'legacy-schedule-id' });
      expect(await context.prisma.scheduleSync.count({ where: {
        tenantId: context.tenant.id, refId: commitmentId,
      } })).toBe(1);

      await context.prisma.planAction.update({ where: { id: commitmentId }, data: {
        executionStatus: 'completed', done: true, version: { increment: 1 },
      } });
      outbound.fetch.mockResolvedValueOnce({ status: 200, json: async () => ({ errcode: 0 }) });
      await syncCommitmentToWeCom(context.tenant.id, commitmentId);
      const deleteCall = outbound.fetch.mock.calls[2];
      expect(String(deleteCall?.[0])).toContain('/cgi-bin/oa/schedule/del');
      await expect(context.prisma.scheduleSync.findUniqueOrThrow({ where: { id: 'legacy-plan-map' } }))
        .resolves.toMatchObject({ kind: 'commitment', status: 'deleted' });
    } finally {
      await context.cleanup();
    }
  });
});
