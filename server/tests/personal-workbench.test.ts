import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersonalWorkbenchDetailSchema } from '@jianghu/domain-contracts';
import { executePersonalCommand } from '../src/personalWorkbench/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
describe('CORE-210 personal workbench: real commands, scope, sources and persistence', () => {
  let test: TestContext;
  let customerId: string;
  const headers = (key = randomUUID(), token = test.token) => ({ authorization: `Bearer ${token}`, 'idempotency-key': key });
  const command = (payload: Record<string, unknown>, key = randomUUID(), token = test.token) => test.app.inject({
    method: 'POST', url: '/api/commands/personal-workbench', headers: headers(key, token), payload,
  });
  const detail = (matterId: string, token = test.token) => test.app.inject({ method: 'GET', url: `/api/personal-workbench/${matterId}`, headers: headers(randomUUID(), token) });
  const createPayload = (matterId = id('matter')) => ({ type: 'CREATE_PERSONAL_MATTER' as const, customerId, matterId,
    title: '滨海项目平台', customerBusinessGoal: '缩短项目交付周期', salesProgress: null, priority: null });
  const personPayload = (matterId: string, personId = id('person')) => ({ type: 'CREATE_MATTER_PERSON' as const,
    customerId, matterId, personId, name: '王主任', title: '技术负责人', decisionRole: null });
  async function createMatter() {
    const input = createPayload();
    const response = await command(input);
    expect(response.statusCode, response.body).toBe(200);
    return input.matterId;
  }
  beforeEach(async () => {
    test = await createTestContext({ productAccess: { edition: 'commercial' } });
    await test.prisma.tenant.update({ where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' } });
    customerId = id('customer');
    const result = await test.app.inject({ method: 'POST', url: '/api/commands/customer', headers: headers(), payload: {
      type: 'CREATE_CUSTOMER', customer: { id: customerId, name: '滨海建设集团', categoryKey: null, primaryOwnerUserId: test.owner.id },
    } });
    expect(result.statusCode, result.body).toBe(200);
  });
  afterEach(async () => test.cleanup());

  it('keeps a lead on one Matter, permits manual stage rollback/pause/reopen and preserves methodology fields', async () => {
    const input = createPayload(), key = randomUUID();
    const first = await command(input, key), replay = await command(input, key);
    expect(first.statusCode, first.body).toBe(200);
    expect(replay.json()).toEqual({ ...first.json(), replayed: true });
    expect((await command({ ...input, title: 'Changed' }, key)).statusCode).toBe(409);
    const before = await test.prisma.opportunity.findUniqueOrThrow({ where: { id: input.matterId } });
    const pde = await test.prisma.pdeDecisionContext.findFirstOrThrow({ where: { opportunityId: input.matterId } });
    let version = 0;
    for (const patch of [{ salesProgress: '方案沟通' }, { lifecycle: 'paused' }, { lifecycle: 'active' }, { salesProgress: null }, { lifecycle: 'won' }, { lifecycle: 'active' }]) {
      const response = await command({ type: 'UPDATE_PERSONAL_MATTER', customerId, matterId: input.matterId, baseVersion: version++, patch });
      expect(response.statusCode, response.body).toBe(200);
    }
    const after = await test.prisma.opportunity.findUniqueOrThrow({ where: { id: input.matterId } });
    expect(after).toMatchObject({ salesProgress: null, lifecycleStatus: 'active', status: 'active', outcomeKey: null, version });
    expect([after.pipelineStage, after.engageStage, after.activeMethodologyBindingId, after.primaryDPersonId])
      .toEqual([before.pipelineStage, before.engageStage, null, null]);
    expect(await test.prisma.pdeDecisionContext.findUniqueOrThrow({ where: { id: pde.id } })).toEqual(pde);
    expect(await test.prisma.methodologyBinding.count()).toBe(0);
    const view = await detail(input.matterId);
    expect(view.statusCode, view.body).toBe(200);
    expect(PersonalWorkbenchDetailSchema.parse(view.json()).workspace.people).toEqual([]);
    expect(view.headers['cache-control']).toBe('private, no-store');
    expect(view.body).not.toMatch(/winProbability|pipelineStage|engageStage|primaryDPersonId/);
    const logs = JSON.stringify(await test.prisma.commandRun.findMany());
    expect(logs).not.toContain(input.customerBusinessGoal);
    expect(logs).not.toContain('方案沟通');
  });

  it('enforces CAS, rejects context/body injection and permits no writes or human assertions from Agent contexts', async () => {
    const matterId = await createMatter();
    const edits = await Promise.all(['确认需求', '方案沟通'].map(salesProgress => command({
      type: 'UPDATE_PERSONAL_MATTER', customerId, matterId, baseVersion: 0, patch: { salesProgress },
    })));
    expect(edits.map(result => result.statusCode).sort()).toEqual([200, 409]);
    expect((await command({ ...personPayload(matterId), tenantId: 'injected', assertionMode: 'user_asserted' })).statusCode).toBe(400);
    const counts = [await test.prisma.person.count(), await test.prisma.auditEvent.count()];
    await expect(test.prisma.$transaction(tx => executePersonalCommand(tx, {
      tenantId: test.tenant.id, actorId: test.owner.id, actorRole: 'owner', channel: 'mcp', assertionMode: 'user_asserted', requestId: randomUUID(),
    }, { entitlements: ['crm.core'], permissions: [] }, personPayload(matterId)), { isolationLevel: 'Serializable' }))
      .rejects.toMatchObject({ code: 'human_write_required', statusCode: 403 });
    expect([await test.prisma.person.count(), await test.prisma.auditEvent.count()]).toEqual(counts);
    expect((await command(personPayload(matterId), randomUUID(), 'jh_synthetic_not_a_JWT')).statusCode).toBe(401);
    for (const url of ['/api/state', '/api/members', '/api/methodology/g64111']) {
      expect((await test.app.inject({ method: 'GET', url, headers: headers() })).statusCode).toBe(403);
    }
  });

  it('keeps one real Person with independent roles in two Matters and hides stale or archived basis text', async () => {
    const matterA = await createMatter(), matterB = await createMatter();
    const person = personPayload(matterA);
    expect((await command(person)).statusCode).toBe(200);
    expect((await command({ type: 'JOIN_MATTER_PERSON', customerId, matterId: matterB, personId: person.personId })).statusCode).toBe(200);
    const intelligenceId = id('intel');
    const recorded = await test.app.inject({ method: 'POST', url: '/api/commands/intelligence-item', headers: headers(), payload: {
      type: 'CREATE_INTELLIGENCE_ITEM', item: { id: intelligenceId, customerId, matterId: matterA, statement: '王主任表示愿意引荐业务负责人',
        assertionType: 'reported', source: { kind: 'manual', description: '会后本人记录' }, confidence: 0.5,
        learnedAt: new Date().toISOString(), targets: [{ kind: 'person', id: person.personId }],
      },
    } });
    expect(recorded.statusCode, recorded.body).toBe(200);
    const roleCommand = { type: 'SET_PERSON_DECISION_ROLE' as const, customerId, matterId: matterA, personId: person.personId,
      baseVersion: 0, decisionRole: '愿意推动业务沟通', basis: { id: intelligenceId, version: 0 } };
    const key = randomUUID();
    expect((await command(roleCommand, key)).statusCode).toBe(200);
    expect((await command({ ...roleCommand, matterId: matterB })).statusCode).toBe(409);
    expect((await command({ ...roleCommand, matterId: matterB, decisionRole: '技术评估', basis: null })).statusCode).toBe(200);
    expect((await detail(matterA)).json().participants[0]).toMatchObject({ decisionRole: roleCommand.decisionRole, basisState: 'current' });
    expect((await detail(matterB)).json().participants[0]).toMatchObject({ decisionRole: '技术评估', basisState: 'unverified' });
    await test.prisma.intelligenceItem.update({ where: { id: intelligenceId }, data: { version: { increment: 1 }, statement: '来源已更新' } });
    const stale = await detail(matterA);
    expect(stale.statusCode, stale.body).toBe(200);
    expect(stale.json().participants[0]).toMatchObject({ decisionRole: null, basis: null, basisState: 'needs_review' });
    expect(stale.body).not.toContain(roleCommand.decisionRole);
    expect((await command(roleCommand, key)).statusCode).toBe(409);
    await test.prisma.intelligenceItem.update({ where: { id: intelligenceId }, data: { archivedAt: new Date(), archivedByUserId: test.owner.id } });
    const revoked = await detail(matterA);
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.body).not.toContain('来源已更新');
    expect(await test.prisma.person.count()).toBe(1);
    expect(await test.prisma.oppRole.count()).toBe(0);
  });

  it('creates a user-recorded relation and source atomically, and never combines people across Matters', async () => {
    const matterId = await createMatter(), otherId = await createMatter();
    const a = personPayload(matterId), b = { ...personPayload(matterId), name: '李总' }, outside = personPayload(otherId);
    for (const person of [a, b, outside]) expect((await command(person)).statusCode).toBe(200);
    const relation = { type: 'CREATE_PERSONAL_RELATION' as const, customerId, matterId, relationId: id('relation'),
      sourcePersonId: a.personId, targetPersonId: b.personId, directed: true, label: '愿意引荐',
      basis: { statement: '王主任说可安排与李总沟通', assertionType: 'reported' as const, sourceDescription: '人工沟通记录', occurredAt: null } };
    const key = randomUUID();
    const saved = await command(relation, key);
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await command(relation, key)).json().replayed).toBe(true);
    expect(await test.prisma.edge.count()).toBe(1);
    expect(await test.prisma.intelligenceItem.count()).toBe(1);
    expect((await command({ ...relation, relationId: id('relation'), targetPersonId: outside.personId })).statusCode).toBe(404);
    const view = await detail(matterId);
    expect(view.json().workspace.intelligence[0]).toMatchObject({ assertionType: 'reported', statement: relation.basis.statement });
    const before = [await test.prisma.edge.count(), await test.prisma.intelligenceItem.count(), await test.prisma.auditEvent.count()];
    await test.prisma.$executeRawUnsafe(`CREATE TRIGGER core210_reject_intelligence BEFORE INSERT ON "IntelligenceItem"
      WHEN NEW.statement = 'CORE210 injected failure' BEGIN SELECT RAISE(ABORT, 'synthetic intelligence failure'); END`);
    try {
      const failed = await command({ ...relation, relationId: id('relation'), basis: { ...relation.basis, statement: 'CORE210 injected failure' } });
      expect(failed.statusCode).toBe(503);
      expect([await test.prisma.edge.count(), await test.prisma.intelligenceItem.count(), await test.prisma.auditEvent.count()]).toEqual(before);
    } finally { await test.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS core210_reject_intelligence'); }
  });

  it('rejects another tenant, hidden same-tenant parents and revoked actor roles on reads, writes and replay', async () => {
    const input = createPayload(), key = randomUUID();
    expect((await command(input, key)).statusCode).toBe(200);
    const second = await test.app.inject({ method: 'POST', url: '/api/auth/register', payload: {
      name: '隔离账户', email: 'core210-isolated@example.test', password: 'isolated-password',
    } });
    const foreignToken = second.json().token;
    expect((await detail(input.matterId, foreignToken)).statusCode).toBe(404);
    expect((await command(personPayload(input.matterId), randomUUID(), foreignToken)).statusCode).toBe(404);
    const empty = await test.app.inject({ method: 'GET', url: '/api/personal-workbench', headers: headers(randomUUID(), foreignToken) });
    expect(empty.json().entries).toEqual([]);
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'member' } });
    await test.prisma.account.update({ where: { id: customerId }, data: { primaryOwnerUserId: null } });
    await test.prisma.opportunity.update({ where: { id: input.matterId }, data: { primaryOwnerUserId: null } });
    expect((await detail(input.matterId)).statusCode).toBe(404);
    expect((await command(input, key)).statusCode).toBe(404);
    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    expect((await command(input, key)).statusCode).toBe(403);
    expect(await test.prisma.opportunity.count()).toBe(1);
  });

  it('stores action purpose, object, time and expectation in the existing Commitment and replays once', async () => {
    const matterId = await createMatter(), person = personPayload(matterId);
    expect((await command(person)).statusCode).toBe(200);
    const payload = { type: 'CREATE_COMMITMENT', commitment: {
      id: id('commitment'), customerId, matterId, personId: person.personId, title: '请王主任引荐李总',
      expectedSignal: '李总接受业务目标沟通邀请', kind: 'follow_up', ownerUserId: test.owner.id,
      confirmationStatus: 'not_required', scheduledAtUtc: '2026-09-07T01:00:00.000Z', dueAtUtc: null,
      timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null, confirmationDueAtUtc: null,
      source: 'manual', sourceRef: null,
    } };
    const key = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await test.app.inject({ method: 'POST', url: '/api/commands/commitment', headers: headers(key), payload });
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().replayed).toBe(attempt > 0);
    }
    const row = await test.prisma.planAction.findUniqueOrThrow({ where: { id: payload.commitment.id } });
    expect(row.target).toBe(payload.commitment.expectedSignal);
    expect(await test.prisma.planAction.count()).toBe(1);
    expect((await detail(matterId)).json().commitments[0]).toMatchObject({ id: row.id, expectedSignal: row.target });
    const list = await test.app.inject({ method: 'GET', url: '/api/personal-workbench', headers: headers() });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().entries[0].nextCommitment).toMatchObject({ id: row.id, expectedSignal: row.target });
  });
});
