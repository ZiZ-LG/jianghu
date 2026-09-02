import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers/testApp.js';
import {
  createPersonCandidate,
  createRelationCandidate,
  relationCandidateDedupeKey,
} from '../src/candidates/personRelation.js';
import {
  createEvidenceCandidate,
  createFieldCandidate,
  upsertReminderCandidate,
} from '../src/candidates/reviewItems.js';

describe('CORE-203 Candidate-only Inbox', () => {
  let test: TestContext;
  const accountId = 'core-203-inbox-account';
  const matterId = 'core-203-inbox-matter';
  const leftId = 'core-203-inbox-left';
  const rightId = 'core-203-inbox-right';

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'Inbox Account', customerType: 2,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId, name: 'Inbox Matter',
      customerType: 2, pipelineStage: '线索', engageStage: '需求调研立项',
    } });
    await test.prisma.person.createMany({ data: [
      { id: leftId, tenantId: test.tenant.id, accountId, name: '正式甲', title: '负责人' },
      { id: rightId, tenantId: test.tenant.id, accountId, name: '正式乙', title: '使用人' },
    ] });
    await test.prisma.industryPack.create({ data: {
      id: 'core-203-inbox-pack', tenantId: test.tenant.id,
      packKey: 'core-203-inbox', schemaVersion: '1', payload: '{}',
    } });
    await test.prisma.signalCatalog.create({ data: {
      id: 'core-203-inbox-signal', tenantId: test.tenant.id,
      packId: 'core-203-inbox-pack', signalKey: 'intro_referral', label: '内部引荐', tier: 'strong',
    } });
  });

  afterEach(async () => test.cleanup());

  const auth = () => ({ authorization: `Bearer ${test.token}` });

  it('fails closed while the verified five-source backfill marker is absent', async () => {
    const response = await test.app.inject({ method: 'GET', url: '/api/inbox', headers: auth() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'candidate_backfill_required' });
  });

  it('maps all five DTO classes from Candidate and ignores divergent legacy display fields', async () => {
    await test.prisma.dataMigrationState.create({ data: {
      key: 'CORE-203-candidate-backfill-v1', details: '{"test":true}',
    } });
    const person = await createPersonCandidate(test.prisma, {
      id: 'ps-core-203-inbox', tenantId: test.tenant.id, accountId, matterId,
      name: '候选丙', title: '技术评审', orgLevel: 2, source: 'mcp',
      sourceRef: 'mcp:core-203:person', evidence: '来源明确提到候选丙', confidence: 0.91,
      createdByUserId: test.owner.id, dedupeKey: 'core-203-inbox-person',
    });
    const relation = await createRelationCandidate(test.prisma, {
      id: 'rs-core-203-inbox', tenantId: test.tenant.id, matterId,
      source: { kind: 'person', id: leftId }, target: { kind: 'person', id: rightId },
      layer: 'L2', label: '影响', sourceType: 'graph', sourceRef: 'graph:core-203:relation',
      evidence: '共同联系人路径', confidence: 0.88, createdByUserId: test.owner.id,
      dedupeKey: relationCandidateDedupeKey(matterId,
        { kind: 'person', id: leftId }, { kind: 'person', id: rightId }),
    });
    const field = await createFieldCandidate(test.prisma, {
      id: 'cp-core-203-inbox', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'oppRole', targetId: leftId, fieldKey: 'sentiment', oldValue: 'neutral', newValue: 'plus',
      source: 'voice', sourceRef: 'voice:core-203:field', evidence: '甲明确表达支持', confidence: 0.8,
      createdByUserId: test.owner.id,
    });
    const reminder = await upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203-inbox', tenantId: test.tenant.id, accountId, accountName: 'Inbox Account',
      matterId, matterName: 'Inbox Matter', kind: 'sentiment_recheck', title: '复查甲的支持度',
      detail: '证据已经超过两周', severity: 'info', targetId: leftId,
      dedupeKey: `${matterId}:sentiment_recheck:${leftId}`,
    });
    const evidence = await createEvidenceCandidate(test.prisma, {
      id: 'ev-core-203-inbox', tenantId: test.tenant.id, accountId, matterId, personId: leftId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '甲安排了内部引荐',
      occurredAt: '2026-08-24', source: 'recording', sourceRef: 'recording:core-203:evidence',
      confidence: 0.79, createdByUserId: test.owner.id,
    });

    await Promise.all([
      test.prisma.personSuggestion.update({ where: { id: person.row.id }, data: { name: '旧表篡改人物' } }),
      test.prisma.relSuggestion.update({ where: { id: relation.row.id }, data: { label: '旧表篡改关系' } }),
      test.prisma.changeProposal.update({ where: { id: field.row.id }, data: { newValue: '旧表篡改字段' } }),
      test.prisma.reminder.update({ where: { id: reminder.row.id }, data: { title: '旧表篡改提醒' } }),
      test.prisma.evidenceEvent.update({ where: { id: evidence.row.id }, data: { rawContent: '旧表篡改证据' } }),
    ]);

    const response = await test.app.inject({ method: 'GET', url: '/api/inbox', headers: auth() });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.total).toBe(5);
    expect(body.persons).toEqual([expect.objectContaining({
      id: person.row.id, name: '候选丙', title: '技术评审', accountName: 'Inbox Account', confidence: 0.91,
    })]);
    expect(body.rels).toEqual([expect.objectContaining({
      id: relation.row.id, source: leftId, target: rightId,
      sourceName: '正式甲', targetName: '正式乙', label: '影响',
      accountName: 'Inbox Account', oppName: 'Inbox Matter', confidence: 0.88,
    })]);
    expect(body.proposals).toEqual([expect.objectContaining({
      id: field.row.id, newValue: 'plus', entityName: '正式甲', field: 'sentiment',
    })]);
    expect(body.reminders).toEqual([expect.objectContaining({
      id: reminder.row.id, title: '复查甲的支持度', detail: '证据已经超过两周',
    })]);
    expect(body.evidences).toEqual([expect.objectContaining({
      id: evidence.row.id, rawContent: '甲安排了内部引荐', signalLabel: '内部引荐', personName: '正式甲',
    })]);
    expect(Object.keys(body.rels[0]).sort()).toEqual([
      'accountId', 'accountName', 'confidence', 'evidence', 'id', 'label', 'layer', 'opportunityId',
      'oppName', 'origin', 'source', 'sourceKind', 'sourceName', 'target', 'targetKind', 'targetName',
    ].sort());
    expect(body.proposals[0]).not.toHaveProperty('createdAt');
    expect(body.reminders[0]).not.toHaveProperty('createdAt');
    expect(body.evidences[0]).not.toHaveProperty('createdAt');
    expect(response.body).not.toContain('旧表篡改');
  });

  it('fails closed when an evidence Candidate points at a missing Person', async () => {
    await test.prisma.dataMigrationState.create({ data: {
      key: 'CORE-203-candidate-backfill-v1', details: '{"test":true}',
    } });
    const evidence = await createEvidenceCandidate(test.prisma, {
      id: 'ev-core-203-missing-person', tenantId: test.tenant.id, accountId, matterId, personId: leftId,
      signalKey: 'intro_referral', direction: 1, tier: 'strong', rawContent: '候选证据原文',
      occurredAt: '2026-08-24', source: 'recording', sourceRef: 'recording:core-203:missing-person',
      confidence: 0.79, createdByUserId: test.owner.id,
    });
    await test.prisma.candidate.update({
      where: { id: evidence.candidateId }, data: { targetId: 'missing-person' },
    });

    const response = await test.app.inject({ method: 'GET', url: '/api/inbox', headers: auth() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'candidate_parent_invalid' });
    expect(response.body).not.toContain('候选证据原文');
  });

  it('fails closed when a reminder Candidate points at a foreign Commitment parent', async () => {
    await test.prisma.dataMigrationState.create({ data: {
      key: 'CORE-203-candidate-backfill-v1', details: '{"test":true}',
    } });
    await test.prisma.planAction.create({ data: {
      id: 'commitment-core-203-inbox', tenantId: test.tenant.id, accountId, opportunityId: matterId,
      title: '确认下一步', ownerId: test.owner.id, ownerUserId: test.owner.id,
      startDate: '2026-08-24', endDate: '2026-08-24', localDate: '2026-08-24',
    } });
    const reminder = await upsertReminderCandidate(test.prisma, {
      id: 'rem-core-203-foreign-commitment', tenantId: test.tenant.id, accountId,
      accountName: 'Inbox Account', matterId, matterName: 'Inbox Matter',
      kind: 'commitment_due', title: '承诺到期', detail: '只读提醒', severity: 'warn',
      targetId: 'commitment-core-203-inbox',
      dedupeKey: `${test.tenant.id}:commitment-core-203-inbox:commitment_due:0`,
    });
    await test.prisma.candidate.update({
      where: { id: reminder.candidateId }, data: { targetId: 'missing-commitment' },
    });

    const response = await test.app.inject({ method: 'GET', url: '/api/inbox', headers: auth() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'candidate_parent_invalid' });
    expect(response.body).not.toContain('只读提醒');
  });
});
