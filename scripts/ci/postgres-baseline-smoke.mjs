// Copied into /app in the disposable CORE-215 container; executed through tsx.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPersonCandidate, personCandidateDedupeKey } from './src/candidates/personRelation.ts';

const url = new URL(process.env.DATABASE_URL);
assert.equal(process.env.CI_CURRENT_BASELINE, '1');
assert.equal(url.hostname, 'db');
assert.ok(['/core215_baseline', '/jianghu_restore_core215'].includes(url.pathname));
const db = new PrismaClient();
const request = async (path, { token, body, key, expected = 200 } = {}) => {
  const response = await fetch(`http://127.0.0.1:3001${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  assert.equal(response.status, expected, `${path}: status ${response.status}`);
  return result;
};

try {
  if (process.argv[2] === 'seed') {
    assert.equal(await db.tenant.count(), 0, 'fixture requires an empty task-owned database');
    const accounts = [];
    for (const suffix of ['a', 'b']) {
      const auth = await request('/api/auth/register', { body: {
        email: `core215-${suffix}@example.test`, password: 'core215-fixture-password',
        name: `CORE-215 ${suffix}`,
      } });
      const customerId = `customer_${createHash('sha256').update(`core215-${suffix}`).digest('hex').slice(0, 32)}`;
      const command = { type: 'CREATE_CUSTOMER', customer: { id: customerId,
        name: `CORE-215 synthetic customer ${suffix}`, categoryKey: null, primaryOwnerUserId: auth.user.id } };
      const key = `core215-customer-${suffix}`;
      const first = await request('/api/commands/customer', { token: auth.token, body: command, key });
      assert.equal(first.replayed, false);
      assert.equal((await request('/api/commands/customer', { token: auth.token, body: command, key })).replayed, true);
      accounts.push({ ...auth, customerId });
    }
    const [left, right] = accounts;
    assert.notEqual(left.tenant.id, right.tenant.id);
    for (const [own, other] of [[left, right], [right, left]]) {
      const context = JSON.stringify(await request('/api/crm/context', { token: own.token }));
      assert.ok(context.includes(own.customerId));
      assert.ok(!context.includes(other.customerId), 'cross-tenant context leaked');
    }
    for (const suffix of ['accept', 'pending']) {
      const input = { id: `core215-person-${suffix}`, tenantId: left.tenant.id,
        accountId: left.customerId, matterId: null, name: `Synthetic ${suffix}`, title: 'Unknown',
        orgLevel: 3, source: 'mcp', sourceRef: `core215:synthetic:${suffix}`,
        evidence: 'Synthetic test source; human review required', confidence: 0.6,
        createdByUserId: left.user.id,
        dedupeKey: personCandidateDedupeKey(left.customerId, `Synthetic ${suffix}`) };
      const first = await createPersonCandidate(db, input);
      const replay = await createPersonCandidate(db, { ...input, id: `${input.id}-replay` });
      assert.equal(first.created, true);
      assert.equal(replay.candidateId, first.candidateId);
    }
    assert.equal(await db.person.count(), 0, 'candidate producer wrote formal data');
    await request('/api/suggest/persons/core215-person-accept/accept', { token: right.token, body: {}, expected: 404 });
    assert.equal(await db.person.count(), 0);
    await request('/api/suggest/persons/core215-person-accept/accept', { token: left.token, body: {} });
    await request('/api/suggest/persons/core215-person-accept/accept', { token: left.token, body: {}, expected: 409 });
    assert.equal(await db.person.count(), 1);
    await db.user.update({ where: { id: left.user.id }, data: { role: 'viewer' } });
    await request('/api/suggest/persons/core215-person-pending/accept', { token: left.token, body: {}, expected: 403 });
    assert.equal(await db.person.count(), 1);
    console.log('CURRENT_BASELINE_TENANT_REVIEW_IDEMPOTENCY_OK=1');
    const matterId = `matter_${'b'.repeat(32)}`;
    const personal = (body, key) => request('/api/commands/personal-workbench', { token: right.token, body, key });
    const created = { type: 'CREATE_PERSONAL_MATTER', customerId: right.customerId, matterId,
      title: 'CORE-210 synthetic opportunity', customerBusinessGoal: 'Synthetic delivery goal', salesProgress: null, priority: 'high' };
    await personal(created, 'core210-personal-matter');
    assert.equal((await personal(created, 'core210-personal-matter')).replayed, true);
    const people = ['c', 'd'].map(value => `person_${value.repeat(32)}`);
    for (const personId of people) await personal({ type: 'CREATE_MATTER_PERSON', customerId: right.customerId, matterId,
      personId, name: `Synthetic ${personId.slice(-1)}`, title: 'Contact', decisionRole: null }, `core210-${personId}`);
    await personal({ type: 'CREATE_PERSONAL_RELATION', customerId: right.customerId, matterId,
      relationId: `relation_${'e'.repeat(32)}`, sourcePersonId: people[0], targetPersonId: people[1], label: 'Reported introduction', directed: true,
      basis: { statement: 'Synthetic reported source', assertionType: 'reported', sourceDescription: 'Synthetic manual record', occurredAt: null } }, 'core210-relation');
    const basis = await db.intelligenceItem.findFirstOrThrow({ where: { tenantId: right.tenant.id, matterId } });
    await personal({ type: 'SET_PERSON_DECISION_ROLE', customerId: right.customerId, matterId, personId: people[0],
      baseVersion: 0, decisionRole: 'Reported facilitator', basis: { id: basis.id, version: basis.version } }, 'core210-role');
    await personal({ type: 'UPDATE_PERSONAL_MATTER', customerId: right.customerId, matterId, baseVersion: 0,
      patch: { salesProgress: 'Manual validation', lifecycle: 'paused' } }, 'core210-stage');
    await request('/api/commands/commitment', { token: right.token, key: 'core210-commitment', body: { type: 'CREATE_COMMITMENT', commitment: {
      id: `commitment_${'f'.repeat(32)}`, customerId: right.customerId, matterId, personId: people[0],
      title: 'Synthetic next conversation', expectedSignal: 'Synthetic observed response', kind: 'follow_up', ownerUserId: right.user.id,
      confirmationStatus: 'not_required', scheduledAtUtc: '2026-09-08T01:00:00.000Z', dueAtUtc: null, timeZone: 'Asia/Shanghai',
      isAllDay: false, localDate: null, confirmationDueAtUtc: null, source: 'manual', sourceRef: null,
    } } });
    const detail = await request(`/api/personal-workbench/${matterId}`, { token: right.token });
    assert.equal(detail.opportunity.salesProgress, 'Manual validation');
    assert.equal(detail.workspace.matter.lifecycleStatus, 'paused');
    assert.equal(detail.participants.find(item => item.personId === people[0]).basisState, 'current');
    assert.equal(detail.commitments[0].expectedSignal, 'Synthetic observed response');
    await request(`/api/personal-workbench/${matterId}`, { token: left.token, expected: 404 });
    console.log('CURRENT_BASELINE_PERSONAL_WORKBENCH_OK=1');
  } else {
    assert.equal(process.argv[2], 'verify');
  }
  assert.equal(await db.tenant.count(), 2);
  assert.equal(await db.account.count(), 2);
  assert.equal(await db.person.count(), 3);
  assert.equal(await db.opportunity.count(), 1);
  assert.equal(await db.matterParticipant.count(), 2);
  assert.equal(await db.edge.count(), 1);
  assert.equal(await db.planAction.count(), 1);
  assert.equal(await db.intelligenceItem.count(), 1);
  assert.equal(await db.candidate.count({ where: { status: 'pending' } }), 1);
  assert.equal(await db.candidate.count({ where: { status: 'accepted' } }), 1);
  assert.equal(await db.auditEvent.count({ where: { action: 'customer_created' } }), 2);
  assert.equal(await db.commandRun.count({ where: { kind: 'customer', status: 'completed' } }), 2);
  const records = {};
  for (const model of ['tenant', 'user', 'account', 'person', 'candidate', 'auditEvent', 'commandRun',
    'opportunity', 'matterParticipant', 'edge', 'planAction', 'intelligenceItem', 'pdeDecisionContext']) {
    records[model] = await db[model].findMany({ orderBy: { id: 'asc' } });
  }
  console.log(`CURRENT_BASELINE_DATA_SHA256=${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`);
} finally { await db.$disconnect(); }
