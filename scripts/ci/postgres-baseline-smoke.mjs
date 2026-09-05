// Copied into /app in the disposable CORE-215 container; executed through tsx.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPersonCandidate } from './src/candidates/personRelation.ts';

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
        name: `CORE-215 ${suffix}`, tenantName: `CORE-215 synthetic ${suffix}`,
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
        createdByUserId: left.user.id, dedupeKey: `core215-person-${suffix}` };
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
  } else {
    assert.equal(process.argv[2], 'verify');
  }
  assert.equal(await db.tenant.count(), 2);
  assert.equal(await db.account.count(), 2);
  assert.equal(await db.person.count(), 1);
  assert.equal(await db.candidate.count({ where: { status: 'pending' } }), 1);
  assert.equal(await db.candidate.count({ where: { status: 'accepted' } }), 1);
  assert.equal(await db.auditEvent.count({ where: { action: 'customer_created' } }), 2);
  assert.equal(await db.commandRun.count({ where: { kind: 'customer', status: 'completed' } }), 2);
  const records = {};
  for (const model of ['tenant', 'user', 'account', 'person', 'candidate', 'auditEvent', 'commandRun']) {
    records[model] = await db[model].findMany({ orderBy: { id: 'asc' } });
  }
  console.log(`CURRENT_BASELINE_DATA_SHA256=${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`);
} finally { await db.$disconnect(); }
