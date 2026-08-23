import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { QuickCaptureCommand } from '@jianghu/domain-contracts';
import { executeQuickCapture } from '../src/mutation/compoundCommands.js';
import { createTestContext } from './helpers/testApp.js';

const opaqueId = (prefix: string, suffix: string) => (
  `${prefix}_${createHash('sha256').update(suffix).digest('hex').slice(0, 32)}`
);

const auth = (token: string, key: string) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

const commitment = (customerId: string, id: string, ownerUserId: string) => ({
  type: 'CREATE_COMMITMENT' as const,
  commitment: {
    id,
    customerId,
    matterId: null,
    personId: null,
    title: '周四与客户交流方案',
    kind: 'follow_up' as const,
    ownerUserId,
    confirmationStatus: 'not_required' as const,
    scheduledAtUtc: '2026-08-27T07:00:00.000Z',
    dueAtUtc: null,
    timeZone: 'Asia/Shanghai',
    isAllDay: false as const,
    localDate: null,
    confirmationDueAtUtc: null,
    source: 'manual_quick_capture' as const,
    sourceRef: null,
  },
});

const inlinePayload = (customerId: string, commitmentId: string, ownerUserId: string): QuickCaptureCommand => ({
  customer: {
    mode: 'create',
    command: {
      type: 'CREATE_CUSTOMER',
      customer: {
        id: customerId,
        name: '远山制造',
        categoryKey: null,
        primaryOwnerUserId: ownerUserId,
      },
    },
  },
  commitment: commitment(customerId, commitmentId, ownerUserId),
});

async function send(
  context: Awaited<ReturnType<typeof createTestContext>>,
  payload: QuickCaptureCommand,
  key: string,
  token = context.token,
) {
  return context.app.inject({
    method: 'POST',
    url: '/api/commands/quick-capture',
    headers: auth(token, key),
    payload,
  });
}

async function createUser(
  context: Awaited<ReturnType<typeof createTestContext>>,
  role: 'member' | 'viewer',
) {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id,
    email: `${role}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name: role,
    role,
  } });
  return {
    user,
    token: context.app.jwt.sign({ userId: user.id, tenantId: context.tenant.id, role }),
  };
}

describe('SAAS-102 atomic Quick Capture command', () => {
  it('creates an inline Customer and customer-level Commitment once with two audits and one safe journal', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const customerId = opaqueId('customer', 'quick-inline-customer');
      const commitmentId = opaqueId('commitment', 'quick-inline-commitment');
      const payload = inlinePayload(customerId, commitmentId, context.owner.id);

      const first = await send(context, payload, 'quick-inline-stable-key');
      const replay = await send(context, payload, 'quick-inline-stable-key');

      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        customer: { customerId, categoryKey: null, primaryOwnerUserId: context.owner.id, version: 0, undoable: false },
        commitment: {
          commitmentId, customerId, matterId: null, executionStatus: 'planned',
          confirmationStatus: 'not_required', version: 0, scheduleVersion: 0, undoable: false,
        },
        replayed: false,
      });
      expect(replay.json()).toEqual({ ...first.json(), replayed: true });
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: customerId } })).resolves.toMatchObject({
        tenantId: context.tenant.id,
        categoryKey: null,
        customerType: null,
        primaryOwnerUserId: context.owner.id,
      });
      await expect(context.prisma.planAction.findUniqueOrThrow({ where: { id: commitmentId } })).resolves.toMatchObject({
        tenantId: context.tenant.id,
        accountId: customerId,
        opportunityId: null,
        ownerUserId: context.owner.id,
      });
      expect(await context.prisma.auditEvent.count({ where: {
        tenantId: context.tenant.id,
        entityId: { in: [customerId, commitmentId] },
      } })).toBe(2);
      const run = await context.prisma.commandRun.findFirstOrThrow({ where: {
        tenantId: context.tenant.id,
        kind: 'quick-capture',
      } });
      expect(await context.prisma.commandRun.count({ where: { tenantId: context.tenant.id } })).toBe(1);
      expect(run.resultSummary).not.toContain('远山制造');
      expect(run.resultSummary).not.toContain('周四与客户交流方案');
    } finally {
      await context.cleanup();
    }
  });

  it('rechecks the current database role before returning an idempotent replay', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const member = await createUser(context, 'member');
      const customerId = opaqueId('customer', 'quick-demoted-replay-customer');
      const commitmentId = opaqueId('commitment', 'quick-demoted-replay-commitment');
      const payload = inlinePayload(customerId, commitmentId, member.user.id);
      const key = 'quick-demoted-replay-stable';

      const first = await send(context, payload, key, member.token);
      expect(first.statusCode, first.body).toBe(200);

      await context.prisma.user.update({ where: { id: member.user.id }, data: { role: 'viewer' } });
      const replay = await send(context, payload, key, member.token);

      expect(replay.statusCode, replay.body).toBe(403);
      expect(await context.prisma.account.count({ where: { id: customerId } })).toBe(1);
      expect(await context.prisma.planAction.count({ where: { id: commitmentId } })).toBe(1);
      expect(await context.prisma.auditEvent.count({ where: {
        tenantId: context.tenant.id,
        entityId: { in: [customerId, commitmentId] },
      } })).toBe(2);
      expect(await context.prisma.commandRun.count({ where: {
        tenantId: context.tenant.id,
        actorId: member.user.id,
        kind: 'quick-capture',
      } })).toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects inline Customer self-assignment bypass without completed business writes', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const otherMember = await createUser(context, 'member');
      const customerId = opaqueId('customer', 'quick-other-owner-customer');
      const commitmentId = opaqueId('commitment', 'quick-other-owner-commitment');

      const response = await send(
        context,
        inlinePayload(customerId, commitmentId, otherMember.user.id),
        'quick-other-owner-denied-key',
      );

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ code: 'quick_capture_scope_forbidden' });
      expect(await context.prisma.account.count({ where: { id: customerId } })).toBe(0);
      expect(await context.prisma.planAction.count({ where: { id: commitmentId } })).toBe(0);
      expect(await context.prisma.auditEvent.count({ where: {
        tenantId: context.tenant.id,
        entityId: { in: [customerId, commitmentId] },
      } })).toBe(0);
      expect(await context.prisma.commandRun.count({ where: {
        tenantId: context.tenant.id,
        kind: 'quick-capture',
        status: 'completed',
      } })).toBe(0);
      await expect(context.prisma.commandRun.findFirstOrThrow({ where: {
        tenantId: context.tenant.id,
        kind: 'quick-capture',
      } })).resolves.toMatchObject({ status: 'failed', errorCode: 'quick_capture_scope_forbidden' });
    } finally {
      await context.cleanup();
    }
  });

  it('rejects forged Quick Capture provenance and oversized inline Customer names before command execution', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const customerId = opaqueId('customer', 'quick-contract-denied-customer');
      const commitmentId = opaqueId('commitment', 'quick-contract-denied-commitment');
      const valid = inlinePayload(customerId, commitmentId, context.owner.id);
      if (valid.customer.mode !== 'create') throw new Error('inline fixture must create a Customer');
      const forged = {
        ...valid,
        commitment: {
          ...valid.commitment,
          commitment: { ...valid.commitment.commitment, source: 'forged_import', sourceRef: 'fake-audit-ref' },
        },
      } as unknown as QuickCaptureCommand;
      const oversized = {
        ...valid,
        customer: {
          ...valid.customer,
          command: {
            ...valid.customer.command,
            customer: { ...valid.customer.command.customer, name: '客'.repeat(121) },
          },
        },
      } as unknown as QuickCaptureCommand;

      expect((await send(context, forged, 'quick-forged-source-key')).statusCode).toBe(400);
      expect((await send(context, oversized, 'quick-oversized-customer-key')).statusCode).toBe(400);
      expect(await context.prisma.account.count({ where: { id: customerId } })).toBe(0);
      expect(await context.prisma.planAction.count({ where: { id: commitmentId } })).toBe(0);
      expect(await context.prisma.commandRun.count({ where: { tenantId: context.tenant.id } })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('keeps even owner-role Quick Capture assigned to the current actor', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const otherMember = await createUser(context, 'member');
      const customerId = 'legacy-account-quick-owner-assignment';
      const commitmentId = opaqueId('commitment', 'quick-owner-assignment-denied');
      await context.prisma.account.create({ data: {
        id: customerId,
        tenantId: context.tenant.id,
        name: '既有客户',
        customerType: null,
        primaryOwnerUserId: context.owner.id,
      } });
      const payload: QuickCaptureCommand = {
        customer: { mode: 'existing', customerId },
        commitment: commitment(customerId, commitmentId, otherMember.user.id),
      };

      const response = await send(context, payload, 'quick-owner-assignment-denied-key');
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ code: 'quick_capture_scope_forbidden' });
      expect(await context.prisma.planAction.count({ where: { id: commitmentId } })).toBe(0);
      await expect(context.prisma.commandRun.findFirstOrThrow({ where: {
        tenantId: context.tenant.id,
        kind: 'quick-capture',
      } })).resolves.toMatchObject({ status: 'failed', errorCode: 'quick_capture_scope_forbidden' });
    } finally {
      await context.cleanup();
    }
  });

  it('creates a Commitment for an existing Customer without fabricating a Matter or Customer audit', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const customerId = 'legacy-account-quick-existing';
      const commitmentId = opaqueId('commitment', 'quick-existing-commitment');
      await context.prisma.account.create({ data: {
        id: customerId,
        tenantId: context.tenant.id,
        name: '既有客户',
        customerType: null,
        primaryOwnerUserId: context.owner.id,
      } });
      const payload: QuickCaptureCommand = {
        customer: { mode: 'existing', customerId },
        commitment: commitment(customerId, commitmentId, context.owner.id),
      };

      const response = await send(context, payload, 'quick-existing-stable-key');

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        customer: null,
        commitment: { commitmentId, customerId, matterId: null },
        replayed: false,
      });
      expect(await context.prisma.account.count({ where: { id: customerId } })).toBe(1);
      expect(await context.prisma.auditEvent.count({ where: {
        tenantId: context.tenant.id,
        entityKind: 'customer',
      } })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('rolls the inline Customer and its audit back when Commitment creation conflicts', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const existingCustomerId = 'legacy-collision-owner';
      const customerId = opaqueId('customer', 'quick-rollback-customer');
      const commitmentId = opaqueId('commitment', 'quick-rollback-commitment');
      await context.prisma.account.create({ data: {
        id: existingCustomerId,
        tenantId: context.tenant.id,
        name: '占用标识的客户',
        customerType: null,
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.planAction.create({ data: {
        id: commitmentId,
        tenantId: context.tenant.id,
        accountId: existingCustomerId,
        title: '已存在的承诺',
        ownerId: context.owner.id,
        ownerUserId: context.owner.id,
        startDate: '2026-08-27',
        endDate: '2026-08-27',
        scheduledAtUtc: new Date('2026-08-27T07:00:00.000Z'),
        isAllDay: false,
        localDate: null,
      } });

      const response = await send(
        context,
        inlinePayload(customerId, commitmentId, context.owner.id),
        'quick-rollback-stable-key',
      );

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json()).toMatchObject({ code: 'commitment_id_conflict' });
      expect(await context.prisma.account.count({ where: { id: customerId } })).toBe(0);
      expect(await context.prisma.auditEvent.count({ where: { entityId: customerId } })).toBe(0);
      await expect(context.prisma.commandRun.findFirstOrThrow({ where: { kind: 'quick-capture' } }))
        .resolves.toMatchObject({ status: 'failed', errorCode: 'commitment_id_conflict' });
      expect(await context.prisma.planAction.count({ where: { id: commitmentId } })).toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed for viewer, tenant boundary, and effective scoped Customer access', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const member = await createUser(context, 'member');
      const viewer = await createUser(context, 'viewer');
      await context.prisma.tenant.update({
        where: { id: context.tenant.id },
        data: { dataScopePolicy: 'scoped' },
      });
      const foreignCustomerId = 'scoped-foreign-customer';
      await context.prisma.account.create({ data: {
        id: foreignCustomerId,
        tenantId: context.tenant.id,
        name: '其他负责人的客户',
        customerType: null,
        primaryOwnerUserId: context.owner.id,
      } });
      const scopedPayload: QuickCaptureCommand = {
        customer: { mode: 'existing', customerId: foreignCustomerId },
        commitment: commitment(foreignCustomerId, opaqueId('commitment', 'quick-scoped-denied'), member.user.id),
      };
      const scoped = await send(context, scopedPayload, 'quick-scoped-denied-key', member.token);
      const viewed = await send(context, scopedPayload, 'quick-viewer-denied-key', viewer.token);
      expect(scoped.statusCode, scoped.body).toBe(404);
      expect(viewed.statusCode, viewed.body).toBe(403);

      const otherTenant = await context.prisma.tenant.create({ data: {
        id: `tenant-${randomUUID()}`,
        name: 'Other Tenant',
      } });
      const otherCustomerId = 'cross-tenant-quick-customer';
      await context.prisma.account.create({ data: {
        id: otherCustomerId,
        tenantId: otherTenant.id,
        name: '不可泄露客户',
        customerType: null,
      } });
      const crossPayload: QuickCaptureCommand = {
        customer: { mode: 'existing', customerId: otherCustomerId },
        commitment: commitment(otherCustomerId, opaqueId('commitment', 'quick-cross-denied'), context.owner.id),
      };
      const crossed = await send(context, crossPayload, 'quick-cross-denied-key');
      expect(crossed.statusCode, crossed.body).toBe(404);
      expect(JSON.stringify(crossed.json())).not.toContain('不可泄露客户');
      expect(await context.prisma.planAction.count()).toBe(0);
      expect(await context.prisma.commandRun.count({ where: {
        kind: 'quick-capture',
        status: 'failed',
      } })).toBe(2);
    } finally {
      await context.cleanup();
    }
  });

  it('allows scoped Matter capture but denies hidden Matters and Person data without full Customer scope', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const member = await createUser(context, 'member');
      await context.prisma.tenant.update({
        where: { id: context.tenant.id },
        data: { dataScopePolicy: 'scoped' },
      });
      const customerId = 'quick-matter-scope-customer';
      const visibleMatterId = 'quick-member-owned-matter';
      const hiddenMatterId = 'quick-hidden-matter';
      const personId = 'quick-customer-person';
      await context.prisma.account.create({ data: {
        id: customerId,
        tenantId: context.tenant.id,
        name: '事项级可见客户',
        customerType: null,
        primaryOwnerUserId: context.owner.id,
      } });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: visibleMatterId,
          tenantId: context.tenant.id,
          accountId: customerId,
          name: '成员负责事项',
          customerType: 1,
          pipelineStage: 'lead',
          engageStage: 'discover',
          primaryOwnerUserId: member.user.id,
        },
        {
          id: hiddenMatterId,
          tenantId: context.tenant.id,
          accountId: customerId,
          name: '不可见事项',
          customerType: 1,
          pipelineStage: 'lead',
          engageStage: 'discover',
          primaryOwnerUserId: context.owner.id,
        },
      ] });
      await context.prisma.person.create({ data: {
        id: personId,
        tenantId: context.tenant.id,
        accountId: customerId,
        name: '客户联系人',
        title: '负责人',
      } });

      const scopedCommand = (
        id: string,
        matterId: string,
        selectedPersonId: string | null,
      ): QuickCaptureCommand => {
        const base = commitment(customerId, id, member.user.id);
        return {
          customer: { mode: 'existing', customerId },
          commitment: {
            ...base,
            commitment: { ...base.commitment, matterId, personId: selectedPersonId },
          },
        };
      };
      const allowedId = opaqueId('commitment', 'quick-visible-matter');
      const hiddenId = opaqueId('commitment', 'quick-hidden-matter');
      const personDeniedId = opaqueId('commitment', 'quick-person-denied');

      const allowed = await send(
        context,
        scopedCommand(allowedId, visibleMatterId, null),
        'quick-visible-matter-key',
        member.token,
      );
      const hidden = await send(
        context,
        scopedCommand(hiddenId, hiddenMatterId, null),
        'quick-hidden-matter-key',
        member.token,
      );
      const personDenied = await send(
        context,
        scopedCommand(personDeniedId, visibleMatterId, personId),
        'quick-person-denied-key',
        member.token,
      );

      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.json()).toMatchObject({ commitment: { commitmentId: allowedId, matterId: visibleMatterId } });
      expect(hidden.statusCode, hidden.body).toBe(404);
      expect(personDenied.statusCode, personDenied.body).toBe(404);
      expect(await context.prisma.planAction.count({ where: { tenantId: context.tenant.id } })).toBe(1);
      expect(await context.prisma.planAction.count({ where: { id: { in: [hiddenId, personDeniedId] } } })).toBe(0);
      expect(await context.prisma.commandRun.count({ where: {
        tenantId: context.tenant.id,
        kind: 'quick-capture',
        status: 'failed',
      } })).toBe(2);
    } finally {
      await context.cleanup();
    }
  });

  it('fails before writes when core capability or either formal command is disabled', async () => {
    const malformed = await createTestContext({ productAccess: {} });
    try {
      const payload = inlinePayload(
        opaqueId('customer', 'quick-capability-customer'),
        opaqueId('commitment', 'quick-capability-commitment'),
        malformed.owner.id,
      );
      const denied = await send(malformed, payload, 'quick-capability-denied-key');
      expect(denied.statusCode, denied.body).toBe(403);
      expect(await malformed.prisma.account.count()).toBe(0);
      await expect(executeQuickCapture({
        tenantId: malformed.tenant.id,
        actorId: malformed.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'quick-direct-capability-denied',
        assertionMode: 'user_asserted',
      }, payload, malformed.prisma, { entitlements: [], permissions: [] }))
        .rejects.toMatchObject({ code: 'capability_denied' });
      expect(await malformed.prisma.account.count()).toBe(0);
    } finally {
      await malformed.cleanup();
    }

    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    const previousCustomer = process.env.CUSTOMER_COMMANDS_ENABLED;
    const previousCommitment = process.env.COMMITMENT_COMMANDS_ENABLED;
    try {
      const payload = inlinePayload(
        opaqueId('customer', 'quick-disabled-customer'),
        opaqueId('commitment', 'quick-disabled-commitment'),
        context.owner.id,
      );
      process.env.CUSTOMER_COMMANDS_ENABLED = '0';
      expect((await send(context, payload, 'quick-customer-disabled-key')).statusCode).toBe(503);
      delete process.env.CUSTOMER_COMMANDS_ENABLED;
      process.env.COMMITMENT_COMMANDS_ENABLED = '0';
      expect((await send(context, payload, 'quick-commitment-disabled-key')).statusCode).toBe(503);
      expect(await context.prisma.account.count()).toBe(0);
      expect(await context.prisma.planAction.count()).toBe(0);
      expect(await context.prisma.commandRun.count()).toBe(0);
    } finally {
      if (previousCustomer === undefined) delete process.env.CUSTOMER_COMMANDS_ENABLED;
      else process.env.CUSTOMER_COMMANDS_ENABLED = previousCustomer;
      if (previousCommitment === undefined) delete process.env.COMMITMENT_COMMANDS_ENABLED;
      else process.env.COMMITMENT_COMMANDS_ENABLED = previousCommitment;
      await context.cleanup();
    }
  });
});
