import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import { executeInboxBatch } from '../src/mutation/compoundCommands.js';
import { applyAction } from '../src/mutate.js';
import { ingestVoiceText } from '../src/voice.js';
import { runPatrol } from '../src/jobs.js';
import { seedLegacyCandidateAuthority } from './helpers/candidateAuthority.js';

const BEIJING_0030 = new Date('2026-07-14T16:30:00.000Z');

describe('Asia/Shanghai business-day writes at Beijing 00:30', () => {
  let test: TestContext;
  let ctx: CommandContext;

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      channel: 'web',
      requestId: 'business-date-boundary',
      assertionMode: 'user_asserted',
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEIJING_0030);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await test.cleanup();
  });

  async function seedTree(suffix: string) {
    const accountId = `acc-${suffix}`;
    const opportunityId = `opp-${suffix}`;
    const personId = `person-${suffix}`;
    await test.prisma.account.create({ data: { id: accountId, tenantId: test.tenant.id, name: `Account ${suffix}`, customerType: 2 } });
    await test.prisma.opportunity.create({ data: {
      id: opportunityId, tenantId: test.tenant.id, accountId, name: `Opportunity ${suffix}`, customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: { id: personId, tenantId: test.tenant.id, accountId, name: `Person ${suffix}`, title: '负责人' } });
    return { accountId, opportunityId, personId };
  }

  it('stamps voice-created VisitNote, person log, and Evidence with the Beijing date', async () => {
    const accountId = 'acc-voice-date';
    const opportunityId = 'opp-voice-date';
    await test.prisma.account.create({ data: { id: accountId, tenantId: test.tenant.id, name: 'Voice Account', customerType: 2 } });
    await test.prisma.opportunity.create({ data: {
      id: opportunityId, tenantId: test.tenant.id, accountId, name: 'Voice Opportunity', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.industryPack.create({ data: {
      id: 'pack-voice-date', tenantId: test.tenant.id, packKey: 'test-date', schemaVersion: '1', payload: '{}',
    } });
    await test.prisma.signalCatalog.create({ data: {
      id: 'signal-voice-date', tenantId: test.tenant.id, packId: 'pack-voice-date', signalKey: 'test_positive', direction: 1, tier: 'mid',
    } });

    const result = await ingestVoiceText(ctx, { text: '虚构拜访记录', accountId, opportunityId }, test.prisma, { extracted: {
      account: null,
      opportunity: null,
      persons: [{ name: '虚构王总', title: '负责人', orgLevel: 2, kind: 'explicit', confidence: 1, evidence: '虚构事实' }],
      relationships: [], burningIssues: [], ucvs: [],
      evidences: [{ person: '虚构王总', signalKey: 'test_positive', direction: 1, evidence: '虚构支持表态' }],
      rawNote: '虚构拜访纪要',
    } });

    expect(result.ok).toBe(true);
    const person = await test.prisma.person.findFirstOrThrow({ where: { tenantId: test.tenant.id, accountId, name: '虚构王总' } });
    expect(JSON.parse(person.logs)).toEqual([expect.objectContaining({ date: '2026-07-15' })]);
    await expect(test.prisma.evidenceEvent.findFirstOrThrow({ where: { tenantId: test.tenant.id, opportunityId } }))
      .resolves.toMatchObject({ occurredAt: '2026-07-15' });
    await expect(test.prisma.visitNote.findFirstOrThrow({ where: { tenantId: test.tenant.id, opportunityId } }))
      .resolves.toMatchObject({ date: '2026-07-15' });
  });

  it('stamps single Evidence review with the Beijing date', async () => {
    const tree = await seedTree('review-date');
    await test.prisma.evidenceEvent.create({ data: {
      id: 'evidence-review-date', tenantId: test.tenant.id, accountId: tree.accountId,
      opportunityId: tree.opportunityId, personId: tree.personId, signalKey: 'test', status: 'pending_review',
    } });
    await seedLegacyCandidateAuthority(
      test.prisma, test.tenant.id, 'EvidenceEvent', 'evidence-review-date',
    );

    const response = await test.app.inject({
      method: 'POST',
      url: '/api/evidence/evidence-review-date/review',
      headers: { authorization: `Bearer ${test.token}` },
      payload: { action: 'reject' },
    });

    expect(response.statusCode, response.body).toBe(200);
    await expect(test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: 'evidence-review-date' } }))
      .resolves.toMatchObject({ status: 'rejected', reviewedAt: '2026-07-15' });
  });

  it('stamps batch Evidence review with the Beijing date', async () => {
    const tree = await seedTree('batch-date');
    await test.prisma.evidenceEvent.create({ data: {
      id: 'evidence-batch-date', tenantId: test.tenant.id, accountId: tree.accountId,
      opportunityId: tree.opportunityId, personId: tree.personId, signalKey: 'test', status: 'pending_review',
    } });
    await seedLegacyCandidateAuthority(
      test.prisma, test.tenant.id, 'EvidenceEvent', 'evidence-batch-date',
    );

    await executeInboxBatch(ctx, {
      items: [{ kind: 'evidence', id: 'evidence-batch-date', decision: 'reject' }],
    }, test.prisma);

    await expect(test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: 'evidence-batch-date' } }))
      .resolves.toMatchObject({ status: 'rejected', reviewedAt: '2026-07-15' });
  });

  it('uses the Beijing date when TOGGLE_PLAN_ACTION omits doneAt', async () => {
    const tree = await seedTree('done-date');
    await test.prisma.planAction.create({ data: {
      id: 'action-done-date', tenantId: test.tenant.id, accountId: tree.accountId,
      opportunityId: tree.opportunityId, personId: tree.personId, title: '虚构行动',
      startDate: '2026-07-14', endDate: '2026-07-14',
    } });

    await applyAction(ctx, { type: 'TOGGLE_PLAN_ACTION', accId: tree.accountId, actionId: 'action-done-date', done: true }, test.prisma);

    await expect(test.prisma.planAction.findUniqueOrThrow({ where: { id: 'action-done-date' } }))
      .resolves.toMatchObject({ done: true, doneAt: '2026-07-15' });
  });

  it('treats yesterday in Beijing as a due all-day Commitment during patrol', async () => {
    const tree = await seedTree('patrol-date');
    await test.prisma.planAction.create({ data: {
      id: 'action-patrol-date', tenantId: test.tenant.id, accountId: tree.accountId,
      opportunityId: tree.opportunityId, personId: tree.personId, title: '虚构逾期行动',
      startDate: '2026-07-14', endDate: '2026-07-14', draft: false, done: false,
      ownerId: test.owner.id, ownerUserId: test.owner.id,
      executionStatus: 'planned', confirmationStatus: 'not_required',
      isAllDay: true, localDate: '2026-07-14', timeZone: 'Asia/Shanghai',
    } });

    await runPatrol();

    await expect(test.prisma.reminder.findFirst({ where: {
      tenantId: test.tenant.id, opportunityId: tree.opportunityId, kind: 'commitment_due', entityId: 'action-patrol-date',
    } })).resolves.toMatchObject({ status: 'pending' });
  });

  it('does not create a NaN patrol reminder from malformed action start/end dates', async () => {
    const tree = await seedTree('patrol-invalid-date');
    await test.prisma.planAction.createMany({ data: [{
      id: 'action-invalid-end-date', tenantId: test.tenant.id, accountId: tree.accountId,
      opportunityId: tree.opportunityId, personId: tree.personId, title: '非法截止日期',
      startDate: 'invalid-start', endDate: '2026-02-30', draft: false, done: false,
    }, {
      id: 'action-invalid-start-date', tenantId: test.tenant.id, accountId: tree.accountId,
      opportunityId: tree.opportunityId, personId: tree.personId, title: '非法开始日期',
      startDate: 'invalid-start', endDate: '', draft: false, done: false,
    }] });

    await runPatrol();

    const reminders = await test.prisma.reminder.findMany({ where: {
      tenantId: test.tenant.id,
      opportunityId: tree.opportunityId,
      kind: 'commitment_due',
    } });
    expect(reminders).toEqual([]);
    expect(JSON.stringify(await test.prisma.reminder.findMany({ where: { tenantId: test.tenant.id } }))).not.toContain('NaN');
  });
});
