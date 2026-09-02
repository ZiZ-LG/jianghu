import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const commitmentId = (suffix: string) => `commitment_${createHash('sha256').update(suffix).digest('hex').slice(0, 32)}`;
const auth = (token: string, key: string) => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

describe('SAAS-208 linked hypothesis verification Commitment', () => {
  let test: TestContext;
  let customerId: string;
  let matterId: string;
  let personId: string;
  let hypothesisId: string;
  let revisionId: string;

  beforeEach(async () => {
    test = await createTestContext();
    customerId = 'verification-customer';
    matterId = 'verification-matter';
    personId = 'verification-person';
    hypothesisId = 'verification-hypothesis';
    revisionId = 'verification-revision-1';
    await test.prisma.account.create({ data: {
      id: customerId, tenantId: test.tenant.id, name: 'Verification customer',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId: customerId,
      name: 'Verification matter', customerType: 1, pipelineStage: 'lead', engageStage: 'unknown',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.person.create({ data: {
      id: personId, tenantId: test.tenant.id, accountId: customerId,
      name: 'Verification person', title: 'Sponsor',
    } });
    await test.prisma.salesHypothesis.create({ data: {
      id: hypothesisId, tenantId: test.tenant.id, customerId, matterId, personId,
      status: 'testing', ownerUserId: test.owner.id,
      nextReviewAt: new Date('2026-09-30T00:00:00.000Z'), currentRevisionId: revisionId,
      createdByUserId: test.owner.id, statusConfirmedByUserId: test.owner.id,
      statusConfirmedAt: new Date('2026-08-31T00:00:00.000Z'),
    } });
    await test.prisma.salesHypothesisRevision.create({ data: {
      id: revisionId, tenantId: test.tenant.id, hypothesisId, revisionNumber: 1,
      claim: 'Customer will schedule a review', reason: 'Sponsor controls implementation review',
      expectedSignals: '["review scheduled"]', falsificationConditions: '["review refused"]',
      origin: 'user', createdByUserId: test.owner.id,
    } });
  });

  afterEach(async () => test.cleanup());

  const payload = (id: string, ref = { hypothesisId, hypothesisRevisionId: revisionId }) => ({
    type: 'CREATE_COMMITMENT',
    commitment: {
      id, customerId, matterId, personId, title: '确认客户是否安排技术评审', kind: 'verification',
      ownerUserId: test.owner.id, confirmationStatus: 'not_required',
      scheduledAtUtc: '2026-09-01T08:00:00.000Z', dueAtUtc: null,
      timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
      confirmationDueAtUtc: null, source: 'manual', sourceRef: null,
      hypothesisRef: ref,
    },
  });

  async function command(key: string, body: any, token = test.token) {
    return test.app.inject({
      method: 'POST', url: '/api/commands/commitment', headers: auth(token, key), payload: body,
    });
  }

  it('pins the exact current revision, reauthorizes replay, and mutates no formal authority', async () => {
    const id = commitmentId('saas208-create');
    const formalBefore = await Promise.all([
      test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.stakeholderFocus.count(), test.prisma.salesHypothesisRevision.count(),
    ]);
    const first = await command('saas208-linked-create', payload(id));
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      commitmentId: id, hypothesisId, hypothesisRevisionId: revisionId,
      resultRecorded: false, replayed: false,
    });
    await expect(test.prisma.planAction.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({
      accountId: customerId, opportunityId: matterId, hypothesisId,
      hypothesisRevisionId: revisionId, completionResult: '',
      completionResultRecordedAtUtc: null, completionResultRecordedByUserId: null,
      verificationReviewDisposition: '', verificationReviewedAtUtc: null,
      verificationReviewedByUserId: null,
    });
    await expect(Promise.all([
      test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.stakeholderFocus.count(), test.prisma.salesHypothesisRevision.count(),
    ])).resolves.toEqual(formalBefore);
    const audit = await test.prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: test.tenant.id, entityId: id, action: 'commitment_created' },
    });
    expect(JSON.parse(audit.metadata)).toMatchObject({ hypothesisId, hypothesisRevisionId: revisionId });
    expect(audit.metadata).not.toContain('Customer will schedule a review');

    await test.prisma.user.update({ where: { id: test.owner.id }, data: { role: 'viewer' } });
    const replay = await command('saas208-linked-create', payload(id));
    expect(replay.statusCode).toBe(403);
    expect(await test.prisma.commandRun.count({ where: { tenantId: test.tenant.id } })).toBe(1);
    expect(await test.prisma.auditEvent.count({ where: { tenantId: test.tenant.id, entityId: id } })).toBe(1);
  });

  it('fails closed for stale, foreign, partial-scope, and Customer-level hypothesis links', async () => {
    await test.prisma.salesHypothesisRevision.create({ data: {
      id: 'verification-revision-2', tenantId: test.tenant.id, hypothesisId, revisionNumber: 2,
      claim: 'Revised claim', reason: 'New fact', expectedSignals: '["new signal"]',
      falsificationConditions: '["new contradiction"]', origin: 'user', createdByUserId: test.owner.id,
    } });
    await test.prisma.salesHypothesis.update({
      where: { id: hypothesisId }, data: { currentRevisionId: 'verification-revision-2', version: 1 },
    });
    const stale = await command('saas208-stale-revision', payload(commitmentId('stale')));
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'commitment_hypothesis_revision_conflict' });

    const foreignTenant = await test.prisma.tenant.create({
      data: { id: `tenant-${randomUUID()}`, name: 'Foreign tenant' },
    });
    const foreignHypothesisId = `foreign-${randomUUID()}`;
    await test.prisma.salesHypothesis.create({ data: {
      id: foreignHypothesisId, tenantId: foreignTenant.id,
      customerId: 'foreign-customer', matterId: 'foreign-matter',
      status: 'testing', currentRevisionId: 'foreign-revision',
    } });
    await test.prisma.salesHypothesisRevision.create({ data: {
      id: 'foreign-revision', tenantId: foreignTenant.id, hypothesisId: foreignHypothesisId,
      revisionNumber: 1, claim: 'Foreign claim', reason: 'Foreign reason',
      expectedSignals: '["signal"]', falsificationConditions: '["condition"]', origin: 'user',
    } });
    const foreign = await command('saas208-foreign-hypothesis', payload(commitmentId('foreign'), {
      hypothesisId: foreignHypothesisId, hypothesisRevisionId: 'foreign-revision',
    }));
    expect(foreign.statusCode).toBe(404);

    const customerLevel = payload(commitmentId('customer-level'));
    customerLevel.commitment.matterId = null as unknown as string;
    const noMatter = await command('saas208-customer-level', customerLevel);
    expect(noMatter.statusCode).toBe(409);
    expect(noMatter.json()).toMatchObject({ code: 'commitment_hypothesis_matter_required' });
    expect(await test.prisma.planAction.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });

  it('records one bounded human result only after completion with CAS and body-free audit', async () => {
    const id = commitmentId('saas208-result');
    expect((await command('saas208-result-create', payload(id))).statusCode).toBe(200);
    const resultCommand = (baseVersion: number, result = '客户确认将在下周安排技术评审') => ({
      type: 'RECORD_COMMITMENT_RESULT', customerId, commitmentId: id,
      baseVersion, expectedScheduleVersion: 0, result,
    });
    const premature = await command('saas208-result-premature', resultCommand(0));
    expect(premature.statusCode).toBe(409);

    const completed = await command('saas208-result-complete', {
      type: 'COMPLETE_COMMITMENT', customerId, commitmentId: id,
      baseVersion: 0, expectedScheduleVersion: 0, completedAtUtc: '2026-09-01T09:00:00.000Z',
    });
    expect(completed.statusCode, completed.body).toBe(200);
    const recorded = await command('saas208-result-record', resultCommand(1));
    const replay = await command('saas208-result-record', resultCommand(1));
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json()).toMatchObject({
      commitmentId: id, hypothesisId, hypothesisRevisionId: revisionId,
      resultRecorded: true, version: 2, replayed: false,
    });
    expect(replay.json()).toEqual({ ...recorded.json(), replayed: true });
    await expect(test.prisma.planAction.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({
      completionResult: '客户确认将在下周安排技术评审',
      completionResultRecordedByUserId: test.owner.id,
      completionResultRecordedAtUtc: expect.any(Date), version: 2,
    });
    const audit = await test.prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: test.tenant.id, entityId: id, action: 'commitment_result_recorded' },
    });
    expect(JSON.parse(audit.metadata)).toMatchObject({
      resultRecorded: true, fromVersion: 1, toVersion: 2,
    });
    expect(audit.metadata).not.toContain('客户确认将在下周安排技术评审');
    const second = await command('saas208-result-second', resultCommand(2, '试图覆盖'));
    expect(second.statusCode).toBe(409);
    expect(await test.prisma.auditEvent.count({
      where: { tenantId: test.tenant.id, entityId: id, action: 'commitment_result_recorded' },
    })).toBe(1);
  });

  it('rejects result capture for unlinked or already reviewed Commitments and blocks viewer before journal writes', async () => {
    const unlinkedId = commitmentId('saas208-unlinked');
    const unlinkedPayload = payload(unlinkedId);
    unlinkedPayload.commitment.hypothesisRef = null as unknown as { hypothesisId: string; hypothesisRevisionId: string };
    expect((await command('saas208-unlinked-create', unlinkedPayload)).statusCode).toBe(200);
    expect((await command('saas208-unlinked-complete', {
      type: 'COMPLETE_COMMITMENT', customerId, commitmentId: unlinkedId,
      baseVersion: 0, expectedScheduleVersion: 0, completedAtUtc: '2026-09-01T09:00:00.000Z',
    })).statusCode).toBe(200);
    const unlinkedResult = await command('saas208-unlinked-result', {
      type: 'RECORD_COMMITMENT_RESULT', customerId, commitmentId: unlinkedId,
      baseVersion: 1, expectedScheduleVersion: 0, result: '不得写入',
    });
    expect(unlinkedResult.statusCode).toBe(409);

    const reviewedId = commitmentId('saas208-reviewed');
    expect((await command('saas208-reviewed-create', payload(reviewedId))).statusCode).toBe(200);
    expect((await command('saas208-reviewed-complete', {
      type: 'COMPLETE_COMMITMENT', customerId, commitmentId: reviewedId,
      baseVersion: 0, expectedScheduleVersion: 0, completedAtUtc: '2026-09-01T09:00:00.000Z',
    })).statusCode).toBe(200);
    await test.prisma.planAction.update({ where: { id: reviewedId }, data: {
      verificationReviewDisposition: 'kept',
      verificationReviewedAtUtc: new Date('2026-09-01T10:00:00.000Z'),
      verificationReviewedByUserId: test.owner.id,
    } });
    const reviewedResult = await command('saas208-reviewed-result', {
      type: 'RECORD_COMMITMENT_RESULT', customerId, commitmentId: reviewedId,
      baseVersion: 1, expectedScheduleVersion: 0, result: '不得写入',
    });
    expect(reviewedResult.statusCode).toBe(409);

    const viewer = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: `viewer-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Viewer', role: 'viewer',
    } });
    const viewerToken = test.app.jwt.sign({
      userId: viewer.id, tenantId: test.tenant.id, role: 'viewer',
    });
    const runsBefore = await test.prisma.commandRun.count();
    const auditsBefore = await test.prisma.auditEvent.count();
    const denied = await command('saas208-viewer-result', {
      type: 'RECORD_COMMITMENT_RESULT', customerId, commitmentId: reviewedId,
      baseVersion: 1, expectedScheduleVersion: 0, result: 'viewer forbidden',
    }, viewerToken);
    expect(denied.statusCode).toBe(403);
    expect(await test.prisma.commandRun.count()).toBe(runsBefore);
    expect(await test.prisma.auditEvent.count()).toBe(auditsBefore);
  });
});
