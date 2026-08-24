import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';
import { assembleState, type StateSecurityWarning } from '../src/state.js';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

async function createRoleToken(context: TestContext, role: Role): Promise<{ token: string; userId: string }> {
  const user = await context.prisma.user.create({
    data: {
      tenantId: context.tenant.id,
      email: `${role}-${randomUUID()}@example.test`,
      passwordHash: 'not-used-by-token-auth',
      name: `${role} user`,
      role,
    },
  });
  return {
    userId: user.id,
    token: context.app.jwt.sign({ userId: user.id, tenantId: context.tenant.id, role }),
  };
}

async function registerTenant(context: TestContext, label: string) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: {
      email: `${label}-${randomUUID()}@example.test`,
      password: 'test-password',
      name: `${label} owner`,
      tenantName: `${label} tenant`,
    },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string; tenant: { id: string }; user: { id: string } }>();
}

async function seedTree(context: TestContext, suffix: string) {
  const accountId = `acc-archive-${suffix}`;
  const opportunityId = `opp-archive-${suffix}`;
  const personId = `person-archive-${suffix}`;
  const noteId = `note-archive-${suffix}`;
  await context.prisma.account.create({
    data: { id: accountId, tenantId: context.tenant.id, name: `Account ${suffix}`, customerType: 1 },
  });
  await context.prisma.opportunity.create({
    data: {
      id: opportunityId,
      tenantId: context.tenant.id,
      accountId,
      name: `Opportunity ${suffix}`,
      customerType: 1,
      pipelineStage: '线索',
      engageStage: '需求调研立项',
    },
  });
  await context.prisma.person.create({
    data: {
      id: personId,
      tenantId: context.tenant.id,
      accountId,
      name: `Person ${suffix}`,
      title: 'Decision maker',
      form: JSON.stringify({ family: 'sensitive-family-data' }),
      logs: JSON.stringify([{ text: 'sensitive-log-data' }]),
    },
  });
  await context.prisma.note.create({
    data: {
      id: noteId,
      tenantId: context.tenant.id,
      accountId,
      opportunityId,
      personId,
      content: 'sensitive-meeting-note',
    },
  });
  return { accountId, opportunityId, personId, noteId };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('INT-103 recoverable archive', () => {
  it('removes the tenant-wide reset route without deleting data', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'reset-route');
      const response = await context.app.inject({
        method: 'POST',
        url: '/api/reset',
        headers: auth(context.token),
      });

      expect(response.statusCode).toBe(404);
      await expect(context.prisma.account.findUnique({ where: { id: tree.accountId } })).resolves.not.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('rejects legacy hard-delete actions and preserves account and opportunity rows', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'legacy-delete');
      const member = await createRoleToken(context, 'member');
      const actions = [
        { type: 'DELETE_OPP', accId: tree.accountId, oppId: tree.opportunityId },
        { type: 'DELETE_ACCOUNT', accId: tree.accountId },
      ];

      const responses = [];
      for (const action of actions) {
        responses.push(await context.app.inject({
          method: 'POST',
          url: '/api/mutate',
          headers: auth(member.token),
          payload: { action },
        }));
      }

      expect(responses.every((response) => response.statusCode >= 400)).toBe(true);
      await expect(Promise.all([
        context.prisma.account.findUnique({ where: { id: tree.accountId } }),
        context.prisma.opportunity.findUnique({ where: { id: tree.opportunityId } }),
      ])).resolves.toEqual([expect.any(Object), expect.any(Object)]);
    } finally {
      await context.cleanup();
    }
  });

  it('archives an account without deleting children, hides it from state, and writes minimal audit data', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'account');
      const member = await createRoleToken(context, 'member');
      const beforeCounts = await Promise.all([
        context.prisma.opportunity.count({ where: { accountId: tree.accountId } }),
        context.prisma.person.count({ where: { accountId: tree.accountId } }),
        context.prisma.note.count({ where: { accountId: tree.accountId } }),
      ]);

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/archive',
        headers: auth(member.token),
        payload: { target: 'account', id: tree.accountId, reason: 'duplicate record' },
      });

      expect(response.statusCode).toBe(200);
      const archived = await (context.prisma.account as any).findUniqueOrThrow({ where: { id: tree.accountId } });
      expect(archived).toMatchObject({ archivedBy: member.userId, archiveReason: 'duplicate record' });
      expect(archived.archivedAt).toBeInstanceOf(Date);
      await expect(Promise.all([
        context.prisma.opportunity.count({ where: { accountId: tree.accountId } }),
        context.prisma.person.count({ where: { accountId: tree.accountId } }),
        context.prisma.note.count({ where: { accountId: tree.accountId } }),
      ])).resolves.toEqual(beforeCounts);

      const state = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(context.token) });
      expect(state.statusCode).toBe(200);
      expect(state.json<{ accounts: Array<{ id: string }> }>().accounts.some((item) => item.id === tree.accountId)).toBe(false);

      const audit = await (context.prisma as any).auditEvent.findFirstOrThrow({
        where: { tenantId: context.tenant.id, entityId: tree.accountId, action: 'archive' },
      });
      expect(audit).toMatchObject({
        actorId: member.userId,
        channel: 'web',
        entityKind: 'account',
        entityId: tree.accountId,
      });
      expect(audit.requestId).toBeTruthy();
      expect(audit.changedFields).toBe(JSON.stringify(['archivedAt', 'archivedBy', 'archiveReason']));
      expect(audit.changedFields).not.toContain('sensitive-family-data');
      expect(audit.changedFields).not.toContain('sensitive-log-data');
      expect(audit.changedFields).not.toContain('sensitive-meeting-note');

      const mutateArchived = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: auth(member.token),
        payload: { action: { type: 'UPDATE_ACCOUNT', accId: tree.accountId, patch: { name: 'must stay frozen' } } },
      });
      expect(mutateArchived.statusCode).toBe(404);
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: tree.accountId } }))
        .resolves.toMatchObject({ name: 'Account account' });

      const warnings: StateSecurityWarning[] = [];
      await assembleState(context.tenant.id, { tenantId: context.tenant.id, userId: context.owner.id, role: 'owner' }, { onSecurityWarning: (warning) => warnings.push(warning) });
      expect(warnings).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });

  it('allows only owner/admin to restore and returns the full account tree', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'restore');
      const member = await createRoleToken(context, 'member');
      const admin = await createRoleToken(context, 'admin');
      const archived = await context.app.inject({
        method: 'POST', url: '/api/archive', headers: auth(member.token),
        payload: { target: 'account', id: tree.accountId, reason: 'temporary' },
      });
      expect(archived.statusCode).toBe(200);

      const memberList = await context.app.inject({ method: 'GET', url: '/api/archive', headers: auth(member.token) });
      expect(memberList.statusCode).toBe(403);

      const denied = await context.app.inject({
        method: 'POST', url: '/api/archive/restore', headers: auth(member.token),
        payload: { target: 'account', id: tree.accountId },
      });
      expect(denied.statusCode).toBe(403);

      const adminList = await context.app.inject({ method: 'GET', url: '/api/archive', headers: auth(admin.token) });
      expect(adminList.statusCode).toBe(200);
      expect(adminList.json<{ accounts: Array<{ id: string }> }>().accounts)
        .toContainEqual(expect.objectContaining({ id: tree.accountId }));

      const restored = await context.app.inject({
        method: 'POST', url: '/api/archive/restore', headers: auth(admin.token),
        payload: { target: 'account', id: tree.accountId },
      });
      expect(restored.statusCode).toBe(200);
      const row = await (context.prisma.account as any).findUniqueOrThrow({ where: { id: tree.accountId } });
      expect(row).toMatchObject({ archivedAt: null, archivedBy: null, archiveReason: '' });

      const state = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(context.token) });
      const account = state.json<{ accounts: Array<any> }>().accounts.find((item) => item.id === tree.accountId);
      expect(account).toMatchObject({
        id: tree.accountId,
        persons: [{ id: tree.personId }],
        opportunities: [{ id: tree.opportunityId }],
        notes: [{ id: tree.noteId }],
      });
      await expect((context.prisma as any).auditEvent.findFirst({
        where: { tenantId: context.tenant.id, entityId: tree.accountId, action: 'restore', actorId: admin.userId },
      })).resolves.not.toBeNull();
    } finally {
      await context.cleanup();
    }
  });

  it('archives and restores an opportunity independently of its account', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'opportunity');
      const response = await context.app.inject({
        method: 'POST', url: '/api/archive', headers: auth(context.token),
        payload: { target: 'opportunity', id: tree.opportunityId, reason: 'closed duplicate' },
      });
      expect(response.statusCode).toBe(200);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.opportunityId } }))
        .resolves.toMatchObject({ version: 1 });
      await expect(context.prisma.note.findUnique({ where: { id: tree.noteId } })).resolves.not.toBeNull();

      const hiddenState = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(context.token) });
      const hiddenAccount = hiddenState.json<{ accounts: Array<any> }>().accounts.find((item) => item.id === tree.accountId);
      expect(hiddenAccount).toBeTruthy();
      expect(hiddenAccount.opportunities).toEqual([]);
      expect(hiddenAccount.notes).toEqual([]);

      const restored = await context.app.inject({
        method: 'POST', url: '/api/archive/restore', headers: auth(context.token),
        payload: { target: 'opportunity', id: tree.opportunityId },
      });
      expect(restored.statusCode).toBe(200);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.opportunityId } }))
        .resolves.toMatchObject({ version: 2 });
      const visibleState = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(context.token) });
      const visibleAccount = visibleState.json<{ accounts: Array<any> }>().accounts.find((item) => item.id === tree.accountId);
      expect(visibleAccount.opportunities).toContainEqual(expect.objectContaining({ id: tree.opportunityId }));
      expect(visibleAccount.notes).toContainEqual(expect.objectContaining({ id: tree.noteId }));
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed for cross-tenant archive and restore attempts', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedTree(context, 'cross-tenant');
      const other = await registerTenant(context, 'other');

      const archive = await context.app.inject({
        method: 'POST', url: '/api/archive', headers: auth(other.token),
        payload: { target: 'account', id: tree.accountId, reason: 'forged' },
      });
      const restore = await context.app.inject({
        method: 'POST', url: '/api/archive/restore', headers: auth(other.token),
        payload: { target: 'account', id: tree.accountId },
      });

      expect([archive.statusCode, restore.statusCode]).toEqual([404, 404]);
      const row = await (context.prisma.account as any).findUniqueOrThrow({ where: { id: tree.accountId } });
      expect(row.archivedAt ?? null).toBeNull();
    } finally {
      await context.cleanup();
    }
  });
});
