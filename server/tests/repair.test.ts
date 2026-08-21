import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

const sourceAccountBase = {
  name: 'Source account',
  customerType: 1 as const,
  primaryOwner: '',
  primaryOwnerUserId: null,
};

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

async function seedRepairTrees(context: TestContext, suffix: string) {
  const sourceAccountId = `acc-repair-source-${suffix}`;
  const sourceOpportunityId = `opp-repair-source-${suffix}`;
  const targetAccountId = `acc-repair-target-${suffix}`;
  const targetOpportunityId = `opp-repair-target-${suffix}`;
  const visitNoteId = `visit-repair-${suffix}`;
  const noteId = `note-repair-${suffix}`;

  await context.prisma.account.createMany({
    data: [
      { id: sourceAccountId, tenantId: context.tenant.id, name: 'Source account', customerType: 1, externalRef: `source-${suffix}` },
      { id: targetAccountId, tenantId: context.tenant.id, name: 'Target account', customerType: 2, externalRef: `target-${suffix}` },
    ],
  });
  await context.prisma.opportunity.createMany({
    data: [
      {
        id: sourceOpportunityId,
        tenantId: context.tenant.id,
        accountId: sourceAccountId,
        name: 'Source opportunity',
        customerType: 1,
        pipelineStage: '线索',
        engageStage: '需求调研立项',
        externalRef: `source-opp-${suffix}`,
      },
      {
        id: targetOpportunityId,
        tenantId: context.tenant.id,
        accountId: targetAccountId,
        name: 'Target opportunity',
        customerType: 2,
        pipelineStage: '立项',
        engageStage: '方案形成',
        externalRef: `target-opp-${suffix}`,
      },
    ],
  });
  await context.prisma.visitNote.create({
    data: {
      id: visitNoteId,
      tenantId: context.tenant.id,
      accountId: sourceAccountId,
      opportunityId: sourceOpportunityId,
      externalRef: `visit-${suffix}`,
      topic: 'Wrongly bound visit',
      createdBy: context.owner.id,
    },
  });
  await context.prisma.note.create({
    data: {
      id: noteId,
      tenantId: context.tenant.id,
      accountId: sourceAccountId,
      opportunityId: sourceOpportunityId,
      content: 'Wrongly bound note',
      source: 'workbuddy',
      createdBy: context.owner.id,
    },
  });
  return {
    sourceAccountId,
    sourceOpportunityId,
    targetAccountId,
    targetOpportunityId,
    visitNoteId,
    noteId,
  };
}

describe('INT-301 minimum data repair', () => {
  it('transactionally rebinds VisitNote and Note redundant account/opportunity references and audits each repair', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'success');
      for (const [kind, id] of [['visitNote', tree.visitNoteId], ['note', tree.noteId]] as const) {
        const response = await context.app.inject({
          method: 'POST',
          url: '/api/repair/rebind',
          headers: auth(context.token),
          payload: {
            kind,
            id,
            accountId: tree.targetAccountId,
            opportunityId: tree.targetOpportunityId,
          },
        });
        expect(response.statusCode).toBe(200);
      }

      await expect(Promise.all([
        context.prisma.visitNote.findUniqueOrThrow({ where: { id: tree.visitNoteId } }),
        context.prisma.note.findUniqueOrThrow({ where: { id: tree.noteId } }),
      ])).resolves.toEqual([
        expect.objectContaining({ accountId: tree.targetAccountId, opportunityId: tree.targetOpportunityId }),
        expect.objectContaining({ accountId: tree.targetAccountId, opportunityId: tree.targetOpportunityId }),
      ]);

      const audits = await context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id, action: 'rebind', entityId: { in: [tree.visitNoteId, tree.noteId] } },
        orderBy: { entityId: 'asc' },
      });
      expect(audits).toHaveLength(2);
      expect(audits.map((audit) => ({
        entityKind: audit.entityKind,
        sourceRef: audit.sourceRef,
        changedFields: JSON.parse(audit.changedFields),
      }))).toEqual([
        { entityKind: 'note', sourceRef: null, changedFields: ['accountId', 'opportunityId'] },
        { entityKind: 'visitNote', sourceRef: 'visit-success', changedFields: ['accountId', 'opportunityId'] },
      ]);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed without writes when the existing parent tree is malformed', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'malformed-old');
      await context.prisma.visitNote.update({
        where: { id: tree.visitNoteId },
        data: { accountId: tree.targetAccountId },
      });

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/repair/rebind',
        headers: auth(context.token),
        payload: {
          kind: 'visitNote',
          id: tree.visitNoteId,
          accountId: tree.targetAccountId,
          opportunityId: tree.targetOpportunityId,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: '资源不存在' });
      await expect(context.prisma.visitNote.findUniqueOrThrow({ where: { id: tree.visitNoteId } }))
        .resolves.toMatchObject({ accountId: tree.targetAccountId, opportunityId: tree.sourceOpportunityId });
      await expect(context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, entityId: tree.visitNoteId, action: 'rebind' },
      })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed without writes when the new parent tree belongs to another tenant', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'cross-tenant');
      const other = await registerTenant(context, 'repair-other');
      const otherAccountId = 'acc-repair-other';
      const otherOpportunityId = 'opp-repair-other';
      await context.prisma.account.create({
        data: { id: otherAccountId, tenantId: other.tenant.id, name: 'Other tenant account', customerType: 1 },
      });
      await context.prisma.opportunity.create({
        data: {
          id: otherOpportunityId,
          tenantId: other.tenant.id,
          accountId: otherAccountId,
          name: 'Other tenant opportunity',
          customerType: 1,
          pipelineStage: '线索',
          engageStage: '需求调研立项',
        },
      });

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/repair/rebind',
        headers: auth(context.token),
        payload: {
          kind: 'note',
          id: tree.noteId,
          accountId: otherAccountId,
          opportunityId: otherOpportunityId,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: '资源不存在' });
      await expect(context.prisma.note.findUniqueOrThrow({ where: { id: tree.noteId } }))
        .resolves.toMatchObject({ accountId: tree.sourceAccountId, opportunityId: tree.sourceOpportunityId });
      await expect(context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, entityId: tree.noteId, action: 'rebind' },
      })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('corrects only approved account and opportunity fields and records field names without values', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'fields');
      const reassignee = await context.prisma.user.create({
        data: {
          tenantId: context.tenant.id,
          email: `repair-owner-${randomUUID()}@example.test`,
          passwordHash: 'not-used-in-test',
          name: 'Correct owner',
          role: 'member',
        },
      });
      const accountResponse = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { base: sourceAccountBase, name: 'Correct account', customerType: 4, primaryOwnerUserId: reassignee.id },
      });
      const opportunityResponse = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/opportunity/${tree.sourceOpportunityId}`,
        headers: auth(context.token),
        payload: {
          baseVersion: 0,
          name: 'Correct opportunity',
          pipelineStage: '合同谈判',
          status: 'paused',
          expectedAmountW: 123.5,
          expectedSignDate: '2026-08-09',
          singleSalesGoal: 'Correct objective',
          competitiveSituation: '胶着',
        },
      });

      expect([accountResponse.statusCode, opportunityResponse.statusCode]).toEqual([200, 200]);
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: tree.sourceAccountId } }))
        .resolves.toMatchObject({
          name: 'Correct account',
          customerType: 4,
          primaryOwner: 'Correct owner',
          primaryOwnerUserId: reassignee.id,
        });
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.sourceOpportunityId } }))
        .resolves.toMatchObject({
          name: 'Correct opportunity',
          pipelineStage: '合同谈判',
          status: 'paused',
          lifecycleStatus: 'paused',
          outcomeKey: null,
          expectedAmountW: 123.5,
          expectedSignDate: '2026-08-09',
          singleSalesGoal: 'Correct objective',
          competitiveSituation: '胶着',
          version: 1,
        });

      const audits = await context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id, action: 'repair', entityId: { in: [tree.sourceAccountId, tree.sourceOpportunityId] } },
      });
      expect(audits).toHaveLength(2);
      const serialized = JSON.stringify(audits);
      expect(serialized).not.toContain('Correct account');
      expect(serialized).not.toContain('Correct objective');
      expect(audits.map((audit) => JSON.parse(audit.changedFields)).sort((a, b) => a.length - b.length)).toEqual([
        ['name', 'customerType', 'primaryOwner', 'primaryOwnerUserId'],
        [
          'name',
          'pipelineStage',
          'status',
          'expectedAmountW',
          'expectedSignDate',
          'singleSalesGoal',
          'competitiveSituation',
          'lifecycleStatus',
          'outcomeKey',
        ],
      ]);

      const rejected = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { region: 'must not be exposed' },
      });
      expect(rejected.statusCode).toBe(400);
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: tree.sourceAccountId } }))
        .resolves.toMatchObject({ region: '' });
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a stale opportunity repair instead of overwriting a concurrent correction', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'opportunity-conflict');
      const first = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/opportunity/${tree.sourceOpportunityId}`,
        headers: auth(context.token),
        payload: { baseVersion: 0, status: 'paused' },
      });
      const stale = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/opportunity/${tree.sourceOpportunityId}`,
        headers: auth(context.token),
        payload: { baseVersion: 0, name: 'Stale overwrite' },
      });

      expect(first.statusCode).toBe(200);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
      const empty = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/opportunity/${tree.sourceOpportunityId}`,
        headers: auth(context.token),
        payload: { baseVersion: 1 },
      });
      expect(empty.statusCode).toBe(400);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.sourceOpportunityId } }))
        .resolves.toMatchObject({ name: 'Source opportunity', status: 'paused', version: 1 });
      await expect(context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, entityId: tree.sourceOpportunityId, action: 'repair' },
      })).resolves.toBe(1);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects impossible signing dates', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'calendar-date');
      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/opportunity/${tree.sourceOpportunityId}`,
        headers: auth(context.token),
        payload: { baseVersion: 0, expectedSignDate: '2026-02-30' },
      });

      expect(response.statusCode).toBe(400);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.sourceOpportunityId } }))
        .resolves.toMatchObject({ expectedSignDate: '', version: 0 });
    } finally {
      await context.cleanup();
    }
  });

  it('denies viewer repair surfaces and member restore', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'rbac');
      const viewer = await context.prisma.user.create({
        data: { tenantId: context.tenant.id, passwordHash: 'unused', name: 'Viewer', role: 'viewer' },
      });
      const member = await context.prisma.user.create({
        data: { tenantId: context.tenant.id, passwordHash: 'unused', name: 'Member', role: 'member' },
      });
      const viewerToken = context.app.jwt.sign({ userId: viewer.id, tenantId: context.tenant.id, role: viewer.role });
      const memberToken = context.app.jwt.sign({ userId: member.id, tenantId: context.tenant.id, role: member.role });
      const attempts = [
        { method: 'PATCH', url: `/api/repair/account/${tree.sourceAccountId}`, payload: { name: 'Forbidden' } },
        { method: 'PATCH', url: `/api/repair/opportunity/${tree.sourceOpportunityId}`, payload: { baseVersion: 0, name: 'Forbidden' } },
        { method: 'POST', url: '/api/repair/rebind', payload: { kind: 'note', id: tree.noteId, accountId: tree.targetAccountId } },
        { method: 'GET', url: `/api/repair/context/account/${tree.sourceAccountId}` },
        { method: 'POST', url: `/api/archive/account/${tree.sourceAccountId}`, payload: { reason: 'Forbidden' } },
      ] as const;
      for (const attempt of attempts) {
        const response = await context.app.inject({ ...attempt, headers: auth(viewerToken) });
        expect(response.statusCode).toBe(403);
      }
      const restore = await context.app.inject({
        method: 'POST',
        url: `/api/archive/account/${tree.sourceAccountId}/restore`,
        headers: auth(memberToken),
      });
      expect(restore.statusCode).toBe(403);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects assigning an account owner from another tenant without writes or audit', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'foreign-owner');
      const other = await registerTenant(context, 'foreign-owner-other');

      const response = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { base: sourceAccountBase, primaryOwnerUserId: other.user.id },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: '资源不存在' });
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: tree.sourceAccountId } }))
        .resolves.toMatchObject({ primaryOwner: '', primaryOwnerUserId: null });
      await expect(context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, entityId: tree.sourceAccountId, action: 'repair' },
      })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a stale account repair instead of overwriting another correction', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'account-conflict');
      const first = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { base: sourceAccountBase, name: 'Concurrent name' },
      });
      const stale = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { base: sourceAccountBase, customerType: 4 },
      });

      expect(first.statusCode).toBe(200);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: tree.sourceAccountId } }))
        .resolves.toMatchObject({ name: 'Concurrent name', customerType: 1 });
    } finally {
      await context.cleanup();
    }
  });

  it('treats effective no-op corrections and rebind retries as successful without duplicate audit', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'no-op');
      const accountNoOp = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { base: sourceAccountBase, name: 'Source account' },
      });
      const opportunityNoOp = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/opportunity/${tree.sourceOpportunityId}`,
        headers: auth(context.token),
        payload: { baseVersion: 0, name: 'Source opportunity' },
      });
      const rebindPayload = {
        kind: 'visitNote' as const,
        id: tree.visitNoteId,
        accountId: tree.targetAccountId,
        opportunityId: tree.targetOpportunityId,
      };
      const firstRebind = await context.app.inject({ method: 'POST', url: '/api/repair/rebind', headers: auth(context.token), payload: rebindPayload });
      const replayedRebind = await context.app.inject({ method: 'POST', url: '/api/repair/rebind', headers: auth(context.token), payload: rebindPayload });

      expect([accountNoOp.statusCode, opportunityNoOp.statusCode, firstRebind.statusCode, replayedRebind.statusCode])
        .toEqual([200, 200, 200, 200]);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.sourceOpportunityId } }))
        .resolves.toMatchObject({ version: 0 });
      await expect(context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id, entityId: { in: [tree.sourceAccountId, tree.sourceOpportunityId, tree.visitNoteId] } },
      })).resolves.toHaveLength(1);
    } finally {
      await context.cleanup();
    }
  });

  it('reuses archive and restore semantics through the repair-tool path interfaces', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'archive-alias');
      const archived = await context.app.inject({
        method: 'POST',
        url: `/api/archive/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { reason: 'repair rollback point' },
      });
      expect(archived.statusCode).toBe(200);
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: tree.sourceAccountId } }))
        .resolves.toMatchObject({ archiveReason: 'repair rollback point', archivedBy: context.owner.id });

      const restored = await context.app.inject({
        method: 'POST',
        url: `/api/archive/account/${tree.sourceAccountId}/restore`,
        headers: auth(context.token),
      });
      expect(restored.statusCode).toBe(200);
      await expect(context.prisma.account.findUniqueOrThrow({ where: { id: tree.sourceAccountId } }))
        .resolves.toMatchObject({ archivedAt: null, archivedBy: null, archiveReason: '' });
      await expect(context.prisma.auditEvent.findMany({
        where: { tenantId: context.tenant.id, entityId: tree.sourceAccountId },
        orderBy: { createdAt: 'asc' },
        select: { action: true },
      })).resolves.toEqual([{ action: 'archive' }, { action: 'restore' }]);
    } finally {
      await context.cleanup();
    }
  });

  it('returns tenant-scoped provenance, related SyncRuns, and recent AuditEvents without sensitive values', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'context');
      const other = await registerTenant(context, 'context-other');
      const repair = await context.app.inject({
        method: 'PATCH',
        url: `/api/repair/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
        payload: { base: sourceAccountBase, name: 'Sensitive account value' },
      });
      expect(repair.statusCode).toBe(200);
      await context.prisma.syncRun.createMany({
        data: [
          {
            id: 'sync-repair-context',
            tenantId: context.tenant.id,
            actorId: context.owner.id,
            idempotencyKey: 'context-key',
            requestHash: 'context-hash',
            status: 'completed',
            receipt: JSON.stringify({ created: ['account:source-context'] }),
          },
          {
            id: 'sync-repair-other',
            tenantId: other.tenant.id,
            actorId: other.user.id,
            idempotencyKey: 'other-key',
            requestHash: 'other-hash',
            status: 'completed',
            receipt: JSON.stringify({ created: ['account:source-context'] }),
          },
        ],
      });
      await context.prisma.syncRun.createMany({
        data: Array.from({ length: 105 }, (_, index) => ({
          id: `sync-repair-unrelated-${index}`,
          tenantId: context.tenant.id,
          actorId: context.owner.id,
          idempotencyKey: `unrelated-key-${index}`,
          requestHash: `unrelated-hash-${index}`,
          status: 'completed',
          receipt: JSON.stringify({ created: [`account:unrelated-${index}`] }),
          createdAt: new Date(`2099-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
          updatedAt: new Date(`2099-02-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
        })),
      });

      const response = await context.app.inject({
        method: 'GET',
        url: `/api/repair/context/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{
        source: string;
        sourceRef: string | null;
        syncedAt: string | null;
        syncRuns: Array<{ id: string; status: string }>;
        auditEvents: Array<{ action: string; changedFields: string[] }>;
      }>();
      expect(body).toMatchObject({
        source: 'workbuddy',
        sourceRef: 'source-context',
        syncRuns: [{ id: 'sync-repair-context', status: 'completed' }],
        auditEvents: [{ action: 'repair', changedFields: ['name'] }],
      });
      expect(body.syncedAt).toEqual(expect.any(String));
      expect(JSON.stringify(body)).not.toContain('Sensitive account value');
      expect(JSON.stringify(body)).not.toContain('sync-repair-other');

      await context.prisma.account.update({
        where: { id: tree.sourceAccountId },
        data: { externalRef: 'source-with-no-sync-run' },
      });
      const exhausted = await context.app.inject({
        method: 'GET',
        url: `/api/repair/context/account/${tree.sourceAccountId}`,
        headers: auth(context.token),
      });
      expect(exhausted.statusCode).toBe(200);
      expect(exhausted.json<{ syncRuns: unknown[] }>().syncRuns).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });

  it('matches colon-containing source refs exactly instead of attributing another entity field proposal', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'colon-ref');
      await context.prisma.opportunity.update({
        where: { id: tree.sourceOpportunityId },
        data: { externalRef: 'external:name' },
      });
      await context.prisma.syncRun.createMany({
        data: [
          {
            id: 'sync-colon-wrong', tenantId: context.tenant.id, actorId: context.owner.id,
            idempotencyKey: 'sync-colon-wrong-key', requestHash: 'sync-colon-wrong-hash', status: 'completed',
            receipt: JSON.stringify({ proposed: ['opportunity:external:name'] }),
          },
          {
            id: 'sync-colon-exact', tenantId: context.tenant.id, actorId: context.owner.id,
            idempotencyKey: 'sync-colon-exact-key', requestHash: 'sync-colon-exact-hash', status: 'completed',
            receipt: JSON.stringify({ proposed: ['opportunity:external:name:status'] }),
          },
        ],
      });

      const response = await context.app.inject({
        method: 'GET',
        url: `/api/repair/context/opportunity/${tree.sourceOpportunityId}`,
        headers: auth(context.token),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ syncRuns: Array<{ id: string }> }>().syncRuns.map((run) => run.id))
        .toEqual(['sync-colon-exact']);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed when a person-bound Note is moved across accounts without an explicit person repair', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedRepairTrees(context, 'person-bound');
      const personId = 'person-repair-bound';
      await context.prisma.person.create({
        data: {
          id: personId,
          tenantId: context.tenant.id,
          accountId: tree.sourceAccountId,
          name: 'Bound person',
          title: 'Decision maker',
        },
      });
      await context.prisma.note.update({ where: { id: tree.noteId }, data: { personId } });

      const response = await context.app.inject({
        method: 'POST',
        url: '/api/repair/rebind',
        headers: auth(context.token),
        payload: {
          kind: 'note',
          id: tree.noteId,
          accountId: tree.targetAccountId,
          opportunityId: tree.targetOpportunityId,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: '资源不存在' });
      await expect(context.prisma.note.findUniqueOrThrow({ where: { id: tree.noteId } }))
        .resolves.toMatchObject({
          accountId: tree.sourceAccountId,
          opportunityId: tree.sourceOpportunityId,
          personId,
        });
      await expect(context.prisma.auditEvent.count({
        where: { tenantId: context.tenant.id, entityId: tree.noteId, action: 'rebind' },
      })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });
});
