import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import {
  cancelReservedCommand,
  CommandInProgressError,
  IdempotencyConflictError,
  readCommandReplay,
  reserveCommand,
  runCommand,
} from '../src/mutation/commandRunner.js';
import {
  executeActionFeedback as executeActionFeedbackWithPolicy,
  executeInboxBatch,
  executeOpportunitySkeleton as executeOpportunitySkeletonWithPolicy,
} from '../src/mutation/compoundCommands.js';
import { IngestCommandError, ingestVoiceText } from '../src/voice.js';
import { hashIdempotencyKey } from '../src/idempotency.js';
import { internalProductPolicy } from './helpers/productPolicy.js';
import {
  createFieldCandidate,
  upsertReminderCandidate,
} from '../src/candidates/reviewItems.js';
import { seedLegacyCandidateAuthorities } from './helpers/candidateAuthority.js';

const executeActionFeedback = (
  ctx: Parameters<typeof executeActionFeedbackWithPolicy>[0],
  input: Parameters<typeof executeActionFeedbackWithPolicy>[1],
  db: Parameters<typeof executeActionFeedbackWithPolicy>[2],
  options?: Parameters<typeof executeActionFeedbackWithPolicy>[4],
) => executeActionFeedbackWithPolicy(ctx, input, db, internalProductPolicy, options);

const executeOpportunitySkeleton = (
  ctx: Parameters<typeof executeOpportunitySkeletonWithPolicy>[0],
  input: Parameters<typeof executeOpportunitySkeletonWithPolicy>[1],
  db: Parameters<typeof executeOpportunitySkeletonWithPolicy>[2],
  options?: Parameters<typeof executeOpportunitySkeletonWithPolicy>[4],
) => executeOpportunitySkeletonWithPolicy(ctx, input, db, internalProductPolicy, options);

describe('atomic idempotent compound commands', () => {
  let test: TestContext;
  let ctx: CommandContext;

  beforeEach(async () => {
    test = await createTestContext();
    ctx = {
      tenantId: test.tenant.id, actorId: test.owner.id, actorRole: 'owner',
      channel: 'web', requestId: 'compound-test', assertionMode: 'user_asserted',
    };
    await test.prisma.account.create({ data: {
      id: 'acc-command', tenantId: test.tenant.id, name: 'Command Account', customerType: 2,
    } });
  });

  afterEach(async () => test.cleanup());

  it('rolls back opportunity, person, member and role when skeleton step 2 fails', async () => {
    await expect(runCommand(ctx, { kind: 'opportunity-skeleton', idempotencyKey: 'skeleton-failure-key' },
      (tx) => executeOpportunitySkeleton(ctx, {
        accountId: 'acc-command', name: 'Atomic Opportunity', personIds: [], withEdges: false,
        skeleton: [{ title: '决策人', role: 'D', orgLevel: 1, x: 100, y: 120 }],
      }, tx, { failAfterStep: 2 }), test.prisma)).rejects.toThrow('injected failure');

    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.person.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.opportunityMember.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.oppRole.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.commandRun.findFirst({ where: { tenantId: test.tenant.id } })).toMatchObject({ status: 'failed' });
  });

  it('rolls back action completion when evidence creation fails', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'opp-command', tenantId: test.tenant.id, accountId: 'acc-command', name: 'Opp', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-command', tenantId: test.tenant.id, accountId: 'acc-command', name: 'D', title: '总经理',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'action-command', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-command',
      personId: 'person-command', title: '拜访', startDate: '2026-07-14', endDate: '2026-07-14',
    } });

    await expect(runCommand(ctx, { kind: 'action-feedback', idempotencyKey: 'feedback-failure-key' },
      (tx) => executeActionFeedback(ctx, {
        accountId: 'acc-command', opportunityId: 'opp-command', actionId: 'action-command',
        outcome: 'up', occurredAt: '2026-07-14',
      }, tx, { failAfterStep: 1 }), test.prisma)).rejects.toThrow('injected failure');

    expect(await test.prisma.planAction.findUniqueOrThrow({ where: { id: 'action-command' } })).toMatchObject({ done: false, doneAt: null });
    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });

  it('rolls back action completion, evidence and audit when a later audit step fails', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'opp-action-audit-rollback', tenantId: test.tenant.id, accountId: 'acc-command', name: 'Opp', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-action-audit-rollback', tenantId: test.tenant.id, accountId: 'acc-command', name: 'D', title: '总经理',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'action-audit-rollback', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-action-audit-rollback',
      personId: 'person-action-audit-rollback', title: '敏感行动标题', startDate: '2026-07-14', endDate: '2026-07-14',
    } });

    await expect(runCommand(ctx, { kind: 'action-feedback', idempotencyKey: 'feedback-audit-rollback-key' },
      (tx) => executeActionFeedback(ctx, {
        accountId: 'acc-command', opportunityId: 'opp-action-audit-rollback', actionId: 'action-audit-rollback',
        outcome: 'up', occurredAt: '2026-07-14',
      }, tx, { failAfterStep: 3 }), test.prisma)).rejects.toThrow('injected failure after step 3');

    expect(await test.prisma.planAction.findUniqueOrThrow({ where: { id: 'action-audit-rollback' } })).toMatchObject({ done: false, doneAt: null });
    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.auditEvent.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.commandRun.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, idempotencyKey: hashIdempotencyKey('feedback-audit-rollback-key'),
    } })).toMatchObject({ status: 'failed' });
  });

  it('writes minimal audits without evidence for flat and personless action outcomes', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'opp-action-audit-minimal', tenantId: test.tenant.id, accountId: 'acc-command', name: 'Opp', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-action-audit-minimal', tenantId: test.tenant.id, accountId: 'acc-command', name: 'D', title: '总经理',
    } });
    await test.prisma.planAction.createMany({ data: [{
      id: 'action-audit-flat', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-action-audit-minimal',
      personId: 'person-action-audit-minimal', title: '敏感平盘行动', startDate: '2026-07-14', endDate: '2026-07-14',
    }, {
      id: 'action-audit-no-person', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-action-audit-minimal',
      title: '敏感无人物行动', startDate: '2026-07-14', endDate: '2026-07-14',
    }] });

    for (const input of [{
      accountId: 'acc-command', opportunityId: 'opp-action-audit-minimal', actionId: 'action-audit-flat',
      outcome: 'flat' as const, occurredAt: '2026-07-14',
    }, {
      accountId: 'acc-command', opportunityId: 'opp-action-audit-minimal', actionId: 'action-audit-no-person',
      outcome: 'up' as const, occurredAt: '2026-07-14',
    }]) {
      await expect(runCommand(ctx, {
        kind: 'action-feedback', idempotencyKey: `feedback-${input.actionId}`, payload: input,
      }, (tx) => executeActionFeedback(ctx, input, tx), test.prisma)).resolves.toMatchObject({
        replayed: false, result: {},
      });
    }

    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    const audits = await test.prisma.auditEvent.findMany({
      where: { tenantId: test.tenant.id, action: 'action_feedback' }, orderBy: { entityId: 'asc' },
    });
    expect(audits).toHaveLength(2);
    for (const audit of audits) expect(audit).toMatchObject({
      actorId: test.owner.id,
      channel: 'web',
      action: 'action_feedback',
      entityKind: 'commitment',
      requestId: 'compound-test',
      sourceRef: null,
      changedFields: JSON.stringify(['executionStatus', 'version', 'done', 'doneAt']),
      metadata: JSON.stringify({ fromVersion: 0, toVersion: 1, scheduleVersion: 0 }),
    });
    expect(audits.map((audit) => audit.entityId)).toEqual(['action-audit-flat', 'action-audit-no-person']);
    expect(JSON.stringify(audits)).not.toContain('敏感平盘行动');
    expect(JSON.stringify(audits)).not.toContain('敏感无人物行动');
  });

  it('maps a down outcome to negative evidence and links the minimal audit', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'opp-action-down', tenantId: test.tenant.id, accountId: 'acc-command', name: 'Opp', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-action-down', tenantId: test.tenant.id, accountId: 'acc-command', name: 'D', title: '总经理',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'action-down', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-action-down',
      personId: 'person-action-down', title: '敏感负向行动', startDate: '2026-07-14', endDate: '2026-07-14',
    } });
    const input = {
      accountId: 'acc-command', opportunityId: 'opp-action-down', actionId: 'action-down',
      outcome: 'down' as const, occurredAt: '2026-07-14',
    };

    const result = await runCommand(ctx, {
      kind: 'action-feedback', idempotencyKey: 'feedback-action-down', payload: input,
    }, (tx) => executeActionFeedback(ctx, input, tx), test.prisma);

    const evidence = await test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: result.result.evidenceId } });
    expect(evidence).toMatchObject({
      tenantId: test.tenant.id, personId: 'person-action-down',
      signalKey: 'negative_interaction', direction: -1, status: 'approved',
    });
    const audit = await test.prisma.auditEvent.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, action: 'action_feedback', entityId: 'action-down',
    } });
    expect(await test.prisma.planAction.findUniqueOrThrow({ where: { id: 'action-down' } })).toMatchObject({
      done: true,
      executionStatus: 'completed',
      version: 1,
    });
    expect(audit).toMatchObject({
      sourceRef: evidence.id,
      changedFields: JSON.stringify(['executionStatus', 'version', 'done', 'doneAt', 'evidenceId']),
      metadata: JSON.stringify({ fromVersion: 0, toVersion: 1, scheduleVersion: 0, evidenceId: evidence.id }),
    });
    expect(JSON.stringify(audit)).not.toContain('敏感负向行动');
  });

  it('rolls back a voice ingest when a later extracted write fails', async () => {
    await expect(runCommand(ctx, { kind: 'voice-ingest', idempotencyKey: 'voice-failure-key' },
      (tx) => ingestVoiceText(ctx, { text: '明确新建商机和干系人', accountId: 'acc-command' }, tx, {
        extracted: {
          account: null,
          opportunity: { name: 'Voice Opp', kind: 'explicit', confidence: 1, evidence: '明确新建商机' },
          persons: [{ name: '王总', title: '总经理', orgLevel: 1, kind: 'explicit', confidence: 1, evidence: '王总是总经理' }],
          relationships: [], burningIssues: [], ucvs: [], evidences: [], rawNote: '明确新建商机和干系人',
        },
        failAfterWrite: 2,
      }), test.prisma)).rejects.toThrow('injected voice failure');

    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.person.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    expect(await test.prisma.visitNote.count({ where: { tenantId: test.tenant.id } })).toBe(0);
  });

  it('asks for a sales classification instead of defaulting voice-created accounts or opportunities', async () => {
    const unclassifiedAccount = await test.prisma.account.create({ data: {
      id: 'acc-voice-unclassified', tenantId: test.tenant.id, name: 'Unclassified voice account', customerType: null,
    } });
    const opportunityResult = await ingestVoiceText(ctx, {
      text: '明确新建商机', accountId: unclassifiedAccount.id,
    }, test.prisma, { extracted: {
      account: null,
      opportunity: { name: 'Voice Opp', kind: 'explicit', confidence: 1, evidence: '明确新建商机' },
      persons: [], relationships: [], burningIssues: [], ucvs: [], evidences: [], rawNote: '明确新建商机',
    } });
    expect(opportunityResult).toEqual({
      ok: false,
      status: 409,
      body: { error: '请先为客户设置销售分类，再创建商机', code: 'sales_customer_type_required' },
    });
    await expect(test.prisma.opportunity.count({ where: { accountId: unclassifiedAccount.id } })).resolves.toBe(0);

    const accountResult = await ingestVoiceText(ctx, { text: '明确新建客户' }, test.prisma, { extracted: {
      account: { name: 'Voice account without type', kind: 'explicit', confidence: 1, evidence: '明确新建客户' },
      opportunity: null,
      persons: [], relationships: [], burningIssues: [], ucvs: [], evidences: [], rawNote: '明确新建客户',
    } });
    expect(accountResult).toEqual({
      ok: false,
      status: 400,
      body: { error: '请明确客户的销售分类（1–4）后再用口述创建客户', code: 'sales_customer_type_required' },
    });
    await expect(test.prisma.account.count({ where: { name: 'Voice account without type' } })).resolves.toBe(0);
  });

  it('rolls back an inbox batch when a later item fails', async () => {
    await test.prisma.person.create({ data: {
      id: 'person-inbox-failure', tenantId: test.tenant.id,
      accountId: 'acc-command', name: 'Batch target', title: '',
    } });
    for (const id of ['cp-one', 'cp-two']) await test.prisma.changeProposal.create({ data: {
      id, tenantId: test.tenant.id, accountId: 'acc-command', entityKind: 'person', entityId: 'person-inbox-failure',
      field: 'name', oldValue: 'A', newValue: 'B', status: 'pending',
    } });
    await seedLegacyCandidateAuthorities(test.prisma, test.tenant.id, [
      { sourceKind: 'ChangeProposal', sourceId: 'cp-one' },
      { sourceKind: 'ChangeProposal', sourceId: 'cp-two' },
    ]);
    await expect(runCommand(ctx, { kind: 'inbox-batch', idempotencyKey: 'inbox-failure-key' },
      (tx) => executeInboxBatch(ctx, { items: [
        { kind: 'proposal', id: 'cp-one', decision: 'reject' },
        { kind: 'proposal', id: 'cp-two', decision: 'reject' },
      ] }, tx, { failAfterStep: 1 }), test.prisma)).rejects.toThrow('injected failure');
    expect(await test.prisma.changeProposal.findMany({ where: { tenantId: test.tenant.id }, orderBy: { id: 'asc' } }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'cp-one', status: 'pending' }), expect.objectContaining({ id: 'cp-two', status: 'pending' })]));
  });

  it('rolls back every earlier kind in a mixed inbox batch', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'opp-inbox', tenantId: test.tenant.id, accountId: 'acc-command', name: 'Inbox Opp', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: { id: 'person-inbox', tenantId: test.tenant.id, accountId: 'acc-command', name: 'D', title: '总经理' } });
    await test.prisma.changeProposal.create({ data: {
      id: 'cp-mixed', tenantId: test.tenant.id, accountId: 'acc-command', entityKind: 'person', entityId: 'person-inbox',
      field: 'name', oldValue: 'D', newValue: 'D2', status: 'pending',
    } });
    await test.prisma.personSuggestion.create({ data: {
      id: 'ps-mixed', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-inbox', name: '候选人', status: 'pending',
    } });
    await test.prisma.relSuggestion.create({ data: {
      id: 'rs-mixed', tenantId: test.tenant.id, opportunityId: 'opp-inbox', sourcePersonId: 'person-inbox', targetPersonId: 'person-inbox',
      layer: 'L1', label: '候选关系', status: 'pending',
    } });
    await test.prisma.evidenceEvent.create({ data: {
      id: 'ev-mixed', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-inbox', personId: 'person-inbox',
      signalKey: 'verbal_positive', status: 'pending_review',
    } });
    await test.prisma.reminder.create({ data: {
      id: 'rem-mixed', tenantId: test.tenant.id, accountId: 'acc-command', kind: 'stalled', title: '提醒',
      opportunityId: 'opp-inbox', oppName: 'Inbox Opp',
      dedupeKey: 'mixed-reminder', status: 'pending',
    } });
    await seedLegacyCandidateAuthorities(test.prisma, test.tenant.id, [
      { sourceKind: 'ChangeProposal', sourceId: 'cp-mixed' },
      { sourceKind: 'PersonSuggestion', sourceId: 'ps-mixed' },
      { sourceKind: 'RelSuggestion', sourceId: 'rs-mixed' },
      { sourceKind: 'EvidenceEvent', sourceId: 'ev-mixed' },
      { sourceKind: 'Reminder', sourceId: 'rem-mixed' },
    ]);

    await expect(runCommand(ctx, { kind: 'inbox-batch', idempotencyKey: 'mixed-inbox-failure' },
      (tx) => executeInboxBatch(ctx, { items: [
        { kind: 'proposal', id: 'cp-mixed', decision: 'reject' },
        { kind: 'person', id: 'ps-mixed', decision: 'reject' },
        { kind: 'rel', id: 'rs-mixed', decision: 'reject' },
        { kind: 'evidence', id: 'ev-mixed', decision: 'reject' },
        { kind: 'reminder', id: 'rem-mixed', decision: 'reject' },
      ] }, tx, { failAfterStep: 4 }), test.prisma)).rejects.toThrow('injected failure');

    expect(await test.prisma.changeProposal.findUniqueOrThrow({ where: { id: 'cp-mixed' } })).toMatchObject({ status: 'pending' });
    expect(await test.prisma.personSuggestion.findUniqueOrThrow({ where: { id: 'ps-mixed' } })).toMatchObject({ status: 'pending' });
    expect(await test.prisma.relSuggestion.findUniqueOrThrow({ where: { id: 'rs-mixed' } })).toMatchObject({ status: 'pending' });
    expect(await test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: 'ev-mixed' } })).toMatchObject({ status: 'pending_review' });
    expect(await test.prisma.reminder.findUniqueOrThrow({ where: { id: 'rem-mixed' } })).toMatchObject({ status: 'pending' });
  });

  it('rolls back earlier Candidate reviews when a later Candidate CAS is divergent', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'opp-candidate-conflict', tenantId: test.tenant.id, accountId: 'acc-command',
      name: 'Candidate conflict matter', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-candidate-conflict', tenantId: test.tenant.id,
      accountId: 'acc-command', name: 'Candidate conflict person', title: 'Owner',
    } });
    const proposal = await createFieldCandidate(test.prisma, {
      id: 'cp-candidate-conflict', tenantId: test.tenant.id, accountId: 'acc-command',
      matterId: 'opp-candidate-conflict', targetKind: 'person', targetId: 'person-candidate-conflict',
      fieldKey: 'title', oldValue: 'Owner', newValue: 'Sponsor', source: 'ai',
      sourceRef: 'ai:batch:proposal', evidence: '候选字段依据', confidence: 0.7,
      createdByUserId: test.owner.id,
    });
    const reminder = await upsertReminderCandidate(test.prisma, {
      id: 'rem-candidate-conflict', tenantId: test.tenant.id, accountId: 'acc-command',
      accountName: 'Command Account', matterId: 'opp-candidate-conflict',
      matterName: 'Candidate conflict matter', kind: 'stalled', title: '需要跟进',
      detail: '超过七天没有动作', severity: 'warn', targetId: null,
      dedupeKey: 'opp-candidate-conflict:stalled',
    });
    await test.prisma.candidate.update({
      where: { id: reminder.candidateId }, data: { status: 'accepted' },
    });

    await expect(runCommand(ctx, {
      kind: 'inbox-batch', idempotencyKey: 'candidate-cas-batch-conflict',
    }, (tx) => executeInboxBatch(ctx, { items: [
      { kind: 'proposal', id: proposal.row.id, decision: 'reject' },
      { kind: 'reminder', id: reminder.row.id, decision: 'reject' },
    ] }, tx), test.prisma)).rejects.toMatchObject({ candidateConflict: true });

    await expect(test.prisma.changeProposal.findUniqueOrThrow({ where: { id: proposal.row.id } }))
      .resolves.toMatchObject({ status: 'pending' });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: proposal.candidateId } }))
      .resolves.toMatchObject({ status: 'pending', version: 0 });
    await expect(test.prisma.reminder.findUniqueOrThrow({ where: { id: reminder.row.id } }))
      .resolves.toMatchObject({ status: 'pending' });
  });

  it('replays a completed command without creating a second opportunity', async () => {
    const input = { accountId: 'acc-command', name: 'Once', personIds: [], withEdges: false, skeleton: [] };
    const first = await runCommand(ctx, { kind: 'opportunity-skeleton', idempotencyKey: 'stable-replay-key' },
      (tx) => executeOpportunitySkeleton(ctx, input, tx), test.prisma);
    const replay = await runCommand(ctx, { kind: 'opportunity-skeleton', idempotencyKey: 'stable-replay-key' },
      (tx) => executeOpportunitySkeleton(ctx, input, tx), test.prisma);
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ replayed: true, result: first.result });
    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id } })).toBe(1);
  });

  it('deduplicates concurrent same-key submissions at the database boundary', async () => {
    const input = { accountId: 'acc-command', name: 'Concurrent Once', personIds: [], withEdges: false, skeleton: [] };
    const attempts = await Promise.allSettled([
      runCommand(ctx, { kind: 'opportunity-skeleton', idempotencyKey: 'concurrent-stable-key', payload: input },
        (tx) => executeOpportunitySkeleton(ctx, input, tx), test.prisma),
      runCommand(ctx, { kind: 'opportunity-skeleton', idempotencyKey: 'concurrent-stable-key', payload: input },
        (tx) => executeOpportunitySkeleton(ctx, input, tx), test.prisma),
    ]);
    expect(attempts.some((attempt) => attempt.status === 'fulfilled')).toBe(true);
    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id, name: 'Concurrent Once' } })).toBe(1);
    expect(await test.prisma.commandRun.count({ where: {
      tenantId: test.tenant.id, idempotencyKey: hashIdempotencyKey('concurrent-stable-key'),
    } })).toBe(1);
  });

  it('requires Idempotency-Key at the HTTP boundary and replays the same business action', async () => {
    const payload = { accountId: 'acc-command', name: 'HTTP Once', personIds: [], withEdges: false, skeleton: [] };
    const missing = await test.app.inject({
      method: 'POST', url: '/api/commands/opportunity-skeleton',
      headers: { authorization: `Bearer ${test.token}` }, payload,
    });
    expect(missing.statusCode).toBe(400);

    const headers = { authorization: `Bearer ${test.token}`, 'idempotency-key': 'http-stable-replay-key' };
    const first = await test.app.inject({ method: 'POST', url: '/api/commands/opportunity-skeleton', headers, payload });
    const replay = await test.app.inject({ method: 'POST', url: '/api/commands/opportunity-skeleton', headers, payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ replayed: false });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, opportunityId: first.json().opportunityId });
    const mismatch = await test.app.inject({
      method: 'POST', url: '/api/commands/opportunity-skeleton', headers,
      payload: { ...payload, name: 'Different payload' },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(await test.prisma.opportunity.count({ where: { tenantId: test.tenant.id } })).toBe(1);
  });

  it('denies viewers and hides foreign-tenant command targets', async () => {
    const viewer = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id, email: 'viewer-command@example.test', passwordHash: 'unused', name: 'Viewer', role: 'viewer',
    } });
    const viewerToken = test.app.jwt.sign({ userId: viewer.id, tenantId: test.tenant.id, role: 'viewer' });
    const payload = { accountId: 'acc-command', name: 'Forbidden', personIds: [], withEdges: false, skeleton: [] };
    const denied = await test.app.inject({
      method: 'POST', url: '/api/commands/opportunity-skeleton',
      headers: { authorization: `Bearer ${viewerToken}`, 'idempotency-key': 'viewer-command-key' }, payload,
    });
    expect(denied.statusCode).toBe(403);

    await test.prisma.tenant.create({ data: { id: 'tenant-foreign-command', name: 'Foreign' } });
    await test.prisma.account.create({ data: {
      id: 'acc-foreign-command', tenantId: 'tenant-foreign-command', name: 'Foreign Account', customerType: 2,
    } });
    const hidden = await test.app.inject({
      method: 'POST', url: '/api/commands/opportunity-skeleton',
      headers: { authorization: `Bearer ${test.token}`, 'idempotency-key': 'foreign-command-key' },
      payload: { ...payload, accountId: 'acc-foreign-command' },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: '资源不存在' });
    expect(await test.prisma.opportunity.count({ where: { tenantId: 'tenant-foreign-command' } })).toBe(0);
  });

  it('hides a foreign-tenant action target without changing its evidence or audit trail', async () => {
    await test.prisma.tenant.create({ data: { id: 'tenant-foreign-action', name: 'Foreign Action Tenant' } });
    await test.prisma.account.create({ data: {
      id: 'acc-foreign-action', tenantId: 'tenant-foreign-action', name: 'Foreign Account', customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'opp-foreign-action', tenantId: 'tenant-foreign-action', accountId: 'acc-foreign-action', name: 'Foreign Opp', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-foreign-action', tenantId: 'tenant-foreign-action', accountId: 'acc-foreign-action', name: 'Foreign D', title: '总经理',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'action-foreign-action', tenantId: 'tenant-foreign-action', accountId: 'acc-foreign-action', opportunityId: 'opp-foreign-action',
      personId: 'person-foreign-action', title: 'Foreign Action', startDate: '2026-07-14', endDate: '2026-07-14',
    } });

    const hidden = await test.app.inject({
      method: 'POST', url: '/api/commands/action-feedback',
      headers: { authorization: `Bearer ${test.token}`, 'idempotency-key': 'foreign-action-feedback-key' },
      payload: {
        accountId: 'acc-foreign-action', opportunityId: 'opp-foreign-action', actionId: 'action-foreign-action',
        outcome: 'up', occurredAt: '2026-07-14',
      },
    });

    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({ error: '资源不存在' });
    expect(await test.prisma.planAction.findUniqueOrThrow({ where: { id: 'action-foreign-action' } })).toMatchObject({ done: false, doneAt: null });
    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: 'tenant-foreign-action' } })).toBe(0);
    expect(await test.prisma.auditEvent.count({ where: { tenantId: 'tenant-foreign-action' } })).toBe(0);
  });

  it('stores a non-sensitive replay summary without changing receipt collection shapes', async () => {
    const key = { kind: 'voice-ingest', idempotencyKey: 'voice-summary-replay-key' };
    const first = await runCommand(ctx, key, async () => ({
      ok: true,
      receipt: { notes: [{ person: '王总', content: '客户原始敏感线索' }], note: '原始口述正文' },
    }), test.prisma);
    const replay = await runCommand(ctx, key, async () => first.result, test.prisma);
    expect(replay.replayed).toBe(true);
    expect(replay.result.receipt.notes).toEqual([{ person: '[redacted]', content: '[redacted]' }]);
    expect(replay.result.receipt.note).toBe('[redacted]');
    const stored = await test.prisma.commandRun.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, idempotencyKey: hashIdempotencyKey(key.idempotencyKey),
    } });
    expect(stored.resultSummary).not.toContain('客户原始敏感线索');
    expect(stored.resultSummary).not.toContain('原始口述正文');
    expect(stored.resultSummary).not.toContain('王总');
  });

  it('preflights completed external commands before expensive preparation', async () => {
    const key = { kind: 'voice-ingest', idempotencyKey: 'voice-preflight-key', payload: { text: 'same' } };
    await runCommand(ctx, key, async () => ({ ok: true, receipt: { visitNote: true } }), test.prisma);
    await expect(readCommandReplay(ctx, key, test.prisma)).resolves.toMatchObject({ replayed: true, result: { ok: true } });
    await expect(readCommandReplay(ctx, { ...key, payload: { text: 'different' } }, test.prisma)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('reauthorizes every completed replay path before returning a stored receipt', async () => {
    const key = { kind: 'review-batch-accept:test', idempotencyKey: 'replay-authorization-key', payload: { version: 1 } };
    await runCommand(ctx, key, async () => ({ ok: true, receipt: { batchId: 'batch-1' } }), test.prisma);

    let authorizationChecks = 0;
    let businessExecutions = 0;
    const denied = new Error('replay_access_revoked');
    const authorizeReplay = async () => {
      authorizationChecks += 1;
      throw denied;
    };

    await expect(readCommandReplay(ctx, { ...key, authorizeReplay }, test.prisma)).rejects.toBe(denied);
    await expect(reserveCommand(ctx, { ...key, authorizeReplay }, test.prisma)).rejects.toBe(denied);
    await expect(runCommand(ctx, { ...key, authorizeReplay }, async () => {
      businessExecutions += 1;
      return { ok: false };
    }, test.prisma)).rejects.toBe(denied);

    expect(authorizationChecks).toBe(3);
    expect(businessExecutions).toBe(0);
    await expect(test.prisma.commandRun.findFirstOrThrow({ where: {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      kind: key.kind,
      idempotencyKey: hashIdempotencyKey(key.idempotencyKey),
    } })).resolves.toMatchObject({ status: 'completed' });
  });

  it('reserves an external command before preparation and blocks overlapping BYO calls', async () => {
    const key = { kind: 'voice-ingest', idempotencyKey: 'voice-reservation-key', payload: { text: 'same' } };
    const reservation = await reserveCommand<{ ok: true; receipt: { visitNote: boolean } }>(ctx, key, test.prisma);
    expect(reservation.replayed).toBe(false);
    if (reservation.replayed) throw new Error('expected a reservation');
    await expect(reserveCommand(ctx, key, test.prisma)).rejects.toBeInstanceOf(CommandInProgressError);

    const completed = await runCommand(ctx, { ...key, reservationToken: reservation.reservationToken },
      async () => ({ ok: true as const, receipt: { visitNote: true } }), test.prisma);
    expect(completed.replayed).toBe(false);
    await expect(reserveCommand(ctx, key, test.prisma)).resolves.toMatchObject({ replayed: true });
  });

  it('cancels only the exact running reservation and preserves other actors, newer leases, and completed commands', async () => {
    const key = { kind: 'voice-ingest', idempotencyKey: 'scoped-cancel-safety-key', payload: { text: 'same' } };
    const reservation = await reserveCommand(ctx, key, test.prisma);
    if (reservation.replayed) throw new Error('expected a reservation');

    await expect(cancelReservedCommand({ ...ctx, actorId: 'other-actor' }, key, reservation.reservationToken, test.prisma)).resolves.toBe(false);
    await expect(cancelReservedCommand(ctx, { ...key, payload: { text: 'different' } }, reservation.reservationToken, test.prisma)).resolves.toBe(false);
    await test.prisma.commandRun.updateMany({
      where: { tenantId: ctx.tenantId, actorId: ctx.actorId, kind: key.kind, idempotencyKey: hashIdempotencyKey(key.idempotencyKey) },
      data: { leaseToken: 'newer-lease-token' },
    });
    await expect(cancelReservedCommand(ctx, key, reservation.reservationToken, test.prisma)).resolves.toBe(false);
    await test.prisma.commandRun.updateMany({
      where: { tenantId: ctx.tenantId, actorId: ctx.actorId, kind: key.kind, idempotencyKey: hashIdempotencyKey(key.idempotencyKey) },
      data: { status: 'completed', resultSummary: '{"ok":true}' },
    });
    await expect(cancelReservedCommand(ctx, key, 'newer-lease-token', test.prisma)).resolves.toBe(false);
    await expect(test.prisma.commandRun.findFirstOrThrow({ where: {
      tenantId: ctx.tenantId, actorId: ctx.actorId, kind: key.kind, idempotencyKey: hashIdempotencyKey(key.idempotencyKey),
    } })).resolves.toMatchObject({ status: 'completed', leaseToken: 'newer-lease-token' });

    const exactKey = { kind: 'voice-ingest', idempotencyKey: 'scoped-cancel-exact-key', payload: { text: 'same' } };
    const exact = await reserveCommand(ctx, exactKey, test.prisma);
    if (exact.replayed) throw new Error('expected an exact reservation');
    await expect(cancelReservedCommand(ctx, exactKey, exact.reservationToken, test.prisma)).resolves.toBe(true);
    await expect(test.prisma.commandRun.count({ where: {
      tenantId: ctx.tenantId, actorId: ctx.actorId, kind: exactKey.kind, idempotencyKey: hashIdempotencyKey(exactKey.idempotencyKey),
    } })).resolves.toBe(0);
  });

  it('recovers an abandoned external-command lease after expiry', async () => {
    const key = { kind: 'recording-ingest', idempotencyKey: 'expired-reservation-key', payload: { transcriptId: 'tr-1' } };
    const first = await reserveCommand(ctx, key, test.prisma);
    expect(first.replayed).toBe(false);
    await test.prisma.commandRun.updateMany({
      where: { tenantId: ctx.tenantId, idempotencyKey: hashIdempotencyKey(key.idempotencyKey) },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const recovered = await reserveCommand(ctx, key, test.prisma);
    expect(recovered).toMatchObject({ replayed: false });
    if (first.replayed || recovered.replayed) throw new Error('expected reservations');
    expect(recovered.reservationToken).not.toBe(first.reservationToken);
  });

  it('claims an action outcome once even when callers use different idempotency keys', async () => {
    await test.prisma.opportunity.create({ data: {
      id: 'opp-action-once', tenantId: test.tenant.id, accountId: 'acc-command', name: 'Opp', customerType: 2,
      pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: 'person-action-once', tenantId: test.tenant.id, accountId: 'acc-command', name: 'D', title: '总经理',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'action-once', tenantId: test.tenant.id, accountId: 'acc-command', opportunityId: 'opp-action-once',
      personId: 'person-action-once', title: '拜访', startDate: '2026-07-14', endDate: '2026-07-14',
    } });
    const input = {
      accountId: 'acc-command', opportunityId: 'opp-action-once', actionId: 'action-once',
      outcome: 'up' as const, occurredAt: '2026-07-14',
    };
    const attempts = await Promise.allSettled([
      runCommand(ctx, { kind: 'action-feedback', idempotencyKey: 'action-once-first', payload: input },
        (tx) => executeActionFeedback(ctx, input, tx), test.prisma),
      runCommand(ctx, { kind: 'action-feedback', idempotencyKey: 'action-once-second', payload: input },
        (tx) => executeActionFeedback(ctx, input, tx), test.prisma),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { statusCode: 409 } });
    expect(await test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id, opportunityId: 'opp-action-once' } })).toBe(1);
    expect(await test.prisma.auditEvent.count({ where: {
      tenantId: test.tenant.id, action: 'action_feedback', entityId: 'action-once',
    } })).toBe(1);
  });

  it('records resolved ingest failures as failed and permits a same-key retry', async () => {
    const key = { kind: 'voice-ingest', idempotencyKey: 'voice-retry-after-failure', payload: { text: 'same input' } };
    await expect(runCommand(ctx, key, async () => {
      throw new IngestCommandError({ ok: false, status: 400, body: { error: 'temporary model failure' } });
    }, test.prisma)).rejects.toBeInstanceOf(IngestCommandError);
    expect(await test.prisma.commandRun.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, idempotencyKey: hashIdempotencyKey(key.idempotencyKey),
    } }))
      .toMatchObject({ status: 'failed' });

    const retry = await runCommand(ctx, key, async () => ({ ok: true, receipt: { visitNote: true } }), test.prisma);
    expect(retry).toMatchObject({ replayed: false, result: { ok: true } });
    expect(await test.prisma.commandRun.findFirstOrThrow({ where: {
      tenantId: test.tenant.id, idempotencyKey: hashIdempotencyKey(key.idempotencyKey),
    } }))
      .toMatchObject({ status: 'completed' });
  });

  it('stores only digests and lazily migrates a legacy raw-key replay row', async () => {
    const raw = 'legacy-command-key-never-persist-again';
    const digest = hashIdempotencyKey(raw);
    const first = await runCommand(ctx, { kind: 'opaque-key-check', idempotencyKey: raw },
      async () => ({ ok: true }), test.prisma);
    expect(first.replayed).toBe(false);
    expect(await test.prisma.commandRun.count({ where: { tenantId: ctx.tenantId, idempotencyKey: raw } })).toBe(0);
    expect(await test.prisma.commandRun.count({ where: { tenantId: ctx.tenantId, idempotencyKey: digest } })).toBe(1);

    const legacyRaw = 'pre-int-502-command-key';
    await test.prisma.commandRun.create({ data: {
      tenantId: ctx.tenantId,
      actorId: ctx.actorId,
      kind: 'legacy-command',
      idempotencyKey: legacyRaw,
      requestHash: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
      status: 'completed',
      resultSummary: '{"ok":true}',
    } });
    const replay = await runCommand(ctx, { kind: 'legacy-command', idempotencyKey: legacyRaw },
      async () => ({ ok: false }), test.prisma);
    expect(replay).toEqual({ replayed: true, result: { ok: true } });
    expect(await test.prisma.commandRun.count({ where: { tenantId: ctx.tenantId, idempotencyKey: legacyRaw } })).toBe(0);
    expect(await test.prisma.commandRun.count({ where: {
      tenantId: ctx.tenantId, idempotencyKey: hashIdempotencyKey(legacyRaw),
    } })).toBe(1);
  });

  it('does not alias a 64-hex raw key to a prior command digest', async () => {
    const firstRaw = 'ordinary-idempotency-key';
    const hexRaw = hashIdempotencyKey(firstRaw);
    const first = await runCommand(ctx, { kind: 'hex-key-alias-check', idempotencyKey: firstRaw },
      async () => ({ command: 'first' }), test.prisma);
    const second = await runCommand(ctx, { kind: 'hex-key-alias-check', idempotencyKey: hexRaw },
      async () => ({ command: 'second' }), test.prisma);
    expect(first.replayed).toBe(false);
    expect(second).toEqual({ replayed: false, result: { command: 'second' } });
    expect(await test.prisma.commandRun.count({ where: {
      tenantId: ctx.tenantId, kind: 'hex-key-alias-check',
    } })).toBe(2);
  });
});
