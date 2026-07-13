import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { backfillAccountOwners } from '../scripts/backfill-account-owners.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

function auth(token: string) { return { authorization: `Bearer ${token}` }; }

async function addUser(context: TestContext, role: 'member' | 'viewer', name: string) {
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

  it('accepts only a single log append proposal and assigns createdBy from the reviewer', async () => {
    const context = await createTestContext();
    try {
      const member = await addUser(context, 'member', 'Reviewer');
      await context.prisma.account.create({ data: { id: 'acc-log-proposal', tenantId: context.tenant.id, name: 'A', customerType: 1 } });
      await context.prisma.person.create({ data: { id: 'p-log-proposal', tenantId: context.tenant.id, accountId: 'acc-log-proposal', name: 'P', title: 'T' } });
      await context.prisma.changeProposal.create({ data: {
        id: 'cp-log-ok', tenantId: context.tenant.id, accountId: 'acc-log-proposal', entityKind: 'personLog', entityId: 'p-log-proposal', field: 'append', oldValue: '',
        newValue: JSON.stringify({ date: '2026-07-12', content: 'append-only', visibility: 'self' }), dedupeKey: 'cp-log-ok-key',
      } });
      const accepted = await context.app.inject({ method: 'POST', url: '/api/proposals/cp-log-ok/accept', headers: auth(member.token) });
      expect(accepted.statusCode).toBe(200);
      const logs = JSON.parse((await context.prisma.person.findUniqueOrThrow({ where: { id: 'p-log-proposal' } })).logs);
      expect(logs[0]).toMatchObject({ content: 'append-only', createdBy: member.user.id });

      await context.prisma.changeProposal.create({ data: {
        id: 'cp-log-forged', tenantId: context.tenant.id, accountId: 'acc-log-proposal', entityKind: 'personLog', entityId: 'p-log-proposal', field: 'append', oldValue: '',
        newValue: JSON.stringify({ date: '2026-07-12', content: 'forged', visibility: 'self', createdBy: context.owner.id }), dedupeKey: 'cp-log-forged-key',
      } });
      const forged = await context.app.inject({ method: 'POST', url: '/api/proposals/cp-log-forged/accept', headers: auth(member.token) });
      expect(forged.statusCode).toBe(400);
      expect((await context.prisma.changeProposal.findUniqueOrThrow({ where: { id: 'cp-log-forged' } })).status).toBe('pending');

      const before = (await context.prisma.person.findUniqueOrThrow({ where: { id: 'p-log-proposal' } })).logs;
      const beforeRows = JSON.parse(before);
      const legacyLog = { date: '2026-07-13', content: 'legacy append', visibility: 'team' };
      await context.prisma.changeProposal.create({ data: {
        id: 'cp-log-legacy', tenantId: context.tenant.id, accountId: 'acc-log-proposal', entityKind: 'person', entityId: 'p-log-proposal', field: 'logs',
        oldValue: before, newValue: JSON.stringify([legacyLog, ...beforeRows]), dedupeKey: 'cp-log-legacy-key',
      } });
      expect((await context.app.inject({ method: 'POST', url: '/api/proposals/cp-log-legacy/accept', headers: auth(member.token) })).statusCode).toBe(200);
      const afterLegacy = JSON.parse((await context.prisma.person.findUniqueOrThrow({ where: { id: 'p-log-proposal' } })).logs);
      expect(afterLegacy[0]).toMatchObject({ content: 'legacy append', createdBy: member.user.id });
    } finally { await context.cleanup(); }
  });
});
