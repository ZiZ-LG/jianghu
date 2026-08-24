import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TodayReadModelSchema,
  TodaySourceViewSchema,
  type InterventionItem,
} from '@jianghu/domain-contracts';
import { buildTodayReadModel } from '../src/today.js';
import { createTestContext } from './helpers/testApp.js';

describe('SAAS-103 Today read model', () => {
  it('serves the core read model only to authenticated commercial users without caching it', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const unauthenticated = await context.app.inject({ method: 'GET', url: '/api/today' });
      expect(unauthenticated.statusCode).toBe(401);
      expect(unauthenticated.json()).toEqual({ error: 'unauthorized' });

      const response = await context.app.inject({
        method: 'GET',
        url: '/api/today',
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(TodayReadModelSchema.safeParse(response.json()).success).toBe(true);
    } finally {
      await context.cleanup();
    }
  });

  it('prioritizes an overdue event outcome over its stale pending-confirmation reminder without writing missed', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      await context.prisma.account.create({ data: {
        id: 'today-overdue-pending-customer', tenantId: context.tenant.id,
        name: '逾期确认客户', primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'today-overdue-pending-matter', tenantId: context.tenant.id,
        accountId: 'today-overdue-pending-customer', name: '逾期确认事项',
        customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
        lifecycleStatus: 'active', primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.planAction.create({ data: {
        id: 'today-overdue-pending-commitment', tenantId: context.tenant.id,
        accountId: 'today-overdue-pending-customer', opportunityId: 'today-overdue-pending-matter',
        title: '已经发生但仍待确认的会议', kind: 'meeting', ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'pending',
        scheduledAtUtc: new Date('2026-08-23T17:00:00Z'),
        confirmationDueAtUtc: new Date('2026-08-23T16:00:00Z'),
        timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
      } });

      const model = await buildTodayReadModel({
        tenantId: context.tenant.id, userId: context.owner.id, role: 'owner',
      }, new Date('2026-08-23T19:00:00Z'), context.prisma);

      expect(model.sections[0].items).toEqual([]);
      expect(model.sections[1].items).toEqual([
        expect.objectContaining({
          reasonCode: 'commitment_due',
          time: expect.objectContaining({ relation: 'overdue' }),
          target: expect.objectContaining({ commitmentId: 'today-overdue-pending-commitment' }),
        }),
      ]);
      expect(await context.prisma.planAction.findUniqueOrThrow({
        where: { id: 'today-overdue-pending-commitment' },
      })).toMatchObject({ executionStatus: 'planned', confirmationStatus: 'pending' });
    } finally {
      await context.cleanup();
    }
  });

  it('drills into only the exact current source revision inside the live effective scope', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      await context.prisma.account.create({ data: {
        id: 'today-source-customer', tenantId: context.tenant.id, name: '来源客户',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'today-source-matter', tenantId: context.tenant.id, accountId: 'today-source-customer',
        name: '来源事项', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
        lifecycleStatus: 'active', primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.planAction.create({ data: {
        id: 'today-source-commitment', tenantId: context.tenant.id,
        accountId: 'today-source-customer', opportunityId: 'today-source-matter',
        title: '确认来源会议', kind: 'follow_up', ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'pending',
        scheduledAtUtc: new Date('2026-08-24T18:00:00Z'),
        confirmationDueAtUtc: new Date('2026-08-23T18:00:00Z'),
        timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
      } });

      const exactRef = {
        entityKind: 'commitment', entityId: 'today-source-commitment', version: 0, scheduleVersion: 0,
      };
      const exact = await context.app.inject({
        method: 'POST', url: '/api/today/source', payload: exactRef,
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(exact.statusCode, exact.body).toBe(200);
      expect(TodaySourceViewSchema.parse(exact.json())).toMatchObject({
        sourceRef: {
          entityKind: 'commitment', entityId: 'today-source-commitment', version: 0, scheduleVersion: 0,
        },
        customerId: 'today-source-customer',
        matterId: 'today-source-matter',
        label: '确认来源会议',
      });
      expect(exact.headers['cache-control']).toBe('private, no-store');

      const stale = await context.app.inject({
        method: 'POST', url: '/api/today/source', payload: { ...exactRef, version: 1 },
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(stale.statusCode).toBe(404);
      expect(stale.json()).toEqual({ error: '来源不存在或无权限' });

      const outOfRangeVersion = await context.app.inject({
        method: 'POST', url: '/api/today/source',
        payload: { ...exactRef, version: 999999999999999999999999 },
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(outOfRangeVersion.statusCode).toBe(400);
      expect(outOfRangeVersion.json()).toEqual({ error: '来源参数无效' });

      const scopedMember = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id, email: 'today-source-member@example.test',
        passwordHash: 'unused', name: 'Scoped member', role: 'member',
      } });
      await context.prisma.tenant.update({
        where: { id: context.tenant.id }, data: { dataScopePolicy: 'scoped' },
      });
      const scopedToken = context.app.jwt.sign({
        tenantId: context.tenant.id, userId: scopedMember.id, role: 'owner',
      });
      const hidden = await context.app.inject({
        method: 'POST', url: '/api/today/source', payload: exactRef,
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(hidden.statusCode).toBe(404);
      expect(hidden.json()).toEqual({ error: '来源不存在或无权限' });

      await context.prisma.opportunity.update({
        where: { id: 'today-source-matter' },
        data: { primaryOwnerUserId: scopedMember.id },
      });
      const matterSource = await context.app.inject({
        method: 'POST', url: '/api/today/source',
        payload: { entityKind: 'matter', entityId: 'today-source-matter', version: 0, scheduleVersion: null },
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(matterSource.statusCode).toBe(404);

      const visibleCommitment = await context.app.inject({
        method: 'POST', url: '/api/today/source', payload: exactRef,
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(visibleCommitment.statusCode, visibleCommitment.body).toBe(200);

      const customerContainerOnly = await context.app.inject({
        method: 'POST', url: '/api/today/source',
        payload: { entityKind: 'customer', entityId: 'today-source-customer', version: 0, scheduleVersion: null },
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(customerContainerOnly.statusCode).toBe(404);
      expect(customerContainerOnly.json()).toEqual({ error: '来源不存在或无权限' });

      const unsupportedCustomerSource = await context.app.inject({
        method: 'POST', url: '/api/today/source',
        payload: { entityKind: 'customer', entityId: 'today-source-customer', version: 0, scheduleVersion: null },
        headers: { authorization: `Bearer ${context.token}` },
      });
      expect(unsupportedCustomerSource.statusCode).toBe(404);

      await context.prisma.opportunity.create({ data: {
        id: 'today-gap-source-matter', tenantId: context.tenant.id, accountId: 'today-source-customer',
        name: '尚无下一步的事项', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
        lifecycleStatus: 'active', primaryOwnerUserId: scopedMember.id,
      } });
      await context.prisma.planAction.create({ data: {
        id: 'today-gap-declined-commitment', tenantId: context.tenant.id,
        accountId: 'today-source-customer', opportunityId: 'today-gap-source-matter',
        title: '已经拒绝的下一步', kind: 'follow_up', ownerUserId: scopedMember.id,
        executionStatus: 'planned', confirmationStatus: 'declined',
        scheduledAtUtc: new Date('2026-08-25T17:00:00Z'),
        timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
      } });
      const gapSourceRef = {
        entityKind: 'matter', entityId: 'today-gap-source-matter', version: 0, scheduleVersion: null,
      };
      const currentGap = await context.app.inject({
        method: 'POST', url: '/api/today/source', payload: gapSourceRef,
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(currentGap.statusCode, currentGap.body).toBe(200);

      await context.prisma.planAction.create({ data: {
        id: 'today-gap-filled-commitment', tenantId: context.tenant.id,
        accountId: 'today-source-customer', opportunityId: 'today-gap-source-matter',
        title: '已经补上的下一步', kind: 'follow_up', ownerUserId: scopedMember.id,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        scheduledAtUtc: new Date('2026-08-25T18:00:00Z'),
        timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
      } });
      const staleGap = await context.app.inject({
        method: 'POST', url: '/api/today/source', payload: gapSourceRef,
        headers: { authorization: `Bearer ${scopedToken}` },
      });
      expect(staleGap.statusCode).toBe(404);
    } finally {
      await context.cleanup();
    }
  });

  it('derives confirmation, due, no-next and completed interventions from formal scoped records', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const now = new Date('2026-08-23T19:00:00Z');
      const customerId = 'today-customer';
      const scheduledMatterId = 'today-scheduled-matter';
      const missingMatterId = 'today-missing-next-matter';
      await context.prisma.account.create({ data: {
        id: customerId,
        tenantId: context.tenant.id,
        name: '远山制造',
        categoryKey: null,
        customerType: null,
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: scheduledMatterId,
          tenantId: context.tenant.id,
          accountId: customerId,
          name: '方案交流',
          customerType: 1,
          pipelineStage: 'lead',
          engageStage: 'discover',
          lifecycleStatus: 'active',
          primaryOwnerUserId: context.owner.id,
        },
        {
          id: missingMatterId,
          tenantId: context.tenant.id,
          accountId: customerId,
          name: '续费准备',
          customerType: 1,
          pipelineStage: 'lead',
          engageStage: 'discover',
          lifecycleStatus: 'active',
          primaryOwnerUserId: context.owner.id,
        },
      ] });
      await context.prisma.planAction.createMany({ data: [
        {
          id: 'commitment-pending',
          tenantId: context.tenant.id,
          accountId: customerId,
          opportunityId: scheduledMatterId,
          title: '确认周一会议',
          kind: 'follow_up',
          ownerUserId: context.owner.id,
          executionStatus: 'planned',
          confirmationStatus: 'pending',
          scheduledAtUtc: new Date('2026-08-24T18:00:00Z'),
          timeZone: 'America/Los_Angeles',
          isAllDay: false,
          confirmationDueAtUtc: new Date('2026-08-23T18:00:00Z'),
          source: 'manual',
        },
        {
          id: 'commitment-overdue',
          tenantId: context.tenant.id,
          accountId: customerId,
          opportunityId: scheduledMatterId,
          title: '发送确认邮件',
          kind: 'follow_up',
          ownerUserId: context.owner.id,
          executionStatus: 'planned',
          confirmationStatus: 'not_required',
          scheduledAtUtc: new Date('2026-08-23T17:00:00Z'),
          timeZone: 'America/Los_Angeles',
          isAllDay: false,
          source: 'manual',
        },
        {
          id: 'commitment-tomorrow-all-day',
          tenantId: context.tenant.id,
          accountId: customerId,
          opportunityId: scheduledMatterId,
          title: '准备方案材料',
          kind: 'follow_up',
          ownerUserId: context.owner.id,
          executionStatus: 'planned',
          confirmationStatus: 'not_required',
          timeZone: 'America/Los_Angeles',
          isAllDay: true,
          localDate: '2026-08-24',
          source: 'manual',
        },
        {
          id: 'commitment-completed',
          tenantId: context.tenant.id,
          accountId: customerId,
          opportunityId: null,
          title: '完成客户回访',
          kind: 'follow_up',
          ownerUserId: context.owner.id,
          executionStatus: 'completed',
          confirmationStatus: 'not_required',
          timeZone: 'America/Los_Angeles',
          isAllDay: true,
          localDate: '2026-08-23',
          done: true,
          doneAt: '2026-08-23',
          source: 'manual',
        },
        {
          id: 'commitment-completed-timed',
          tenantId: context.tenant.id,
          accountId: customerId,
          opportunityId: scheduledMatterId,
          title: '完成定时电话回访',
          kind: 'follow_up',
          ownerUserId: context.owner.id,
          executionStatus: 'completed',
          confirmationStatus: 'not_required',
          scheduledAtUtc: new Date('2026-08-23T16:00:00Z'),
          timeZone: 'America/Los_Angeles',
          isAllDay: false,
          done: true,
          doneAt: '2026-08-23',
          source: 'manual',
        },
      ] });

      const model = await buildTodayReadModel({
        tenantId: context.tenant.id,
        userId: context.owner.id,
        role: 'owner',
      }, now, context.prisma);

      expect(model.generatedAtUtc).toBe('2026-08-23T19:00:00.000Z');
      expect(model.sections.map((section) => [section.key, section.label])).toEqual([
        ['pending_confirmation', '待确认'],
        ['follow_up', '待跟进'],
        ['completed', '已完成'],
      ]);
      expect(model.sections[0].items).toEqual([
        expect.objectContaining({
          section: 'pending_confirmation',
          reasonCode: 'confirmation_due',
          time: expect.objectContaining({ kind: 'instant', relation: 'overdue' }),
          suggestedAction: expect.objectContaining({ commandType: 'CONFIRM_COMMITMENT' }),
          target: expect.objectContaining({
            commitmentId: 'commitment-pending',
            version: 0,
            scheduleVersion: 0,
          }),
          sourceRefs: [{
            entityKind: 'commitment',
            entityId: 'commitment-pending',
            version: 0,
            scheduleVersion: 0,
          }],
        }),
      ]);
      expect(model.sections[1].items.map((item) => [
        item.reasonCode,
        item.target.entityId,
        item.time.kind,
        item.time.relation,
      ])).toEqual([
        ['commitment_due', 'commitment-overdue', 'instant', 'overdue'],
        ['matter_without_next_commitment', missingMatterId, 'observed', 'missing'],
        ['commitment_due', 'commitment-tomorrow-all-day', 'local_date', 'upcoming'],
      ]);
      expect(model.sections[1].items[1].suggestedAction).toMatchObject({
        kind: 'create_commitment',
        commandType: 'CREATE_COMMITMENT',
      });
      expect(model.sections[1].items[2].explanation).toBe('这条下一步将在明天进入跟进窗口。');
      expect(model.sections[2].items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          section: 'completed',
          reasonCode: 'commitment_completed',
          time: expect.objectContaining({ kind: 'local_date', relation: 'completed' }),
          target: expect.objectContaining({
            customerId,
            matterId: null,
            commitmentId: 'commitment-completed',
          }),
        }),
        expect.objectContaining({
          section: 'completed',
          reasonCode: 'commitment_completed',
          time: expect.objectContaining({ kind: 'local_date', relation: 'completed' }),
          target: expect.objectContaining({
            customerId,
            matterId: scheduledMatterId,
            commitmentId: 'commitment-completed-timed',
          }),
        }),
      ]));
      expect(model.sections[2].items).toHaveLength(2);

      const unsupportedCustomerProvider: InterventionItem = {
        id: 'today-provider-customer-source',
        section: 'follow_up',
        providerKey: 'customer.test',
        title: '客户级提示',
        context: { customerName: '远山制造', matterName: null },
        reasonCode: 'customer_notice',
        explanation: 'Customer 暂无可证明完整修订的来源版本，必须失败关闭。',
        sourceRefs: [{ entityKind: 'customer', entityId: customerId, version: 0, scheduleVersion: null }],
        observedAtUtc: now.toISOString(),
        ruleVersion: 'customer.test.v1',
        time: { kind: 'observed', atUtc: now.toISOString(), relation: 'missing', label: '等待处理' },
        suggestedAction: { kind: 'view_customer', label: '查看客户', commandType: null },
        target: {
          entityKind: 'customer', entityId: customerId, customerId,
          matterId: null, commitmentId: null, version: 0, scheduleVersion: null,
        },
      };
      const unsupported = await buildTodayReadModel({
        tenantId: context.tenant.id,
        userId: context.owner.id,
        role: 'owner',
      }, now, context.prisma, [unsupportedCustomerProvider]);
      expect(unsupported.sections[1].items.some((item) => item.id === unsupportedCustomerProvider.id)).toBe(false);

      const bulkProviderItems: InterventionItem[] = Array.from({ length: 201 }, (_, index) => ({
        id: `today-provider-bulk-${index}`,
        section: 'follow_up',
        providerKey: 'bulk.test',
        title: `批量提示 ${index}`,
        context: { customerName: '远山制造', matterName: '方案交流' },
        reasonCode: 'bulk_notice',
        explanation: '验证无分页契约时不得静默截断。',
        sourceRefs: [{ entityKind: 'commitment', entityId: 'commitment-pending', version: 0, scheduleVersion: 0 }],
        observedAtUtc: now.toISOString(),
        ruleVersion: 'bulk.test.v1',
        time: { kind: 'observed', atUtc: now.toISOString(), relation: 'missing', label: '等待处理' },
        suggestedAction: { kind: 'view_commitment', label: '查看下一步', commandType: null },
        target: {
          entityKind: 'commitment', entityId: 'commitment-pending', customerId,
          matterId: scheduledMatterId, commitmentId: 'commitment-pending', version: 0, scheduleVersion: 0,
        },
      }));
      const untruncated = await buildTodayReadModel({
        tenantId: context.tenant.id,
        userId: context.owner.id,
        role: 'owner',
      }, now, context.prisma, bulkProviderItems);
      expect(untruncated.sections[1].items.filter((item) => item.providerKey === 'bulk.test')).toHaveLength(201);
    } finally {
      await context.cleanup();
    }
  });

  it('keeps a valid long legacy Commitment id from taking down the Today feed', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const customerId = 'today-long-id-customer';
      const commitmentId = `legacy-${'x'.repeat(220)}`;
      const collisionId = `sha256-${createHash('sha256').update(commitmentId).digest('hex')}`;
      await context.prisma.account.create({ data: {
        id: customerId, tenantId: context.tenant.id, name: '长标识客户',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.planAction.create({ data: {
        id: commitmentId, tenantId: context.tenant.id, accountId: customerId,
        title: '长标识下一步', kind: 'follow_up', ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        scheduledAtUtc: new Date('2026-08-23T20:00:00Z'),
        timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
      } });
      await context.prisma.planAction.create({ data: {
        id: collisionId, tenantId: context.tenant.id, accountId: customerId,
        title: '命名空间碰撞下一步', kind: 'follow_up', ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        scheduledAtUtc: new Date('2026-08-23T20:30:00Z'),
        timeZone: 'America/Los_Angeles', isAllDay: false, source: 'manual',
      } });

      const model = await buildTodayReadModel({
        tenantId: context.tenant.id,
        userId: context.owner.id,
        role: 'owner',
      }, new Date('2026-08-23T19:00:00Z'), context.prisma);
      const item = model.sections[1].items.find((candidate) => candidate.target.entityId === commitmentId);
      const collisionItem = model.sections[1].items.find((candidate) => candidate.target.entityId === collisionId);
      expect(item).toBeDefined();
      expect(collisionItem).toBeDefined();
      expect(item!.id.length).toBeLessThanOrEqual(240);
      expect(item!.id).not.toBe(collisionItem!.id);
      expect(item!.sourceRefs[0]?.entityId).toBe(commitmentId);
    } finally {
      await context.cleanup();
    }
  });

  it('classifies dueAt and all-day rows across IANA local-midnight boundaries', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      await context.prisma.account.create({ data: {
        id: 'today-time-customer', tenantId: context.tenant.id, name: '时区客户',
        primaryOwnerUserId: context.owner.id,
      } });
      const row = (input: {
        id: string;
        timeZone: string;
        localDate?: string;
        scheduledAtUtc?: Date;
        dueAtUtc?: Date;
      }) => ({
        id: input.id,
        tenantId: context.tenant.id,
        accountId: 'today-time-customer',
        opportunityId: null,
        title: input.id,
        kind: 'follow_up',
        ownerUserId: context.owner.id,
        executionStatus: 'planned',
        confirmationStatus: 'not_required',
        timeZone: input.timeZone,
        isAllDay: Boolean(input.localDate),
        localDate: input.localDate ?? null,
        scheduledAtUtc: input.scheduledAtUtc ?? null,
        dueAtUtc: input.dueAtUtc ?? null,
        source: 'manual',
      });
      await context.prisma.planAction.createMany({ data: [
        row({
          id: 'la-midnight-timed', timeZone: 'America/Los_Angeles',
          scheduledAtUtc: new Date('2026-08-24T07:01:00Z'),
        }),
        row({ id: 'la-next-all-day', timeZone: 'America/Los_Angeles', localDate: '2026-08-24' }),
        row({ id: 'la-plus-two-all-day', timeZone: 'America/Los_Angeles', localDate: '2026-08-25' }),
        row({
          id: 'shanghai-due-priority', timeZone: 'Asia/Shanghai',
          scheduledAtUtc: new Date('2026-08-25T07:00:00Z'),
          dueAtUtc: new Date('2026-08-24T07:02:00Z'),
        }),
        row({ id: 'shanghai-overdue-all-day', timeZone: 'Asia/Shanghai', localDate: '2026-08-23' }),
      ] });
      const principal = {
        tenantId: context.tenant.id, userId: context.owner.id, role: 'owner' as const,
      };

      const beforeMidnight = await buildTodayReadModel(
        principal,
        new Date('2026-08-24T06:59:00Z'),
        context.prisma,
      );
      const beforeById = new Map(beforeMidnight.sections[1].items.map((item) => [item.target.entityId, item]));
      expect(beforeById.get('la-midnight-timed')?.time).toMatchObject({ relation: 'upcoming' });
      expect(beforeById.get('la-next-all-day')?.time).toMatchObject({ relation: 'upcoming', localDate: '2026-08-24' });
      expect(beforeById.has('la-plus-two-all-day')).toBe(false);
      expect(beforeById.get('shanghai-overdue-all-day')?.time).toMatchObject({ relation: 'overdue' });
      expect(beforeById.get('shanghai-due-priority')?.time).toMatchObject({
        relation: 'due', atUtc: '2026-08-24T07:02:00.000Z',
      });

      const afterMidnight = await buildTodayReadModel(
        principal,
        new Date('2026-08-24T07:01:00Z'),
        context.prisma,
      );
      const afterById = new Map(afterMidnight.sections[1].items.map((item) => [item.target.entityId, item]));
      expect(afterById.get('la-midnight-timed')?.time).toMatchObject({ relation: 'due' });
      expect(afterById.get('la-next-all-day')?.time).toMatchObject({ relation: 'due' });
      expect(afterById.get('la-plus-two-all-day')?.time).toMatchObject({ relation: 'upcoming' });
    } finally {
      await context.cleanup();
    }
  });

  it('reuses the live effective scope for core and future-provider items without changing sections', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const now = new Date('2026-08-23T19:00:00Z');
      const actor = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: 'today-scoped-actor@example.test',
        passwordHash: 'unused',
        name: 'Scoped actor',
        role: 'member',
      } });
      const other = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: 'today-other-member@example.test',
        passwordHash: 'unused',
        name: 'Other member',
        role: 'member',
      } });
      const foreignTenant = await context.prisma.tenant.create({ data: {
        id: 'today-foreign-tenant',
        name: 'Foreign tenant',
        dataScopePolicy: 'scoped',
      } });
      await context.prisma.tenant.update({
        where: { id: context.tenant.id },
        data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.account.createMany({ data: [
        {
          id: 'today-owned-customer', tenantId: context.tenant.id, name: 'Owned customer',
          primaryOwnerUserId: actor.id,
        },
        {
          id: 'today-matter-parent', tenantId: context.tenant.id, name: 'Matter parent',
          primaryOwnerUserId: other.id,
        },
        {
          id: 'today-hidden-customer', tenantId: context.tenant.id, name: 'Hidden customer',
          primaryOwnerUserId: other.id,
        },
        {
          id: 'today-foreign-customer', tenantId: foreignTenant.id, name: 'Foreign customer',
          primaryOwnerUserId: actor.id,
        },
      ] });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: 'today-owned-matter', tenantId: context.tenant.id, accountId: 'today-matter-parent',
          name: 'Owned matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
          lifecycleStatus: 'active', primaryOwnerUserId: actor.id,
        },
        {
          id: 'today-hidden-sibling', tenantId: context.tenant.id, accountId: 'today-matter-parent',
          name: 'Hidden sibling', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
          lifecycleStatus: 'active', primaryOwnerUserId: other.id,
        },
      ] });
      const planned = (input: {
        id: string;
        tenantId: string;
        accountId: string;
        opportunityId?: string;
        ownerUserId: string;
      }) => ({
        ...input,
        opportunityId: input.opportunityId ?? null,
        title: input.id,
        kind: 'follow_up',
        executionStatus: 'planned',
        confirmationStatus: 'not_required',
        timeZone: 'America/Los_Angeles',
        isAllDay: true,
        localDate: '2026-08-23',
        source: 'manual',
      });
      await context.prisma.planAction.createMany({ data: [
        planned({
          id: 'today-visible-account-commitment', tenantId: context.tenant.id,
          accountId: 'today-owned-customer', ownerUserId: actor.id,
        }),
        planned({
          id: 'today-visible-matter-commitment', tenantId: context.tenant.id,
          accountId: 'today-matter-parent', opportunityId: 'today-owned-matter', ownerUserId: actor.id,
        }),
        planned({
          id: 'today-hidden-sibling-commitment', tenantId: context.tenant.id,
          accountId: 'today-matter-parent', opportunityId: 'today-hidden-sibling', ownerUserId: other.id,
        }),
        planned({
          id: 'today-hidden-account-commitment', tenantId: context.tenant.id,
          accountId: 'today-hidden-customer', ownerUserId: other.id,
        }),
        planned({
          id: 'today-foreign-commitment', tenantId: foreignTenant.id,
          accountId: 'today-foreign-customer', ownerUserId: actor.id,
        }),
      ] });

      const providerItem = (
        id: string,
        commitmentId: string,
        version = 0,
        extraSourceRefs: InterventionItem['sourceRefs'] = [],
      ): InterventionItem => ({
        id,
        section: 'follow_up',
        providerKey: 'g64111.future',
        title: `Provider ${commitmentId}`,
        context: { customerName: 'Matter parent', matterName: 'Owned matter' },
        reasonCode: 'relationship_gap',
        explanation: '可选方法论提供者给出的可解释候选。',
        sourceRefs: [
          { entityKind: 'commitment', entityId: commitmentId, version, scheduleVersion: 0 },
          ...extraSourceRefs,
        ],
        observedAtUtc: now.toISOString(),
        ruleVersion: 'g64111.future.v1',
        time: { kind: 'observed', atUtc: now.toISOString(), relation: 'missing', label: '等待人工处理' },
        suggestedAction: { kind: 'review_signal', label: '查看提示', commandType: null },
        target: {
          entityKind: 'commitment', entityId: commitmentId, customerId: 'today-matter-parent',
          matterId: 'today-owned-matter', commitmentId, version, scheduleVersion: 0,
        },
      });
      const extras = [
        providerItem('today-provider-visible', 'today-visible-matter-commitment'),
        providerItem('today-provider-hidden', 'today-hidden-sibling-commitment'),
        providerItem('today-provider-hidden-source', 'today-visible-matter-commitment', 0, [{
          entityKind: 'commitment', entityId: 'today-hidden-sibling-commitment', version: 0, scheduleVersion: 0,
        }]),
        providerItem('today-provider-duplicate', 'today-visible-matter-commitment'),
        { ...providerItem('today-provider-duplicate', 'today-visible-matter-commitment'), section: 'pending_confirmation' },
        { id: 'malformed-provider-item' },
      ];

      const principalWithStaleRole = {
        tenantId: context.tenant.id,
        userId: actor.id,
        role: 'owner' as const,
      };
      const model = await buildTodayReadModel(principalWithStaleRole, now, context.prisma, extras);
      expect(model.sections.map(({ key, label }) => [key, label])).toEqual([
        ['pending_confirmation', '待确认'],
        ['follow_up', '待跟进'],
        ['completed', '已完成'],
      ]);
      expect(model.sections[1].items.map((item) => item.id).sort()).toEqual([
        'today-provider-visible',
        'today-provider-duplicate',
        'today:commitment_due:raw:today-visible-account-commitment:v0:s0',
        'today:commitment_due:raw:today-visible-matter-commitment:v0:s0',
      ].sort());

      await context.prisma.planAction.update({
        where: { id: 'today-visible-matter-commitment' },
        data: { version: { increment: 1 } },
      });
      const staleProvider = await buildTodayReadModel(principalWithStaleRole, now, context.prisma, extras);
      expect(staleProvider.sections[1].items.some((item) => item.id.startsWith('today-provider-'))).toBe(false);

      const currentProvider = await buildTodayReadModel(principalWithStaleRole, now, context.prisma, [
        providerItem('today-provider-current', 'today-visible-matter-commitment', 1),
      ]);
      expect(currentProvider.sections[1].items.some((item) => item.id === 'today-provider-current')).toBe(true);

      await context.prisma.account.update({
        where: { id: 'today-owned-customer' }, data: { primaryOwnerUserId: other.id },
      });
      await context.prisma.opportunity.update({
        where: { id: 'today-owned-matter' }, data: { primaryOwnerUserId: other.id },
      });
      const revoked = await buildTodayReadModel(principalWithStaleRole, now, context.prisma, extras);
      expect(revoked.sections.every((section) => section.items.length === 0)).toBe(true);
    } finally {
      await context.cleanup();
    }
  });

  it('replaces the prior intervention identity and source revision after a schedule change', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const now = new Date('2026-08-23T19:00:00Z');
      await context.prisma.account.create({ data: {
        id: 'today-rescheduled-customer', tenantId: context.tenant.id, name: 'Rescheduled customer',
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.planAction.create({ data: {
        id: 'today-rescheduled-commitment', tenantId: context.tenant.id,
        accountId: 'today-rescheduled-customer', opportunityId: null,
        title: '准备客户材料', kind: 'follow_up', ownerUserId: context.owner.id,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        timeZone: 'America/Los_Angeles', isAllDay: true, localDate: '2026-08-23', source: 'manual',
      } });
      const principal = {
        tenantId: context.tenant.id, userId: context.owner.id, role: 'owner' as const,
      };

      const before = await buildTodayReadModel(principal, now, context.prisma);
      expect(before.sections[1].items[0]).toMatchObject({
        id: 'today:commitment_due:raw:today-rescheduled-commitment:v0:s0',
        sourceRefs: [{
          entityKind: 'commitment', entityId: 'today-rescheduled-commitment', version: 0, scheduleVersion: 0,
        }],
        time: { kind: 'local_date', localDate: '2026-08-23', relation: 'due' },
      });

      await context.prisma.planAction.update({
        where: { id: 'today-rescheduled-commitment' },
        data: { localDate: '2026-08-24', version: { increment: 1 }, scheduleVersion: { increment: 1 } },
      });
      const after = await buildTodayReadModel(principal, now, context.prisma);
      expect(after.sections[1].items).toEqual([
        expect.objectContaining({
          id: 'today:commitment_due:raw:today-rescheduled-commitment:v1:s1',
          sourceRefs: [{
            entityKind: 'commitment', entityId: 'today-rescheduled-commitment', version: 1, scheduleVersion: 1,
          }],
          time: expect.objectContaining({ kind: 'local_date', localDate: '2026-08-24', relation: 'upcoming' }),
        }),
      ]);
      expect(after.sections[1].items.some((item) => item.id === before.sections[1].items[0].id)).toBe(false);
    } finally {
      await context.cleanup();
    }
  });
});
