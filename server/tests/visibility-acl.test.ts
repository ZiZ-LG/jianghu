import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { backfillAccountOwners } from '../scripts/backfill-account-owners.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import { buildServerAiContext, contextManifestToken } from '../src/ai.js';
import { inspectMatterOwnerAssignments, userOwnsMatter } from '../src/matter/ownership.js';
import { executeMatterOwnerTransfer } from '../src/mutation/matterOwnership.js';
import { seedLegacyCandidateAuthority } from './helpers/candidateAuthority.js';

function auth(token: string) { return { authorization: `Bearer ${token}` }; }

async function addUser(context: TestContext, role: 'admin' | 'member' | 'viewer', name: string) {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id, email: `${role}-${randomUUID()}@example.test`, passwordHash: 'unused', name, role,
  } });
  return { user, token: context.app.jwt.sign({ userId: user.id, tenantId: context.tenant.id, role }) };
}

describe('INT-107 stable ownership and sensitive read ACL', () => {
  it('creates and updates stable owners only by an explicit tenant-local user ID', async () => {
    const context = await createTestContext();
    try {
      const first = await addUser(context, 'viewer', '同名');
      const second = await addUser(context, 'viewer', '同名');
      const create = await context.app.inject({ method: 'POST', url: '/api/mutate', headers: auth(context.token), payload: { action: {
        type: 'ADD_ACCOUNT', account: { id: 'acc-online-owner', name: 'Online', customerType: 1, primaryOwner: '同名', primaryOwnerUserId: first.user.id },
      } } });
      expect(create.statusCode).toBe(200);
      expect((await context.prisma.account.findUniqueOrThrow({ where: { id: 'acc-online-owner' } })).primaryOwnerUserId).toBe(first.user.id);
      const update = await context.app.inject({ method: 'POST', url: '/api/mutate', headers: auth(context.token), payload: { action: {
        type: 'UPDATE_ACCOUNT', accId: 'acc-online-owner', patch: { primaryOwner: '同名', primaryOwnerUserId: second.user.id },
      } } });
      expect(update.statusCode).toBe(200);
      expect((await context.prisma.account.findUniqueOrThrow({ where: { id: 'acc-online-owner' } })).primaryOwnerUserId).toBe(second.user.id);

      const foreignTenant = await context.prisma.tenant.create({ data: { id: `foreign-${randomUUID()}`, name: 'Foreign' } });
      const foreign = await context.prisma.user.create({ data: { tenantId: foreignTenant.id, email: `${randomUUID()}@x.test`, passwordHash: 'x', name: '同名', role: 'viewer' } });
      const attack = await context.app.inject({ method: 'POST', url: '/api/mutate', headers: auth(context.token), payload: { action: {
        type: 'UPDATE_ACCOUNT', accId: 'acc-online-owner', patch: { primaryOwnerUserId: foreign.id },
      } } });
      expect(attack.statusCode).toBe(400);
      expect((await context.prisma.account.findUniqueOrThrow({ where: { id: 'acc-online-owner' } })).primaryOwnerUserId).toBe(second.user.id);
    } finally { await context.cleanup(); }
  });

  it('uses stable owner user ID so same-name viewers cannot cross-read accounts', async () => {
    const context = await createTestContext();
    try {
      const a = await addUser(context, 'viewer', '同名销售');
      const b = await addUser(context, 'viewer', '同名销售');
      await context.prisma.account.createMany({ data: [
        { id: 'acc-owner-a', tenantId: context.tenant.id, name: 'A', customerType: 1, primaryOwner: '同名销售', primaryOwnerUserId: a.user.id },
        { id: 'acc-owner-b', tenantId: context.tenant.id, name: 'B', customerType: 1, primaryOwner: '同名销售', primaryOwnerUserId: b.user.id },
        { id: 'acc-unowned', tenantId: context.tenant.id, name: 'U', customerType: 1, primaryOwner: '同名销售' },
      ] });
      const ra = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(a.token) });
      const rb = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(b.token) });
      expect(ra.json().accounts.map((x: any) => x.id)).toEqual(['acc-owner-a']);
      expect(rb.json().accounts.map((x: any) => x.id)).toEqual(['acc-owner-b']);
    } finally { await context.cleanup(); }
  });

  it('filters private BI and self/team/org logs on the server', async () => {
    const context = await createTestContext();
    try {
      const member = await addUser(context, 'member', '编辑');
      const otherMember = await addUser(context, 'member', '另一编辑');
      const viewer = await addUser(context, 'viewer', '查看');
      await context.prisma.account.create({ data: { id: 'acc-acl', tenantId: context.tenant.id, name: 'ACL', customerType: 1, primaryOwnerUserId: viewer.user.id } });
      await context.prisma.person.create({ data: {
        id: 'person-acl', tenantId: context.tenant.id, accountId: 'acc-acl', name: 'P', title: 'T',
        logs: JSON.stringify([
          { date: '1', content: 'self-member', visibility: 'self', createdBy: member.user.id },
          { date: '2', content: 'team', visibility: 'team', createdBy: member.user.id },
          { date: '3', content: 'org', visibility: 'org', createdBy: member.user.id },
          { date: '4', content: 'bad-visibility', visibility: 'everyone', createdBy: member.user.id },
          { date: '5', content: 'legacy-sensitive-team', sensitive: true },
          { date: '6', content: 'legacy-public-org', sensitive: false },
          { date: '7', content: 'legacy-org' },
          { date: '8', content: 'bad-sensitive', sensitive: 'true' },
        ]),
      } });
      await context.prisma.opportunity.create({ data: { id: 'opp-acl', tenantId: context.tenant.id, accountId: 'acc-acl', name: 'O', customerType: 1, pipelineStage: 'x', engageStage: 'x' } });
      await context.prisma.pdeDecisionContext.create({ data: {
        id: 'pde-context-acl', tenantId: context.tenant.id, opportunityId: 'opp-acl',
        stageKey: 'initiation', source: 'legacy_shadow',
      } });
      await context.prisma.oppRole.create({ data: { tenantId: context.tenant.id, opportunityId: 'opp-acl', personId: 'person-acl', role: 'D', sentiment: 'plus', confidence: '明确' } });
      await context.prisma.burningIssue.createMany({ data: [
        { id: 'bi-private', tenantId: context.tenant.id, opportunityId: 'opp-acl', personId: 'person-acl', description: 'private', category: 'x', isPrivate: true, confidence: '明确' },
        { id: 'bi-org', tenantId: context.tenant.id, opportunityId: 'opp-acl', personId: 'person-acl', description: 'org', category: 'x', isPrivate: false, confidence: '明确' },
      ] });
      await context.prisma.uCV.create({ data: { id: 'ucv-private', tenantId: context.tenant.id, opportunityId: 'opp-acl', targetBiId: 'bi-private', description: 'value', competitorCannot: 'x', status: '获认可' } });
      await context.prisma.curatedSummary.create({ data: {
        id: 'cs-acl', tenantId: context.tenant.id, entityKind: 'account', entityId: 'acc-acl',
        content: 'legacy summary may contain self/team data', model: 'legacy',
      } });

      const memberState = (await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(member.token) })).json();
      const otherMemberState = (await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(otherMember.token) })).json();
      const viewerState = (await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(viewer.token) })).json();
      expect(memberState.accounts[0].persons[0].logs.map((x: any) => x.content)).toEqual(['self-member', 'team', 'org', 'legacy-sensitive-team', 'legacy-public-org', 'legacy-org']);
      expect(otherMemberState.accounts[0].persons[0].logs.map((x: any) => x.content)).toEqual(['team', 'org', 'legacy-sensitive-team', 'legacy-public-org', 'legacy-org']);
      expect(memberState.accounts[0].opportunities[0].bis.map((x: any) => x.id)).toEqual(['bi-private', 'bi-org']);
      expect(viewerState.accounts[0].persons[0].logs.map((x: any) => x.content)).toEqual(['org', 'legacy-public-org', 'legacy-org']);
      expect(viewerState.accounts[0].opportunities[0].bis.map((x: any) => x.id)).toEqual(['bi-org']);
      const viewerCurated = await context.app.inject({
        method: 'GET', url: '/api/curated?entityKind=account&entityId=acc-acl', headers: auth(viewer.token),
      });
      expect(viewerCurated.statusCode).toBe(200);
      expect(viewerCurated.json()).toMatchObject({ content: '', status: 'restricted' });
      const memberCurated = await context.app.inject({
        method: 'GET', url: '/api/curated?entityKind=account&entityId=acc-acl', headers: auth(member.token),
      });
      expect(memberCurated.statusCode).toBe(200);
      expect(memberCurated.json().content).toBe('');

      const memberPde = await context.app.inject({ method: 'GET', url: '/api/pde/opp-acl/ev', headers: auth(member.token) });
      const viewerPde = await context.app.inject({ method: 'GET', url: '/api/pde/opp-acl/ev', headers: auth(viewer.token) });
      expect(memberPde.statusCode).toBe(200);
      expect(viewerPde.statusCode).toBe(200);
      expect(viewerPde.json().score.nominal).not.toBe(memberPde.json().score.nominal);
      const snapshots = await context.app.inject({ method: 'GET', url: '/api/pde/opp-acl/snapshots', headers: auth(viewer.token) });
      expect(snapshots.statusCode).toBe(404);

      const overwrite = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: auth(member.token),
        payload: { action: { type: 'UPDATE_PERSON', accId: 'acc-acl', personId: 'person-acl', patch: { logs: [{ date: 'x', content: 'promoted', visibility: 'org' }] } } },
      });
      expect(overwrite.statusCode).toBe(400);
    } finally { await context.cleanup(); }
  });

  it('backfills only unique tenant-local exact owners and reports ambiguous rows idempotently', async () => {
    const context = await createTestContext();
    try {
      const unique = await addUser(context, 'member', '唯一');
      await addUser(context, 'member', '重名');
      await addUser(context, 'member', '重名');
      await context.prisma.account.createMany({ data: [
        { id: 'acc-unique', tenantId: context.tenant.id, name: 'unique', customerType: 1, primaryOwner: '唯一' },
        { id: 'acc-duplicate', tenantId: context.tenant.id, name: 'duplicate', customerType: 1, primaryOwner: '重名' },
        { id: 'acc-unmatched', tenantId: context.tenant.id, name: 'unmatched', customerType: 1, primaryOwner: '不存在' },
        { id: 'acc-missing', tenantId: context.tenant.id, name: 'missing', customerType: 1, primaryOwner: '' },
      ] });
      const first = await backfillAccountOwners(context.prisma, { tenantId: context.tenant.id });
      const second = await backfillAccountOwners(context.prisma, { tenantId: context.tenant.id });
      expect((await context.prisma.account.findUniqueOrThrow({ where: { id: 'acc-unique' } })).primaryOwnerUserId).toBe(unique.user.id);
      expect(first.linked).toEqual([{ accountId: 'acc-unique', userId: unique.user.id }]);
      expect(first.manualReview.map((x) => [x.accountId, x.reason])).toEqual([
        ['acc-duplicate', 'duplicate_name'], ['acc-missing', 'missing_name'], ['acc-unmatched', 'unmatched_name'],
      ]);
      expect(second.linked).toEqual([]);
      expect(second.manualReview.map((x) => x.accountId)).toEqual(['acc-duplicate', 'acc-missing', 'acc-unmatched']);
    } finally { await context.cleanup(); }
  });

  it('keeps Account ownership as a repeatable dry-run suggestion and fails closed on ambiguous or invalid IDs', async () => {
    const context = await createTestContext();
    try {
      const suggested = await addUser(context, 'member', '稳定负责人');
      const assigned = await addUser(context, 'member', '已归属负责人');
      await addUser(context, 'member', '重名负责人');
      await addUser(context, 'member', '重名负责人');
      const foreignTenant = await context.prisma.tenant.create({ data: { id: `foreign-owner-${randomUUID()}`, name: 'Foreign owner tenant' } });
      const foreignUser = await context.prisma.user.create({ data: {
        tenantId: foreignTenant.id, email: `${randomUUID()}@foreign.test`, passwordHash: 'unused', name: 'Foreign', role: 'member',
      } });

      await context.prisma.account.createMany({ data: [
        { id: 'acc-matter-suggestion', tenantId: context.tenant.id, name: 'Suggestion', customerType: 1, primaryOwnerUserId: suggested.user.id },
        { id: 'acc-matter-duplicate', tenantId: context.tenant.id, name: 'Duplicate', customerType: 1, primaryOwner: '重名负责人' },
        { id: 'acc-matter-departed', tenantId: context.tenant.id, name: 'Departed', customerType: 1, primaryOwnerUserId: 'departed-account-owner' },
        { id: 'acc-matter-cross', tenantId: context.tenant.id, name: 'Cross tenant', customerType: 1, primaryOwnerUserId: foreignUser.id },
        { id: 'acc-matter-invalid-current', tenantId: context.tenant.id, name: 'Invalid current', customerType: 1, primaryOwnerUserId: suggested.user.id },
        { id: 'acc-matter-cross-current', tenantId: context.tenant.id, name: 'Cross current', customerType: 1, primaryOwnerUserId: suggested.user.id },
        { id: 'acc-matter-assigned', tenantId: context.tenant.id, name: 'Assigned', customerType: 1 },
        { id: 'acc-matter-unassigned', tenantId: context.tenant.id, name: 'Unassigned', customerType: 1 },
      ] });
      await context.prisma.opportunity.createMany({ data: [
        { id: 'matter-suggestion', tenantId: context.tenant.id, accountId: 'acc-matter-suggestion', name: 'Suggestion', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
        { id: 'matter-duplicate', tenantId: context.tenant.id, accountId: 'acc-matter-duplicate', name: 'Duplicate', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
        { id: 'matter-departed-account', tenantId: context.tenant.id, accountId: 'acc-matter-departed', name: 'Departed account owner', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
        { id: 'matter-cross-account', tenantId: context.tenant.id, accountId: 'acc-matter-cross', name: 'Cross account owner', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
        { id: 'matter-departed-current', tenantId: context.tenant.id, accountId: 'acc-matter-invalid-current', name: 'Departed current owner', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', primaryOwnerUserId: 'departed-matter-owner' },
        { id: 'matter-cross-current', tenantId: context.tenant.id, accountId: 'acc-matter-cross-current', name: 'Cross current owner', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', primaryOwnerUserId: foreignUser.id },
        { id: 'matter-assigned', tenantId: context.tenant.id, accountId: 'acc-matter-assigned', name: 'Assigned', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', primaryOwnerUserId: assigned.user.id },
        { id: 'matter-unassigned', tenantId: context.tenant.id, accountId: 'acc-matter-unassigned', name: 'Unassigned', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
      ] });

      const first = await inspectMatterOwnerAssignments(context.prisma, { tenantId: context.tenant.id });
      const second = await inspectMatterOwnerAssignments(context.prisma, { tenantId: context.tenant.id });
      expect(second).toEqual(first);
      expect(first).toMatchObject({ pageMatterCount: 8, pageAssignedCount: 1, pageUnassignedCount: 7 });
      expect(first.queue).toEqual([
        { tenantId: context.tenant.id, customerId: 'acc-matter-cross', matterId: 'matter-cross-account', baseVersion: 0, currentOwnerUserId: null, suggestedOwnerUserId: null, reason: 'invalid_account_owner' },
        { tenantId: context.tenant.id, customerId: 'acc-matter-cross-current', matterId: 'matter-cross-current', baseVersion: 0, currentOwnerUserId: foreignUser.id, suggestedOwnerUserId: suggested.user.id, reason: 'invalid_matter_owner' },
        { tenantId: context.tenant.id, customerId: 'acc-matter-departed', matterId: 'matter-departed-account', baseVersion: 0, currentOwnerUserId: null, suggestedOwnerUserId: null, reason: 'invalid_account_owner' },
        { tenantId: context.tenant.id, customerId: 'acc-matter-invalid-current', matterId: 'matter-departed-current', baseVersion: 0, currentOwnerUserId: 'departed-matter-owner', suggestedOwnerUserId: suggested.user.id, reason: 'invalid_matter_owner' },
        { tenantId: context.tenant.id, customerId: 'acc-matter-duplicate', matterId: 'matter-duplicate', baseVersion: 0, currentOwnerUserId: null, suggestedOwnerUserId: null, reason: 'duplicate_legacy_account_owner_name' },
        { tenantId: context.tenant.id, customerId: 'acc-matter-suggestion', matterId: 'matter-suggestion', baseVersion: 0, currentOwnerUserId: null, suggestedOwnerUserId: suggested.user.id, reason: 'account_owner_suggestion' },
        { tenantId: context.tenant.id, customerId: 'acc-matter-unassigned', matterId: 'matter-unassigned', baseVersion: 0, currentOwnerUserId: null, suggestedOwnerUserId: null, reason: 'unassigned' },
      ]);
      expect(await context.prisma.opportunity.findMany({
        where: { tenantId: context.tenant.id }, orderBy: { id: 'asc' }, select: { id: true, primaryOwnerUserId: true, version: true },
      })).toEqual([
        { id: 'matter-assigned', primaryOwnerUserId: assigned.user.id, version: 0 },
        { id: 'matter-cross-account', primaryOwnerUserId: null, version: 0 },
        { id: 'matter-cross-current', primaryOwnerUserId: foreignUser.id, version: 0 },
        { id: 'matter-departed-account', primaryOwnerUserId: null, version: 0 },
        { id: 'matter-departed-current', primaryOwnerUserId: 'departed-matter-owner', version: 0 },
        { id: 'matter-duplicate', primaryOwnerUserId: null, version: 0 },
        { id: 'matter-suggestion', primaryOwnerUserId: null, version: 0 },
        { id: 'matter-unassigned', primaryOwnerUserId: null, version: 0 },
      ]);

      const ownerQueue = await context.app.inject({ method: 'GET', url: '/api/matter-owners/unassigned', headers: auth(context.token) });
      expect(ownerQueue.statusCode).toBe(200);
      expect(ownerQueue.json()).toEqual(first);
      expect((await context.app.inject({
        method: 'GET', url: '/api/matter-owners/unassigned?limit=501', headers: auth(context.token),
      })).statusCode).toBe(400);
      const member = await addUser(context, 'member', '普通成员');
      expect((await context.app.inject({ method: 'GET', url: '/api/matter-owners/unassigned', headers: auth(member.token) })).statusCode).toBe(403);
    } finally { await context.cleanup(); }
  });

  it('batches a tenant owner report beyond SQLite parameter limits without writing assignments', async () => {
    const context = await createTestContext();
    try {
      const rows = Array.from({ length: 1005 }, (_, index) => {
        const suffix = index.toString().padStart(4, '0');
        return { accountId: `acc-owner-batch-${suffix}`, matterId: `matter-owner-batch-${suffix}` };
      });
      await context.prisma.account.createMany({ data: rows.map((row) => ({
        id: row.accountId, tenantId: context.tenant.id, name: row.accountId, customerType: 1,
      })) });
      await context.prisma.opportunity.createMany({ data: rows.map((row) => ({
        id: row.matterId, tenantId: context.tenant.id, accountId: row.accountId, name: row.matterId,
        customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
      })) });

      const pages = [];
      let cursor: string | undefined;
      do {
        const page = await inspectMatterOwnerAssignments(context.prisma, { tenantId: context.tenant.id, cursor, limit: 500 });
        pages.push(page);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(pages.map((page) => page.pageMatterCount)).toEqual([500, 500, 5]);
      expect(pages.reduce((sum, page) => sum + page.pageUnassignedCount, 0)).toBe(1005);
      expect(pages[0]?.queue[0]).toMatchObject({ matterId: 'matter-owner-batch-0000', reason: 'unassigned' });
      expect(pages.at(-1)?.queue.at(-1)).toMatchObject({ matterId: 'matter-owner-batch-1004', reason: 'unassigned' });
      expect(await context.prisma.opportunity.count({ where: {
        tenantId: context.tenant.id, primaryOwnerUserId: { not: null },
      } })).toBe(0);
    } finally { await context.cleanup(); }
  });

  it('keeps archived records out of the online queue while labeling them in the offline report', async () => {
    const context = await createTestContext();
    try {
      const archivedAt = new Date('2026-08-21T00:00:00Z');
      await context.prisma.account.createMany({ data: [
        { id: 'acc-owner-active', tenantId: context.tenant.id, name: 'Active', customerType: 1 },
        { id: 'acc-owner-archived', tenantId: context.tenant.id, name: 'Archived customer', customerType: 1, archivedAt },
      ] });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: 'matter-owner-active', tenantId: context.tenant.id, accountId: 'acc-owner-active', name: 'Active',
          customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', version: 3,
        },
        {
          id: 'matter-owner-archived', tenantId: context.tenant.id, accountId: 'acc-owner-active', name: 'Archived matter',
          customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', archivedAt,
        },
        {
          id: 'matter-owner-archived-customer', tenantId: context.tenant.id, accountId: 'acc-owner-archived', name: 'Archived customer',
          customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
        },
      ] });

      const online = await context.app.inject({
        method: 'GET', url: '/api/matter-owners/unassigned', headers: auth(context.token),
      });
      expect(online.statusCode).toBe(200);
      expect(online.json()).toMatchObject({
        pageMatterCount: 1,
        queue: [{ matterId: 'matter-owner-active', baseVersion: 3, reason: 'unassigned' }],
      });

      const offline = await inspectMatterOwnerAssignments(context.prisma, {
        tenantId: context.tenant.id, includeArchived: true,
      });
      expect(offline.pageMatterCount).toBe(3);
      expect(offline.queue).toEqual(expect.arrayContaining([
        expect.objectContaining({ matterId: 'matter-owner-archived', reason: 'archived_matter' }),
        expect.objectContaining({ matterId: 'matter-owner-archived-customer', reason: 'archived_customer' }),
      ]));
    } finally { await context.cleanup(); }
  });

  it('transfers a Matter owner with CAS, idempotency and an atomic audit while updating the stable owner predicate', async () => {
    const context = await createTestContext();
    try {
      const previous = await addUser(context, 'viewer', 'Previous');
      const next = await addUser(context, 'viewer', 'Next');
      const member = await addUser(context, 'member', 'Member');
      const foreignTenant = await context.prisma.tenant.create({ data: { id: `foreign-transfer-${randomUUID()}`, name: 'Foreign transfer tenant' } });
      const foreign = await context.prisma.user.create({ data: {
        tenantId: foreignTenant.id, email: `${randomUUID()}@foreign.test`, passwordHash: 'unused', name: 'Foreign', role: 'viewer',
      } });
      await context.prisma.account.create({ data: {
        id: 'acc-owner-transfer', tenantId: context.tenant.id, name: 'Transfer', customerType: 1, primaryOwnerUserId: previous.user.id,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'matter-owner-transfer', tenantId: context.tenant.id, accountId: 'acc-owner-transfer', name: 'Transfer', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项', primaryOwnerUserId: previous.user.id,
      } });
      expect(await userOwnsMatter(context.prisma, context.tenant.id, previous.user.id, 'matter-owner-transfer')).toBe(true);
      expect(await userOwnsMatter(context.prisma, context.tenant.id, next.user.id, 'matter-owner-transfer')).toBe(false);

      const payload = {
        type: 'TRANSFER_MATTER_OWNER', customerId: 'acc-owner-transfer', matterId: 'matter-owner-transfer', baseVersion: 0,
        fromOwnerUserId: previous.user.id, toOwnerUserId: next.user.id,
      };
      const transferred = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer', headers: { ...auth(context.token), 'idempotency-key': 'owner-transfer-1' }, payload,
      });
      expect(transferred.statusCode).toBe(200);
      expect(transferred.json()).toEqual({ matterId: 'matter-owner-transfer', primaryOwnerUserId: next.user.id, version: 1, replayed: false });
      expect(await userOwnsMatter(context.prisma, context.tenant.id, previous.user.id, 'matter-owner-transfer')).toBe(false);
      expect(await userOwnsMatter(context.prisma, context.tenant.id, next.user.id, 'matter-owner-transfer')).toBe(true);

      const audit = await context.prisma.auditEvent.findFirstOrThrow({ where: {
        tenantId: context.tenant.id, entityKind: 'matter', entityId: 'matter-owner-transfer', action: 'matter_owner_transfer',
      } });
      expect(JSON.parse(audit.changedFields)).toEqual(['primaryOwnerUserId', 'version']);
      expect(JSON.parse(audit.metadata)).toEqual({
        fromOwnerUserId: previous.user.id, toOwnerUserId: next.user.id, fromVersion: 0, toVersion: 1,
      });

      const replay = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer', headers: { ...auth(context.token), 'idempotency-key': 'owner-transfer-1' }, payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ primaryOwnerUserId: next.user.id, version: 1, replayed: true });
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'matter_owner_transfer' } })).toBe(1);

      const stale = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer', headers: { ...auth(context.token), 'idempotency-key': 'owner-transfer-stale' }, payload,
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: 'matter_owner_version_conflict' });

      const foreignTarget = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer', headers: { ...auth(context.token), 'idempotency-key': 'owner-transfer-foreign' },
        payload: { ...payload, baseVersion: 1, fromOwnerUserId: next.user.id, toOwnerUserId: foreign.id },
      });
      const missingTarget = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer', headers: { ...auth(context.token), 'idempotency-key': 'owner-transfer-missing' },
        payload: { ...payload, baseVersion: 1, fromOwnerUserId: next.user.id, toOwnerUserId: 'departed-user' },
      });
      expect(foreignTarget.statusCode).toBe(400);
      expect(missingTarget.statusCode).toBe(400);
      expect(foreignTarget.json()).toEqual(missingTarget.json());
      expect((await context.prisma.opportunity.findUniqueOrThrow({ where: { id: 'matter-owner-transfer' } }))).toMatchObject({
        primaryOwnerUserId: next.user.id, version: 1,
      });

      const memberAttempt = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer', headers: { ...auth(member.token), 'idempotency-key': 'owner-transfer-member' },
        payload: { ...payload, baseVersion: 1, fromOwnerUserId: next.user.id, toOwnerUserId: previous.user.id },
      });
      expect(memberAttempt.statusCode).toBe(404);
    } finally { await context.cleanup(); }
  });

  it('lets only the current stable member owner transfer and revokes that permission on the next request', async () => {
    const context = await createTestContext();
    try {
      const previous = await addUser(context, 'member', 'Previous member owner');
      const next = await addUser(context, 'member', 'Next member owner');
      const viewer = await addUser(context, 'viewer', 'Readonly owner');
      await context.prisma.account.create({ data: {
        id: 'acc-member-owner-transfer', tenantId: context.tenant.id, name: 'Member transfer', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'matter-member-owner-transfer', tenantId: context.tenant.id, accountId: 'acc-member-owner-transfer', name: 'Member transfer',
        customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', primaryOwnerUserId: previous.user.id,
      } });

      const first = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer',
        headers: { ...auth(previous.token), 'idempotency-key': 'member-owner-transfer-1' },
        payload: {
          type: 'TRANSFER_MATTER_OWNER', customerId: 'acc-member-owner-transfer', matterId: 'matter-member-owner-transfer',
          baseVersion: 0, fromOwnerUserId: previous.user.id, toOwnerUserId: next.user.id,
        },
      });
      expect(first.statusCode).toBe(200);

      const revoked = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer',
        headers: { ...auth(previous.token), 'idempotency-key': 'member-owner-transfer-revoked' },
        payload: {
          type: 'TRANSFER_MATTER_OWNER', customerId: 'acc-member-owner-transfer', matterId: 'matter-member-owner-transfer',
          baseVersion: 1, fromOwnerUserId: next.user.id, toOwnerUserId: previous.user.id,
        },
      });
      expect(revoked.statusCode).toBe(404);

      const unassigned = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer',
        headers: { ...auth(next.token), 'idempotency-key': 'member-owner-transfer-2' },
        payload: {
          type: 'TRANSFER_MATTER_OWNER', customerId: 'acc-member-owner-transfer', matterId: 'matter-member-owner-transfer',
          baseVersion: 1, fromOwnerUserId: next.user.id, toOwnerUserId: null,
        },
      });
      expect(unassigned.statusCode).toBe(200);
      expect(unassigned.json()).toMatchObject({ primaryOwnerUserId: null, version: 2 });
      expect(await userOwnsMatter(context.prisma, context.tenant.id, next.user.id, 'matter-member-owner-transfer')).toBe(false);

      const viewerAttempt = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer',
        headers: { ...auth(viewer.token), 'idempotency-key': 'viewer-owner-transfer' },
        payload: {
          type: 'TRANSFER_MATTER_OWNER', customerId: 'acc-member-owner-transfer', matterId: 'matter-member-owner-transfer',
          baseVersion: 2, fromOwnerUserId: null, toOwnerUserId: viewer.user.id,
        },
      });
      expect(viewerAttempt.statusCode).toBe(403);
      expect(await context.prisma.auditEvent.count({ where: {
        tenantId: context.tenant.id, action: 'matter_owner_transfer', entityId: 'matter-member-owner-transfer',
      } })).toBe(2);
    } finally { await context.cleanup(); }
  });

  it('rechecks and locks the current actor role inside the transfer transaction', async () => {
    const context = await createTestContext();
    try {
      const next = await addUser(context, 'member', 'Race target');
      for (const mode of ['deleted', 'downgraded'] as const) {
        const previous = await addUser(context, 'member', `Race ${mode}`);
        const accountId = `acc-owner-race-${mode}`;
        const matterId = `matter-owner-race-${mode}`;
        await context.prisma.account.create({ data: {
          id: accountId, tenantId: context.tenant.id, name: mode, customerType: 1,
        } });
        await context.prisma.opportunity.create({ data: {
          id: matterId, tenantId: context.tenant.id, accountId, name: mode, customerType: 1,
          pipelineStage: '线索', engageStage: '需求调研立项', primaryOwnerUserId: previous.user.id,
        } });
        if (mode === 'deleted') {
          await context.prisma.user.delete({ where: { id: previous.user.id } });
        } else {
          await context.prisma.user.update({ where: { id: previous.user.id }, data: { role: 'viewer' } });
        }

        await expect(context.prisma.$transaction((tx) => executeMatterOwnerTransfer({
          tenantId: context.tenant.id,
          actorId: previous.user.id,
          actorRole: 'member',
          channel: 'web',
          requestId: `stale-context-${mode}`,
          assertionMode: 'user_asserted',
        }, {
          type: 'TRANSFER_MATTER_OWNER', customerId: accountId, matterId, baseVersion: 0,
          fromOwnerUserId: previous.user.id, toOwnerUserId: next.user.id,
        }, tx))).rejects.toMatchObject({ statusCode: 403 });
        await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: matterId } })).resolves.toMatchObject({
          primaryOwnerUserId: previous.user.id, version: 0,
        });
        expect(await context.prisma.auditEvent.count({ where: {
          tenantId: context.tenant.id, entityId: matterId, action: 'matter_owner_transfer',
        } })).toBe(0);
      }
    } finally { await context.cleanup(); }
  });

  it('rolls back the owner CAS when its AuditEvent cannot be written', async () => {
    const context = await createTestContext();
    let triggerInstalled = false;
    try {
      const previous = await addUser(context, 'viewer', 'Previous rollback');
      const next = await addUser(context, 'viewer', 'Next rollback');
      await context.prisma.account.create({ data: {
        id: 'acc-owner-audit-rollback', tenantId: context.tenant.id, name: 'Rollback', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: 'matter-owner-audit-rollback', tenantId: context.tenant.id, accountId: 'acc-owner-audit-rollback', name: 'Rollback',
        customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', primaryOwnerUserId: previous.user.id,
      } });
      await context.prisma.$executeRawUnsafe(`
        CREATE TRIGGER fail_matter_owner_audit
        BEFORE INSERT ON AuditEvent
        WHEN NEW.action = 'matter_owner_transfer'
        BEGIN
          SELECT RAISE(ABORT, 'audit blocked');
        END
      `);
      triggerInstalled = true;

      const response = await context.app.inject({
        method: 'POST', url: '/api/commands/matter-owner-transfer',
        headers: { ...auth(context.token), 'idempotency-key': 'owner-transfer-audit-failure' },
        payload: {
          type: 'TRANSFER_MATTER_OWNER', customerId: 'acc-owner-audit-rollback', matterId: 'matter-owner-audit-rollback',
          baseVersion: 0, fromOwnerUserId: previous.user.id, toOwnerUserId: next.user.id,
        },
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(500);
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: 'matter-owner-audit-rollback' } }))
        .resolves.toMatchObject({ primaryOwnerUserId: previous.user.id, version: 0 });
      expect(await context.prisma.auditEvent.count({ where: {
        tenantId: context.tenant.id, action: 'matter_owner_transfer', entityId: 'matter-owner-audit-rollback',
      } })).toBe(0);
    } finally {
      if (triggerInstalled) await context.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_matter_owner_audit');
      await context.cleanup();
    }
  });

  it('accepts only a single log append proposal and assigns createdBy from the reviewer', async () => {
    const context = await createTestContext();
    try {
      const member = await addUser(context, 'member', 'Reviewer');
      await context.prisma.account.create({ data: { id: 'acc-log-proposal', tenantId: context.tenant.id, name: 'A', customerType: 1 } });
      await context.prisma.person.create({ data: { id: 'p-log-proposal', tenantId: context.tenant.id, accountId: 'acc-log-proposal', name: 'P', title: 'T' } });
      await context.prisma.changeProposal.create({ data: {
        id: 'cp-log-ok', tenantId: context.tenant.id, accountId: 'acc-log-proposal', entityKind: 'personLog', entityId: 'p-log-proposal', field: 'append', oldValue: '',
        newValue: JSON.stringify({ date: '2026-07-12', content: 'append-only', visibility: 'self' }), dedupeKey: 'cp-log-ok-key',
        proposedBy: member.user.id,
      } });
      await seedLegacyCandidateAuthority(context.prisma, context.tenant.id, 'ChangeProposal', 'cp-log-ok');
      const accepted = await context.app.inject({ method: 'POST', url: '/api/proposals/cp-log-ok/accept', headers: auth(member.token) });
      expect(accepted.statusCode).toBe(200);
      const logs = JSON.parse((await context.prisma.person.findUniqueOrThrow({ where: { id: 'p-log-proposal' } })).logs);
      expect(logs[0]).toMatchObject({ content: 'append-only', createdBy: member.user.id });

      await context.prisma.changeProposal.create({ data: {
        id: 'cp-log-forged', tenantId: context.tenant.id, accountId: 'acc-log-proposal', entityKind: 'personLog', entityId: 'p-log-proposal', field: 'append', oldValue: '',
        newValue: JSON.stringify({ date: '2026-07-12', content: 'forged', visibility: 'self', createdBy: context.owner.id }), dedupeKey: 'cp-log-forged-key',
        proposedBy: member.user.id,
      } });
      await seedLegacyCandidateAuthority(context.prisma, context.tenant.id, 'ChangeProposal', 'cp-log-forged');
      const forged = await context.app.inject({ method: 'POST', url: '/api/proposals/cp-log-forged/accept', headers: auth(member.token) });
      expect(forged.statusCode).toBe(400);
      expect((await context.prisma.changeProposal.findUniqueOrThrow({ where: { id: 'cp-log-forged' } })).status).toBe('pending');

      const before = (await context.prisma.person.findUniqueOrThrow({ where: { id: 'p-log-proposal' } })).logs;
      const beforeRows = JSON.parse(before);
      const legacyLog = { date: '2026-07-13', content: 'legacy append', visibility: 'team' };
      await context.prisma.changeProposal.create({ data: {
        id: 'cp-log-legacy', tenantId: context.tenant.id, accountId: 'acc-log-proposal', entityKind: 'person', entityId: 'p-log-proposal', field: 'logs',
        oldValue: before, newValue: JSON.stringify([legacyLog, ...beforeRows]), dedupeKey: 'cp-log-legacy-key',
        proposedBy: member.user.id,
      } });
      await seedLegacyCandidateAuthority(context.prisma, context.tenant.id, 'ChangeProposal', 'cp-log-legacy');
      expect((await context.app.inject({ method: 'POST', url: '/api/proposals/cp-log-legacy/accept', headers: auth(member.token) })).statusCode).toBe(200);
      const afterLegacy = JSON.parse((await context.prisma.person.findUniqueOrThrow({ where: { id: 'p-log-proposal' } })).logs);
      expect(afterLegacy[0]).toMatchObject({ content: 'legacy append', createdBy: member.user.id });
    } finally { await context.cleanup(); }
  });
});

describe('INT-403 server-owned AI context boundary', () => {
  it('binds equal-shaped manifests to tenant, actor, opportunity and normalized options', () => {
    const manifest = {
      entities: { accounts: 1, opportunities: 1, people: 2, relationships: 1, burningIssues: 0, ucvs: 0, interactionLogs: 0 },
      fieldCategories: ['account-summary'], excludedSensitiveCategories: ['raw-logs', 'form'],
    };
    const binding = {
      tenantId: 'tenant-a', actorUserId: 'actor-a', opportunityId: 'opp-a',
      options: { includeRawLogs: false, includeForm: false },
    };
    const token = contextManifestToken(manifest, binding);

    expect(contextManifestToken(manifest, binding)).toBe(token);
    expect(contextManifestToken(manifest, { ...binding, tenantId: 'tenant-b' })).not.toBe(token);
    expect(contextManifestToken(manifest, { ...binding, actorUserId: 'actor-b' })).not.toBe(token);
    expect(contextManifestToken(manifest, { ...binding, opportunityId: 'opp-b' })).not.toBe(token);
    expect(contextManifestToken(manifest, { ...binding, options: { includeRawLogs: true, includeForm: false } })).not.toBe(token);
    const defaultBinding = { tenantId: binding.tenantId, actorUserId: binding.actorUserId, opportunityId: binding.opportunityId };
    expect(contextManifestToken(manifest, defaultBinding)).toBe(token);
  });

  it('excludes memberScoped outsiders, private BI, self logs and other-opportunity data', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.create({ data: {
        id: 'ai-acc', tenantId: context.tenant.id, name: 'AI Account', customerType: 1,
      } });
      await context.prisma.person.createMany({ data: [
        {
          id: 'ai-current-person', tenantId: context.tenant.id, accountId: 'ai-acc', name: 'CURRENT-PERSON', title: 'Current',
          form: JSON.stringify({ family: 'FORM-SECRET', family7: { '籍贯': '秘密' } }),
          logs: JSON.stringify([
            { date: '2026-07-15', content: 'SELF-LOG-SECRET', visibility: 'self', createdBy: context.owner.id },
            { date: '2026-07-15', content: 'ORG-LOG-ALLOWED', visibility: 'org', createdBy: context.owner.id },
          ]),
        },
        { id: 'ai-other-person', tenantId: context.tenant.id, accountId: 'ai-acc', name: 'OTHER-OPP-PERSON', title: 'Other' },
      ] });
      await context.prisma.opportunity.createMany({ data: [
        { id: 'ai-current-opp', tenantId: context.tenant.id, accountId: 'ai-acc', name: 'Current', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true },
        { id: 'ai-other-opp', tenantId: context.tenant.id, accountId: 'ai-acc', name: 'Other', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true },
      ] });
      await context.prisma.opportunityMember.createMany({ data: [
        { tenantId: context.tenant.id, opportunityId: 'ai-current-opp', personId: 'ai-current-person' },
        { tenantId: context.tenant.id, opportunityId: 'ai-other-opp', personId: 'ai-other-person' },
      ] });
      await context.prisma.oppRole.createMany({ data: [
        { tenantId: context.tenant.id, opportunityId: 'ai-current-opp', personId: 'ai-current-person', role: 'D', sentiment: 'plus', confidence: '明确' },
        { tenantId: context.tenant.id, opportunityId: 'ai-other-opp', personId: 'ai-other-person', role: 'A', sentiment: 'star', confidence: '明确' },
      ] });
      await context.prisma.burningIssue.createMany({ data: [
        { id: 'ai-private-bi', tenantId: context.tenant.id, opportunityId: 'ai-current-opp', personId: 'ai-current-person', description: 'PRIVATE-BI-SECRET', category: 'private', isPrivate: true, confidence: '明确' },
        { id: 'ai-public-bi', tenantId: context.tenant.id, opportunityId: 'ai-current-opp', personId: 'ai-current-person', description: 'PUBLIC-BI-ALLOWED', category: 'public', isPrivate: false, confidence: '明确' },
      ] });

      const built = await buildServerAiContext({
        tenantId: context.tenant.id,
        principal: { tenantId: context.tenant.id, userId: context.owner.id, role: 'owner' },
        opportunityId: 'ai-current-opp',
        options: { includeRawLogs: true, includeForm: true },
      });
      const serialized = JSON.stringify(built.context);

      expect(built.context.people.map((person: { id: string }) => person.id)).toEqual(['ai-current-person']);
      expect(serialized).toContain('ORG-LOG-ALLOWED');
      expect(serialized).toContain('FORM-SECRET');
      expect(serialized).toContain('PUBLIC-BI-ALLOWED');
      expect(serialized).not.toContain('SELF-LOG-SECRET');
      expect(serialized).not.toContain('PRIVATE-BI-SECRET');
      expect(serialized).not.toContain('OTHER-OPP-PERSON');
      expect(built.manifest.excludedSensitiveCategories).toEqual(expect.arrayContaining(['private-bi', 'self-logs', 'outside-opportunity']));
      expect(JSON.stringify(built.manifest)).not.toContain('ALLOWED');
    } finally { await context.cleanup(); }
  });

  it('ignores client-authored context and returns an authoritative manifest from the real simulate route', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.create({ data: { id: 'ai-route-acc', tenantId: context.tenant.id, name: 'SERVER-ACCOUNT', customerType: 1 } });
      await context.prisma.person.createMany({ data: [
        { id: 'ai-route-person', tenantId: context.tenant.id, accountId: 'ai-route-acc', name: 'SERVER-PERSON', title: 'D' },
        { id: 'ai-route-outsider', tenantId: context.tenant.id, accountId: 'ai-route-acc', name: 'OUTSIDE-FOCUS-SECRET', title: 'Other' },
      ] });
      await context.prisma.opportunity.create({ data: { id: 'ai-route-opp', tenantId: context.tenant.id, accountId: 'ai-route-acc', name: 'SERVER-OPP', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true } });
      await context.prisma.opportunityMember.create({ data: { tenantId: context.tenant.id, opportunityId: 'ai-route-opp', personId: 'ai-route-person' } });
      await context.prisma.oppRole.create({ data: { tenantId: context.tenant.id, opportunityId: 'ai-route-opp', personId: 'ai-route-person', role: 'D', sentiment: 'plus', confidence: '明确' } });
      await context.prisma.aiConfig.create({ data: { tenantId: context.tenant.id, provider: 'mock', baseUrl: '', model: '', apiKeyEnc: '' } });

      const preflight = await context.app.inject({
        method: 'POST', url: '/api/ai/context-manifest', headers: auth(context.token),
        payload: { opportunityId: 'ai-route-opp', options: { includeRawLogs: false, includeForm: false } },
      });
      expect(preflight.statusCode).toBe(200);
      expect(preflight.json().manifest).toEqual(expect.objectContaining({ entities: expect.objectContaining({ people: 1 }) }));
      expect(preflight.json().manifestToken).toMatch(/^[a-f0-9]{64}$/);
      expect(preflight.body).not.toContain('SERVER-PERSON');

      const member = await addUser(context, 'member', 'Second actor');
      const memberPreflight = await context.app.inject({
        method: 'POST', url: '/api/ai/context-manifest', headers: auth(member.token),
        payload: { opportunityId: 'ai-route-opp', options: { includeRawLogs: false, includeForm: false } },
      });
      expect(memberPreflight.statusCode).toBe(200);
      expect(memberPreflight.json().manifest).toEqual(preflight.json().manifest);
      expect(memberPreflight.json().manifestToken).not.toBe(preflight.json().manifestToken);
      const replayedActorToken = await context.app.inject({
        method: 'POST', url: '/api/ai/simulate', headers: auth(member.token),
        payload: {
          opportunityId: 'ai-route-opp', focusPersonId: 'ai-route-person', hypothesis: '测试',
          options: { includeRawLogs: false, includeForm: false }, manifestToken: preflight.json().manifestToken,
        },
      });
      expect(replayedActorToken.statusCode).toBe(409);
      expect(replayedActorToken.body).not.toContain('SERVER-PERSON');

      const response = await context.app.inject({
        method: 'POST', url: '/api/ai/simulate', headers: auth(context.token),
        payload: {
          opportunityId: 'ai-route-opp', focusPersonId: 'ai-route-person', hypothesis: '测试', options: { includeRawLogs: false, includeForm: false },
          manifestToken: preflight.json().manifestToken,
          context: { account: { name: 'CLIENT-FORGED-SECRET' }, people: [{ name: 'CLIENT-FORGED-PERSON' }] },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('SERVER-PERSON');
      expect(response.body).not.toContain('CLIENT-FORGED');
      expect(response.json().manifest).toMatchObject({
        entities: { accounts: 1, opportunities: 1, people: 1 },
        excludedSensitiveCategories: expect.arrayContaining(['raw-logs', 'form']),
      });

      const outsideFocus = await context.app.inject({
        method: 'POST', url: '/api/ai/simulate', headers: auth(context.token),
        payload: {
          opportunityId: 'ai-route-opp', focusPersonId: 'ai-route-outsider', hypothesis: '测试',
          options: { includeRawLogs: false, includeForm: false },
          manifestToken: preflight.json().manifestToken,
        },
      });
      expect(outsideFocus.statusCode).toBe(404);
      expect(outsideFocus.body).not.toContain('OUTSIDE-FOCUS-SECRET');

      await context.prisma.opportunityMember.create({ data: {
        tenantId: context.tenant.id, opportunityId: 'ai-route-opp', personId: 'ai-route-outsider',
      } });
      const stalePreview = await context.app.inject({
        method: 'POST', url: '/api/ai/simulate', headers: auth(context.token),
        payload: {
          opportunityId: 'ai-route-opp', focusPersonId: 'ai-route-person', hypothesis: '测试',
          options: { includeRawLogs: false, includeForm: false }, manifestToken: preflight.json().manifestToken,
        },
      });
      expect(stalePreview.statusCode).toBe(409);
      expect(stalePreview.body).not.toContain('OUTSIDE-FOCUS-SECRET');
    } finally { await context.cleanup(); }
  });

  it('rebuilds context and returns a manifest across all strategy model entry points', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.create({ data: { id: 'ai-strategy-acc', tenantId: context.tenant.id, name: 'Strategy', customerType: 1 } });
      await context.prisma.person.create({ data: { id: 'ai-strategy-person', tenantId: context.tenant.id, accountId: 'ai-strategy-acc', name: 'REAL-FOCUS', title: 'D' } });
      await context.prisma.opportunity.create({ data: { id: 'ai-strategy-opp', tenantId: context.tenant.id, accountId: 'ai-strategy-acc', name: 'Strategy Opp', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' } });
      await context.prisma.oppRole.create({ data: { tenantId: context.tenant.id, opportunityId: 'ai-strategy-opp', personId: 'ai-strategy-person', role: 'D', sentiment: 'plus', confidence: '明确' } });
      await context.prisma.aiConfig.create({ data: { tenantId: context.tenant.id, provider: 'mock', baseUrl: '', model: '', apiKeyEnc: '' } });
      const options = { includeRawLogs: false, includeForm: false };
      const preflight = await context.app.inject({
        method: 'POST', url: '/api/ai/context-manifest', headers: auth(context.token),
        payload: { opportunityId: 'ai-strategy-opp', options },
      });
      expect(preflight.statusCode).toBe(200);
      const manifestToken = preflight.json().manifestToken as string;
      const cases = [
        { url: '/api/strategy/suggest', payload: { opportunityId: 'ai-strategy-opp', mode: 'forward', options, manifestToken, context: { people: [{ name: 'FORGED' }] } } },
        { url: '/api/strategy/actions', payload: { opportunityId: 'ai-strategy-opp', focusPersonId: 'ai-strategy-person', options, manifestToken, context: { people: [{ name: 'FORGED' }] } } },
        { url: '/api/strategy/prefill', payload: { opportunityId: 'ai-strategy-opp', card: { title: '策略' }, personId: 'ai-strategy-person', options, manifestToken, context: { people: [{ name: 'FORGED' }] } } },
        { url: '/api/strategy/milestone-actions', payload: { opportunityId: 'ai-strategy-opp', milestone: { title: '签约' }, options, manifestToken, context: { people: [{ name: 'FORGED' }] }, existingTitles: [] } },
      ];
      for (const testCase of cases) {
        const response = await context.app.inject({ method: 'POST', url: testCase.url, headers: auth(context.token), payload: testCase.payload });
        expect(response.statusCode, `${testCase.url}: ${response.body}`).toBe(200);
        expect(response.json().manifest).toMatchObject({ entities: { accounts: 1, opportunities: 1, people: 1 } });
        expect(response.body).not.toContain('FORGED');
      }
    } finally { await context.cleanup(); }
  });

  it('fails closed for foreign-tenant opportunities and viewers across preflight and model routes', async () => {
    const context = await createTestContext();
    try {
      const foreignTenant = await context.prisma.tenant.create({ data: { id: `foreign-ai-${randomUUID()}`, name: 'Foreign AI' } });
      await context.prisma.account.create({ data: { id: 'foreign-ai-acc', tenantId: foreignTenant.id, name: 'FOREIGN-ACCOUNT-SECRET', customerType: 1 } });
      await context.prisma.person.create({ data: { id: 'foreign-ai-person', tenantId: foreignTenant.id, accountId: 'foreign-ai-acc', name: 'FOREIGN-PERSON-SECRET', title: 'D' } });
      await context.prisma.opportunity.create({ data: {
        id: 'foreign-ai-opp', tenantId: foreignTenant.id, accountId: 'foreign-ai-acc', name: 'FOREIGN-OPP-SECRET',
        customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
      } });

      await context.prisma.account.create({ data: { id: 'viewer-ai-acc', tenantId: context.tenant.id, name: 'Viewer account', customerType: 1 } });
      await context.prisma.person.create({ data: { id: 'viewer-ai-person', tenantId: context.tenant.id, accountId: 'viewer-ai-acc', name: 'Viewer person', title: 'D' } });
      await context.prisma.opportunity.create({ data: {
        id: 'viewer-ai-opp', tenantId: context.tenant.id, accountId: 'viewer-ai-acc', name: 'Viewer opp',
        customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项',
      } });
      const viewer = await addUser(context, 'viewer', 'AI viewer');
      const options = { includeRawLogs: false, includeForm: false };
      const token = '0'.repeat(64);
      const routeCases = (opportunityId: string) => [
        { url: '/api/ai/context-manifest', payload: { opportunityId, options } },
        { url: '/api/ai/simulate', payload: { opportunityId, focusPersonId: 'foreign-ai-person', hypothesis: '测试', options, manifestToken: token } },
        { url: '/api/strategy/suggest', payload: { opportunityId, mode: 'forward', options, manifestToken: token } },
        { url: '/api/strategy/actions', payload: { opportunityId, focusPersonId: 'foreign-ai-person', options, manifestToken: token } },
        { url: '/api/strategy/prefill', payload: { opportunityId, card: { title: '策略' }, options, manifestToken: token } },
        { url: '/api/strategy/milestone-actions', payload: { opportunityId, milestone: { title: '签约' }, options, manifestToken: token, existingTitles: [] } },
      ];

      for (const testCase of routeCases('foreign-ai-opp')) {
        const response = await context.app.inject({ method: 'POST', url: testCase.url, headers: auth(context.token), payload: testCase.payload });
        expect(response.statusCode, `${testCase.url}: ${response.body}`).toBe(404);
        expect(response.body).not.toContain('FOREIGN-');
      }
      for (const testCase of routeCases('viewer-ai-opp')) {
        const response = await context.app.inject({ method: 'POST', url: testCase.url, headers: auth(viewer.token), payload: testCase.payload });
        expect(response.statusCode, `${testCase.url}: ${response.body}`).toBe(403);
      }
    } finally { await context.cleanup(); }
  });
});
