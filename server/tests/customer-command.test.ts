import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CommandContext, CustomerCreateCommand } from '@jianghu/domain-contracts';
import { executeCustomerCommand } from '../src/mutation/customers.js';
import { createTestContext } from './helpers/testApp.js';

const customerId = (suffix: string) => `customer_${createHash('sha256').update(suffix).digest('hex').slice(0, 32)}`;

const headers = (token: string, key: string) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

const createPayload = (
  id: string,
  name = '远山制造',
  categoryKey: string | null = null,
  primaryOwnerUserId: string | null = null,
): CustomerCreateCommand => ({
  type: 'CREATE_CUSTOMER',
  customer: { id, name, categoryKey, primaryOwnerUserId },
});

async function command(
  context: Awaited<ReturnType<typeof createTestContext>>,
  key: string,
  payload: unknown,
  token = context.token,
) {
  return await context.app.inject({
    method: 'POST', url: '/api/commands/customer', headers: headers(token, key), payload: payload as any,
  });
}

async function createUser(
  context: Awaited<ReturnType<typeof createTestContext>>,
  role: 'admin' | 'member' | 'viewer',
) {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id,
    email: `${role}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name: role,
    role,
  } });
  const token = context.app.jwt.sign({ userId: user.id, tenantId: context.tenant.id, role });
  return { user, token };
}

describe('CORE-115 create-only Customer command', () => {
  it('creates null/open categories exactly once and keeps replay/audit journals free of the name', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const nullPayload = createPayload(customerId('null'));
      const first = await command(context, 'customer-create-null-stable', nullPayload);
      const replay = await command(context, 'customer-create-null-stable', nullPayload);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({
        customerId: nullPayload.customer.id,
        categoryKey: null,
        primaryOwnerUserId: null,
        version: 0,
        undoable: false,
        replayed: false,
      });
      expect(replay.json()).toEqual({ ...first.json(), replayed: true });

      const row = await context.prisma.account.findUniqueOrThrow({ where: { id: nullPayload.customer.id } });
      expect(row).toMatchObject({
        tenantId: context.tenant.id,
        name: '远山制造',
        categoryKey: null,
        customerType: null,
        version: 0,
        region: '',
        group: '',
        profile: '{}',
      });
      const audit = await context.prisma.auditEvent.findFirstOrThrow({
        where: { tenantId: context.tenant.id, entityKind: 'customer', entityId: row.id },
      });
      const run = await context.prisma.commandRun.findFirstOrThrow({
        where: { tenantId: context.tenant.id, kind: 'customer' },
      });
      expect(audit.action).toBe('customer_created');
      expect(run.status).toBe('completed');
      expect(JSON.parse(audit.changedFields)).toEqual(['name', 'categoryKey', 'primaryOwnerUserId', 'version']);
      expect(`${audit.metadata}\n${run.resultSummary}`).not.toContain('远山制造');
      expect(JSON.parse(run.resultSummary)).toEqual({
        customerId: row.id, categoryKey: null, primaryOwnerUserId: null, version: 0, undoable: false,
      });
      expect(await context.prisma.account.count({ where: { id: row.id } })).toBe(1);
      expect(await context.prisma.auditEvent.count({ where: { entityId: row.id, action: 'customer_created' } })).toBe(1);
      expect(await context.prisma.commandRun.count({ where: { kind: 'customer' } })).toBe(1);

      const openPayload = createPayload(customerId('open'), '开放分类客户', 'ecosystem_partner');
      const open = await command(context, 'customer-create-open-stable', openPayload);
      expect(open.statusCode, open.body).toBe(200);
      expect(open.json()).toMatchObject({ categoryKey: 'ecosystem_partner' });
      expect(await context.prisma.account.findUniqueOrThrow({ where: { id: openPayload.customer.id } })).toMatchObject({
        categoryKey: 'ecosystem_partner', customerType: null,
      });
    } finally {
      await context.cleanup();
    }
  });

  it('rejects key reuse and concurrent duplication without a second Customer or AuditEvent', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const payload = createPayload(customerId('concurrent'));
      const [left, right] = await Promise.all([
        command(context, 'customer-create-concurrent', payload),
        command(context, 'customer-create-concurrent', payload),
      ]);
      expect([left.statusCode, right.statusCode]).toContain(200);
      expect([200, 409, 503]).toContain(left.statusCode);
      expect([200, 409, 503]).toContain(right.statusCode);
      const retry = await command(context, 'customer-create-concurrent', payload);
      expect(retry.statusCode, retry.body).toBe(200);
      expect(retry.json()).toMatchObject({ customerId: payload.customer.id, replayed: true });
      expect(await context.prisma.account.count({ where: { id: payload.customer.id } })).toBe(1);
      expect(await context.prisma.auditEvent.count({ where: { entityId: payload.customer.id } })).toBe(1);

      const reused = await command(context, 'customer-create-concurrent', {
        ...payload, customer: { ...payload.customer, name: '不同客户名' },
      });
      expect(reused.statusCode).toBe(409);
      expect(reused.json()).toMatchObject({ code: 'idempotency_key_reused' });
    } finally {
      await context.cleanup();
    }
  });

  it('returns the same generic conflict for same-tenant and cross-tenant duplicate ids', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const sameId = customerId('duplicate');
      await context.prisma.account.create({ data: {
        id: sameId, tenantId: context.tenant.id, name: '既有客户', customerType: 1,
      } });
      const sameTenant = await command(context, 'customer-duplicate-same', createPayload(sameId));

      const otherTenant = await context.prisma.tenant.create({ data: { id: `tenant-${randomUUID()}`, name: 'Other' } });
      const crossId = customerId('cross-duplicate');
      await context.prisma.account.create({ data: {
        id: crossId, tenantId: otherTenant.id, name: '不可泄露客户', customerType: 4,
      } });
      const crossTenant = await command(context, 'customer-duplicate-cross', createPayload(crossId));
      expect(sameTenant.statusCode).toBe(409);
      expect(crossTenant.statusCode).toBe(409);
      expect(crossTenant.json()).toEqual(sameTenant.json());
      expect(JSON.stringify(crossTenant.json())).not.toContain('不可泄露客户');
    } finally {
      await context.cleanup();
    }
  });

  it('enforces current DB role and stable same-tenant owner assignment rules', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const member = await createUser(context, 'member');
      const viewer = await createUser(context, 'viewer');
      const admin = await createUser(context, 'admin');

      expect((await command(context, 'customer-viewer-denied', createPayload(customerId('viewer')), viewer.token)).statusCode).toBe(403);
      const foreignOwner = await command(
        context, 'customer-member-foreign-owner',
        createPayload(customerId('member-foreign'), 'Member foreign', null, context.owner.id), member.token,
      );
      expect(foreignOwner.statusCode).toBe(403);
      expect(foreignOwner.json()).toMatchObject({ code: 'customer_assign_forbidden' });
      expect((await command(
        context, 'customer-member-self',
        createPayload(customerId('member-self'), 'Member self', null, member.user.id), member.token,
      )).statusCode).toBe(200);
      expect((await command(
        context, 'customer-member-unowned',
        createPayload(customerId('member-unowned'), 'Member unowned'), member.token,
      )).statusCode).toBe(200);
      expect((await command(
        context, 'customer-admin-owner',
        createPayload(customerId('admin-owner'), 'Admin assigned', null, member.user.id), admin.token,
      )).statusCode).toBe(200);
      expect((await command(
        context, 'customer-owner-owner',
        createPayload(customerId('owner-owner'), 'Owner assigned', null, member.user.id),
      )).statusCode).toBe(200);

      const otherTenant = await context.prisma.tenant.create({ data: { id: `tenant-${randomUUID()}`, name: 'Other' } });
      const crossOwner = await context.prisma.user.create({ data: {
        tenantId: otherTenant.id, email: `other-${randomUUID()}@example.test`, passwordHash: 'unused', name: 'Other', role: 'member',
      } });
      expect((await command(
        context, 'customer-cross-owner',
        createPayload(customerId('cross-owner'), 'Cross owner', null, crossOwner.id),
      )).statusCode).toBe(404);

      const removed = await createUser(context, 'member');
      await context.prisma.user.delete({ where: { id: removed.user.id } });
      expect((await command(
        context, 'customer-removed-actor', createPayload(customerId('removed')), removed.token,
      )).statusCode).toBe(401);

      const demoted = await createUser(context, 'member');
      await context.prisma.user.update({ where: { id: demoted.user.id }, data: { role: 'viewer' } });
      expect((await command(
        context, 'customer-demoted-actor', createPayload(customerId('demoted')), demoted.token,
      )).statusCode).toBe(403);
    } finally {
      await context.cleanup();
    }
  });

  it('allows member assignment only when the assembled policy explicitly grants it', async () => {
    const context = await createTestContext({ productAccess: { edition: 'internal' } });
    try {
      const member = await createUser(context, 'member');
      const target = await createUser(context, 'member');
      const assigned = await command(
        context,
        'customer-member-explicit-grant',
        createPayload(customerId('member-granted'), 'Granted assignment', null, target.user.id),
        member.token,
      );
      expect(assigned.statusCode, assigned.body).toBe(200);
      expect(assigned.json()).toMatchObject({ primaryOwnerUserId: target.user.id });
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed for missing capability, disabled flag, invalid keys, and non-create commands before writes', async () => {
    const malformed = await createTestContext({ productAccess: {} });
    try {
      const denied = await command(malformed, 'customer-capability-denied', createPayload(customerId('capability')));
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: '能力未启用', code: 'capability_denied' });
      expect(await malformed.prisma.commandRun.count()).toBe(0);
    } finally {
      await malformed.cleanup();
    }

    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    const previous = process.env.CUSTOMER_COMMANDS_ENABLED;
    try {
      process.env.CUSTOMER_COMMANDS_ENABLED = '0';
      const disabled = await command(context, 'customer-disabled-stable', createPayload(customerId('disabled')));
      expect(disabled.statusCode).toBe(503);
      expect(disabled.json()).toMatchObject({ code: 'customer_commands_disabled' });
      expect(await context.prisma.account.count()).toBe(0);
      expect(await context.prisma.auditEvent.count()).toBe(0);
      expect(await context.prisma.commandRun.count()).toBe(0);

      delete process.env.CUSTOMER_COMMANDS_ENABLED;
      const missingKey = await context.app.inject({
        method: 'POST', url: '/api/commands/customer',
        headers: { authorization: `Bearer ${context.token}` },
        payload: createPayload(customerId('missing-key')),
      });
      expect(missingKey.statusCode).toBe(400);
      const unsupported = await command(context, 'customer-update-unsupported', {
        type: 'UPDATE_CUSTOMER', customerId: customerId('missing'), baseVersion: 0, patch: { name: 'No' },
      });
      expect(unsupported.statusCode).toBe(400);
      expect(await context.prisma.account.count()).toBe(0);
      expect(await context.prisma.commandRun.count()).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.CUSTOMER_COMMANDS_ENABLED;
      else process.env.CUSTOMER_COMMANDS_ENABLED = previous;
      await context.cleanup();
    }
  });

  it('rolls the Account back when AuditEvent creation fails inside the same transaction', async () => {
    const context = await createTestContext({ productAccess: { edition: 'commercial' } });
    const payload = createPayload(customerId('audit-failure'), '原子回滚客户');
    const commandContext: CommandContext = {
      tenantId: context.tenant.id,
      actorId: context.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'customer-audit-failure',
      assertionMode: 'user_asserted',
    };
    try {
      await expect(context.prisma.$transaction(async (tx) => {
        const failingTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== 'auditEvent') return Reflect.get(target, property, receiver);
            return new Proxy(target.auditEvent, {
              get(delegate, operation, delegateReceiver) {
                if (operation === 'create') return async () => { throw new Error('forced audit failure'); };
                return Reflect.get(delegate, operation, delegateReceiver);
              },
            });
          },
        });
        return executeCustomerCommand(commandContext, payload, failingTx as typeof tx, {
          entitlements: ['crm.core'], permissions: [],
        });
      })).rejects.toThrow('forced audit failure');
      expect(await context.prisma.account.count({ where: { id: payload.customer.id } })).toBe(0);
      expect(await context.prisma.auditEvent.count({ where: { entityId: payload.customer.id } })).toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
