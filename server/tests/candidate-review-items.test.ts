import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import {
  createEvidenceCandidate,
  createFieldCandidate,
  dismissReminderCandidate,
  prepareFieldCandidatesForPersonMerge,
  rejectFieldCandidate,
  reviewEvidenceCandidate,
  upsertReminderCandidate,
} from '../src/candidates/reviewItems.js';
import {
  applyCandidateMigration,
  verifyCandidateMigration,
} from '../src/candidates/migration.js';

describe('CORE-203 field, reminder, and evidence Candidate authority', () => {
  let test: TestContext;
  const accountId = 'core-203-account';
  const matterId = 'core-203-matter';
  const personId = 'core-203-person';

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'CORE-203 Account', customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId, name: 'CORE-203 Matter',
      customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.create({ data: {
      id: personId, tenantId: test.tenant.id, accountId, name: '候选审核人', title: '负责人',
    } });
  });

  afterEach(async () => test.cleanup());

  const review = () => ({
    actorId: test.owner.id,
    actorRole: 'owner' as const,
    capabilityPolicy: assembleProductAccess({ edition: 'internal' }).policy,
  });

  it('creates and updates a field Candidate with one same-transaction compatibility projection', async () => {
    const first = await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-field', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '决策人',
      source: 'voice', sourceRef: 'voice:core-203:field:1', evidence: '原句明确说明其为决策人',
      confidence: 0.82, createdByUserId: test.owner.id,
    });
    const replay = await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-replay-id', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '最终决策人',
      source: 'voice', sourceRef: 'voice:core-203:field:2', evidence: '第二段原句补充了最终拍板权',
      confidence: 0.9, createdByUserId: test.owner.id,
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.row.id).toBe(first.row.id);
    expect(replay.row).toMatchObject({ status: 'pending', newValue: '最终决策人' });
    const candidate = await test.prisma.candidate.findUniqueOrThrow({ where: { id: first.candidateId } });
    expect(candidate).toMatchObject({
      tenantId: test.tenant.id, kind: 'field_change', status: 'pending', accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人',
      newValue: '最终决策人', source: 'voice', createdByUserId: test.owner.id,
      visibility: 'private', version: 1, legacySourceKind: 'ChangeProposal',
      legacySourceId: first.row.id,
    });
    expect(candidate.evidence).toBe('第二段原句补充了最终拍板权');
    await expect(test.prisma.person.findUniqueOrThrow({ where: { id: personId } }))
      .resolves.toMatchObject({ title: '负责人' });
    await expect(test.prisma.changeProposal.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
    await expect(test.prisma.candidate.count({ where: { tenantId: test.tenant.id } })).resolves.toBe(1);
  });

  it('fails closed when Candidate status diverges instead of committing a legacy-only review', async () => {
    const created = await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-conflict', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '决策人',
      source: 'ai', sourceRef: 'ai:core-203:field:conflict', evidence: '模型候选，需人工核实',
      confidence: 0.65, createdByUserId: null,
    });
    await test.prisma.candidate.update({ where: { id: created.candidateId }, data: { status: 'accepted' } });

    await expect(rejectFieldCandidate(test.prisma, {
      tenantId: test.tenant.id, id: created.row.id,
      review: review(),
    })).rejects.toMatchObject({ candidateConflict: true });
    await expect(test.prisma.changeProposal.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ status: 'pending' });
  });

  it('fails closed when a person merge encounters an in-flight field review', async () => {
    const created = await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-applying', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '决策人',
      source: 'voice', sourceRef: 'voice:core-203:applying', evidence: '审核中的原句',
      confidence: 0.84, createdByUserId: test.owner.id,
    });
    await test.prisma.changeProposal.update({
      where: { id: created.row.id }, data: { status: 'applying' },
    });

    await expect(prepareFieldCandidatesForPersonMerge(test.prisma, {
      tenantId: test.tenant.id, ids: [created.row.id],
      review: review(),
    })).rejects.toMatchObject({ candidateConflict: true });
    await expect(test.prisma.changeProposal.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ status: 'applying', dedupeKey: expect.any(String) });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({ status: 'pending', version: 0 });
  });

  it('keeps patrol reminders read-only and resolves Candidate plus projection together', async () => {
    const created = await upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203', tenantId: test.tenant.id, accountId, accountName: 'CORE-203 Account',
      matterId, matterName: 'CORE-203 Matter', kind: 'sentiment_recheck', title: '复查支持度',
      detail: '已有支持证据超过两周', severity: 'info', targetId: personId,
      dedupeKey: `${matterId}:sentiment_recheck:${personId}`,
    });
    expect(created.created).toBe(true);
    await expect(test.prisma.person.findUniqueOrThrow({ where: { id: personId } }))
      .resolves.toMatchObject({ title: '负责人' });

    await expect(dismissReminderCandidate(test.prisma, {
      tenantId: test.tenant.id, id: created.row.id,
      review: review(),
    })).resolves.toBe(true);
    await expect(test.prisma.reminder.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ status: 'dismissed' });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({ status: 'rejected', version: 1 });
  });

  it('rejects a reminder dedupe collision that attempts to move the target parent', async () => {
    await test.prisma.person.create({ data: {
      id: 'core-203-other-person', tenantId: test.tenant.id, accountId,
      name: '另一位干系人', title: '使用人',
    } });
    const created = await upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203-parent', tenantId: test.tenant.id, accountId,
      accountName: 'CORE-203 Account', matterId, matterName: 'CORE-203 Matter',
      kind: 'sentiment_recheck', title: '复查支持度', detail: '确定性巡检依据', severity: 'info',
      targetId: personId, dedupeKey: 'core-203-reminder-parent-key',
    });

    await expect(upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203-parent-reuse', tenantId: test.tenant.id, accountId,
      accountName: 'CORE-203 Account', matterId, matterName: 'CORE-203 Matter',
      kind: 'sentiment_recheck', title: '不应移动', detail: '不同目标', severity: 'warn',
      targetId: 'core-203-other-person', dedupeKey: 'core-203-reminder-parent-key',
    })).rejects.toMatchObject({ candidateConflict: true });
    await expect(test.prisma.reminder.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ entityId: personId, title: '复查支持度' });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({ targetId: personId, version: 0 });
  });

  it('creates pending evidence only as a Candidate and rolls review back when the formal callback fails', async () => {
    const created = await createEvidenceCandidate(test.prisma, {
      id: 'ev-core-203', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '客户原句证据',
      occurredAt: '2026-08-24', source: 'mcp', sourceRef: 'mcp:core-203:evidence:1',
      confidence: 0.77, createdByUserId: test.owner.id,
    });
    expect(created.row).toMatchObject({ status: 'pending_review', origin: 'mcp' });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({ kind: 'evidence_create', status: 'pending', version: 0 });

    await expect(reviewEvidenceCandidate(test.prisma, {
      tenantId: test.tenant.id, id: created.row.id, decision: 'accept', reviewedBy: test.owner.id,
      reviewedAt: '2026-08-24', direction: -1,
      review: review(),
    }, async () => { throw new Error('snapshot failed'); })).rejects.toThrow('snapshot failed');
    await expect(test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ status: 'pending_review', direction: 1 });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({ status: 'pending', version: 0 });

    await expect(reviewEvidenceCandidate(test.prisma, {
      tenantId: test.tenant.id, id: created.row.id, decision: 'accept', reviewedBy: test.owner.id,
      reviewedAt: '2026-08-24', direction: -1,
      review: review(),
    })).resolves.toBe(true);
    await expect(test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ status: 'approved', direction: -1, reviewedBy: test.owner.id });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({ status: 'accepted', version: 1 });
  });

  it('rejects evidence source replay when the supposedly idempotent payload changes', async () => {
    const created = await createEvidenceCandidate(test.prisma, {
      id: 'ev-core-203-replay', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '第一次机器原文',
      occurredAt: '2026-08-24', source: 'mcp', sourceRef: 'mcp:core-203:evidence:replay',
      confidence: 0.76, createdByUserId: test.owner.id,
    });

    await expect(createEvidenceCandidate(test.prisma, {
      id: 'ev-core-203-replay-other-id', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '被替换的机器原文',
      occurredAt: '2026-08-24', source: 'mcp', sourceRef: 'mcp:core-203:evidence:replay',
      confidence: 0.76, createdByUserId: test.owner.id,
    })).rejects.toMatchObject({ candidateConflict: true });
    await expect(test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: created.row.id } }))
      .resolves.toMatchObject({ rawContent: '第一次机器原文', status: 'pending_review' });
    await expect(test.prisma.evidenceEvent.count({ where: { tenantId: test.tenant.id } }))
      .resolves.toBe(1);
  });

  it('scopes identical private field and evidence idempotency to each creator', async () => {
    const other = await test.prisma.user.create({ data: {
      tenantId: test.tenant.id,
      email: 'core-204-review-item-other@test.invalid',
      passwordHash: 'x',
      name: 'Review item other',
      role: 'member',
    } });
    const ownerField = await createFieldCandidate(test.prisma, {
      id: 'core-204-private-field-owner', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '决策人',
      source: 'mcp', sourceRef: 'mcp:core-204-private-field-owner', evidence: '所有者字段依据',
      confidence: 0.71, createdByUserId: test.owner.id,
    });
    const otherField = await createFieldCandidate(test.prisma, {
      id: 'core-204-private-field-other', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '影响人',
      source: 'mcp', sourceRef: 'mcp:core-204-private-field-other', evidence: '成员字段依据',
      confidence: 0.72, createdByUserId: other.id,
    });
    const otherFieldReplay = await createFieldCandidate(test.prisma, {
      id: 'core-204-private-field-other-replay', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '关键影响人',
      source: 'mcp', sourceRef: 'mcp:core-204-private-field-other-replay', evidence: '成员字段补充依据',
      confidence: 0.8, createdByUserId: other.id,
    });
    expect(ownerField.created).toBe(true);
    expect(otherField.created).toBe(true);
    expect(otherFieldReplay).toMatchObject({ created: false, candidateId: otherField.candidateId });
    await expect(test.prisma.changeProposal.findUniqueOrThrow({ where: { id: ownerField.row.id } }))
      .resolves.toMatchObject({ newValue: '决策人', evidence: '所有者字段依据' });
    await expect(test.prisma.changeProposal.findUniqueOrThrow({ where: { id: otherField.row.id } }))
      .resolves.toMatchObject({ newValue: '关键影响人', evidence: '成员字段补充依据' });

    const ownerEvidence = await createEvidenceCandidate(test.prisma, {
      id: 'core-204-private-evidence-owner', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '相同私有证据原句',
      occurredAt: '2026-08-25', source: 'mcp', sourceRef: 'mcp:core-204-private-evidence',
      confidence: 0.73, createdByUserId: test.owner.id,
    });
    const otherEvidence = await createEvidenceCandidate(test.prisma, {
      id: 'core-204-private-evidence-other', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '相同私有证据原句',
      occurredAt: '2026-08-25', source: 'mcp', sourceRef: 'mcp:core-204-private-evidence',
      confidence: 0.73, createdByUserId: other.id,
    });
    const otherEvidenceReplay = await createEvidenceCandidate(test.prisma, {
      id: 'core-204-private-evidence-other-replay', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '相同私有证据原句',
      occurredAt: '2026-08-25', source: 'mcp', sourceRef: 'mcp:core-204-private-evidence',
      confidence: 0.73, createdByUserId: other.id,
    });
    expect(ownerEvidence.created).toBe(true);
    expect(otherEvidence.created).toBe(true);
    expect(otherEvidenceReplay).toMatchObject({ created: false, candidateId: otherEvidence.candidateId });

    const privateCandidates = await test.prisma.candidate.findMany({ where: {
      tenantId: test.tenant.id,
      kind: { in: ['field_change', 'evidence_create'] },
      status: 'pending',
    } });
    expect(privateCandidates).toHaveLength(4);
    expect(new Set(privateCandidates.map((candidate) => candidate.dedupeKey)).size).toBe(4);
    expect(privateCandidates.filter((candidate) => candidate.createdByUserId === test.owner.id)).toHaveLength(2);
    expect(privateCandidates.filter((candidate) => candidate.createdByUserId === other.id)).toHaveLength(2);
  });

  it('keeps bidirectional migration verification green after terminal reviews', async () => {
    const field = await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-verify', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title', oldValue: '负责人', newValue: '决策人',
      source: 'voice', sourceRef: 'voice:core-203:verify-field', evidence: '字段候选原句',
      confidence: 0.81, createdByUserId: test.owner.id,
    });
    const reminder = await upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203-verify', tenantId: test.tenant.id, accountId, accountName: 'CORE-203 Account',
      matterId, matterName: 'CORE-203 Matter', kind: 'sentiment_recheck', title: '复查支持度',
      detail: '确定性巡检依据', severity: 'info', targetId: personId,
      dedupeKey: `${matterId}:sentiment_recheck:${personId}`,
    });
    const evidence = await createEvidenceCandidate(test.prisma, {
      id: 'ev-core-203-verify', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '机器证据原句',
      occurredAt: '2026-08-24', source: 'recording', sourceRef: 'recording:core-203:verify-evidence',
      confidence: 0.84, createdByUserId: test.owner.id,
    });

    await expect(applyCandidateMigration(test.prisma)).resolves.toMatchObject({ ok: true });
    await expect(rejectFieldCandidate(test.prisma, {
      tenantId: test.tenant.id, id: field.row.id, review: review(),
    }))
      .resolves.toBe(true);
    await expect(dismissReminderCandidate(test.prisma, {
      tenantId: test.tenant.id, id: reminder.row.id, review: review(),
    }))
      .resolves.toBe(true);
    await expect(reviewEvidenceCandidate(test.prisma, {
      tenantId: test.tenant.id, id: evidence.row.id, decision: 'accept',
      reviewedBy: test.owner.id, reviewedAt: '2026-08-24',
      review: review(),
    })).resolves.toBe(true);

    await expect(verifyCandidateMigration(test.prisma)).resolves.toMatchObject({
      ok: true, markerPresent: true, conflicts: [],
    });
  });

  it('validates personLog, UCV, Matter, and Commitment review targets without parallel target types', async () => {
    await test.prisma.uCV.create({ data: {
      id: 'ucv-core-203-target', tenantId: test.tenant.id, opportunityId: matterId,
      targetBiId: '', description: '差异价值', competitorCannot: '难以复制', status: 'active',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'commitment-core-203-target', tenantId: test.tenant.id, accountId, opportunityId: matterId,
      title: '确认下一步', ownerId: test.owner.id, ownerUserId: test.owner.id,
      startDate: '2026-08-24', endDate: '2026-08-24', localDate: '2026-08-24',
    } });
    await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-person-log', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'personLog', targetId: personId, fieldKey: 'append', oldValue: '', newValue: '{"text":"跟进"}',
      source: 'voice', sourceRef: 'voice:core-203:person-log', evidence: '口述要求追加跟进',
      confidence: 0.8, createdByUserId: test.owner.id,
    });
    await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-ucv', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'ucv', targetId: 'ucv-core-203-target', fieldKey: 'description',
      oldValue: '差异价值', newValue: '量化差异价值', source: 'ai',
      sourceRef: 'ai:core-203:ucv', evidence: '会议纪要中的量化依据',
      confidence: 0.7, createdByUserId: test.owner.id,
    });
    await upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203-commitment', tenantId: test.tenant.id, accountId,
      accountName: 'CORE-203 Account', matterId, matterName: 'CORE-203 Matter',
      kind: 'commitment_due', title: '承诺已到期', detail: '只提醒，不改正式承诺', severity: 'warn',
      targetId: 'commitment-core-203-target', dedupeKey: `${test.tenant.id}:commitment-core-203-target:commitment_due:0`,
    });
    await upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203-matter', tenantId: test.tenant.id, accountId,
      accountName: 'CORE-203 Account', matterId, matterName: 'CORE-203 Matter',
      kind: 'matter_without_next_commitment', title: '没有有效下一步', detail: '请人工补充承诺', severity: 'warn',
      targetId: matterId, dedupeKey: `${test.tenant.id}:${matterId}:matter_without_next_commitment:2026-W35`,
    });

    await expect(applyCandidateMigration(test.prisma)).resolves.toMatchObject({ ok: true });
    await expect(verifyCandidateMigration(test.prisma)).resolves.toMatchObject({ ok: true, conflicts: [] });
  });
});
