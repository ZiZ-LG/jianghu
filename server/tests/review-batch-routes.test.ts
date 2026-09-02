import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleProductAccess } from '@jianghu/domain-contracts';
import { PrismaClient } from '@prisma/client';
import {
  createPersonCandidate,
  createRelationCandidate,
} from '../src/candidates/personRelation.js';
import {
  createEvidenceCandidate,
  createFieldCandidate,
} from '../src/candidates/reviewItems.js';
import {
  grantCandidateReviewer,
  revokeCandidateReviewer,
  setSensitiveResourceVisibility,
} from '../src/sensitiveAcl/service.js';
import {
  createCommitmentReviewCandidate,
  interactionIdForReviewBatch,
} from '../src/reviewBatches/model.js';
import { reportReviewBatchMigration } from '../src/reviewBatches/migration.js';
import { readableReviewBatches } from '../src/reviewBatches/service.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('CORE-205 ReviewBatch routes', () => {
  let test: TestContext;
  const accountId = 'core-205-account';
  const matterId = 'core-205-matter';
  const auth = (token = test.token, key?: string) => ({
    authorization: `Bearer ${token}`,
    ...(key ? { 'idempotency-key': key } : {}),
  });
  const internalPolicy = assembleProductAccess({ edition: 'internal' }).policy;

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: accountId, tenantId: test.tenant.id, name: 'Review account',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId, tenantId: test.tenant.id, accountId, name: 'Review matter',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
  });
  afterEach(async () => test.cleanup());

  async function registerArtifact(suffix: string) {
    const response = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, `core-205-source-${suffix}`),
      payload: {
        source: 'meeting-test', externalRef: `meeting-${suffix}`,
        title: 'Private meeting source', matterId,
        occurredAt: '2026-08-25T18:00:00.000Z',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ id: string; aclVersion: number }>();
  }

  async function personCandidate(suffix: string) {
    return createPersonCandidate(test.prisma, {
      id: `core-205-person-${suffix}`,
      tenantId: test.tenant.id,
      accountId,
      matterId,
      name: `Candidate ${suffix}`,
      title: 'Decision maker',
      source: 'meeting-test',
      sourceRef: `meeting:${suffix}`,
      evidence: `private candidate excerpt ${suffix}`,
      confidence: 0.8,
      createdByUserId: test.owner.id,
      dedupeKey: `core-205-person-dedupe-${suffix}`,
    });
  }

  async function createBatch(
    suffix: string,
    artifact: { id: string; aclVersion: number },
    candidates: Array<{ candidateId: string; candidateVersion: number }>,
  ) {
    for (const candidate of candidates) {
      await test.prisma.candidate.updateMany({
        where: {
          id: candidate.candidateId,
          tenantId: test.tenant.id,
          status: 'pending',
          sourceArtifactId: null,
          reviewBatchId: null,
        },
        data: { sourceArtifactId: artifact.id },
      });
    }
    const response = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(test.token, `core-205-batch-${suffix}`),
      payload: {
        sourceArtifactId: artifact.id,
        expectedSourceAclVersion: artifact.aclVersion,
        candidates: candidates.map((candidate) => ({
          id: candidate.candidateId,
          expectedVersion: candidate.candidateVersion,
          expectedAclVersion: artifact.aclVersion,
        })),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      id: string;
      version: number;
      acceptanceVersion: number;
      candidates: Array<{ id: string; version: number; aclVersion: number }>;
    }>();
  }

  async function addUser(role: 'member' | 'viewer', name: string) {
    return test.prisma.user.create({ data: {
      tenantId: test.tenant.id,
      email: `${role}-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name,
      role,
    } });
  }

  it('creates a body-free pre-review batch and all-reject closes it without an Interaction', async () => {
    const artifact = await registerArtifact('all-reject');
    const candidate = await personCandidate('all-reject');
    const formalBefore = await Promise.all([
      test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(), test.prisma.interaction.count(),
    ]);
    const batch = await createBatch('all-reject', artifact, [candidate]);

    expect(await Promise.all([
      test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(), test.prisma.interaction.count(),
    ])).toEqual(formalBefore);
    const detail = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${batch.id}`, headers: auth(),
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).not.toContain('private candidate excerpt');
    expect(detail.body).not.toContain('Private meeting source');
    expect(detail.body).not.toContain('contentEnc');

    const item = batch.candidates[0]!;
    const payload = {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      decisions: [{
        candidateId: item.id, expectedVersion: item.version,
        expectedAclVersion: item.aclVersion, decision: 'reject',
      }],
    };
    const rejected = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-all-reject'), payload,
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(rejected.json()).toMatchObject({
      status: 'rejected', interactionId: null,
      items: [{ candidateId: item.id, status: 'rejected' }],
    });
    await expect(test.prisma.interaction.count()).resolves.toBe(0);
    await expect(test.prisma.person.count()).resolves.toBe(0);
  });

  it('rejects an unanchored or different-source Candidate instead of importing an arbitrary ID', async () => {
    const sourceA = await registerArtifact('source-a');
    const sourceB = await registerArtifact('source-b');
    const unanchored = await personCandidate('unanchored');
    const unanchoredResponse = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(test.token, 'core-205-unanchored-candidate'),
      payload: {
        sourceArtifactId: sourceA.id,
        expectedSourceAclVersion: sourceA.aclVersion,
        candidates: [{
          id: unanchored.candidateId,
          expectedVersion: unanchored.candidateVersion,
          expectedAclVersion: sourceA.aclVersion,
        }],
      },
    });
    expect(unanchoredResponse.statusCode, unanchoredResponse.body).toBe(409);
    expect(unanchoredResponse.json()).toMatchObject({
      code: `review_batch_candidate_conflict:${unanchored.candidateId}`,
    });

    const wrongSource = await personCandidate('wrong-source');
    await test.prisma.candidate.update({
      where: { id: wrongSource.candidateId },
      data: { sourceArtifactId: sourceB.id },
    });
    const wrongSourceResponse = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(test.token, 'core-205-wrong-source-candidate'),
      payload: {
        sourceArtifactId: sourceA.id,
        expectedSourceAclVersion: sourceA.aclVersion,
        candidates: [{
          id: wrongSource.candidateId,
          expectedVersion: wrongSource.candidateVersion,
          expectedAclVersion: sourceA.aclVersion,
        }],
      },
    });
    expect(wrongSourceResponse.statusCode, wrongSourceResponse.body).toBe(409);
    expect(wrongSourceResponse.json()).toMatchObject({
      code: `review_batch_candidate_conflict:${wrongSource.candidateId}`,
    });
    const unclassifiedSourceResponse = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(test.token, 'core-205-unclassified-source'),
      payload: {
        source: 'meeting-test', externalRef: 'unclassified-source',
        title: 'Unclassified source',
      },
    });
    expect(unclassifiedSourceResponse.statusCode, unclassifiedSourceResponse.body).toBe(200);
    const unclassifiedSource = unclassifiedSourceResponse.json<{ id: string; aclVersion: number }>();
    const unclassifiedCandidate = await personCandidate('unclassified-source');
    await test.prisma.candidate.update({
      where: { id: unclassifiedCandidate.candidateId },
      data: { sourceArtifactId: unclassifiedSource.id },
    });
    const unclassifiedResponse = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(test.token, 'core-205-unclassified-batch'),
      payload: {
        sourceArtifactId: unclassifiedSource.id,
        expectedSourceAclVersion: unclassifiedSource.aclVersion,
        candidates: [{
          id: unclassifiedCandidate.candidateId,
          expectedVersion: unclassifiedCandidate.candidateVersion,
          expectedAclVersion: unclassifiedSource.aclVersion,
        }],
      },
    });
    expect(unclassifiedResponse.statusCode, unclassifiedResponse.body).toBe(409);
    expect(unclassifiedResponse.json()).toMatchObject({ code: 'review_batch_source_conflict' });
    await expect(test.prisma.reviewBatch.count()).resolves.toBe(0);
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: unanchored.candidateId } }))
      .resolves.toMatchObject({ sourceArtifactId: null, reviewBatchId: null, status: 'pending' });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: wrongSource.candidateId } }))
      .resolves.toMatchObject({ sourceArtifactId: sourceB.id, reviewBatchId: null, status: 'pending' });
  });

  it('rejects stale, terminal, and already-batched Candidate attachments', async () => {
    const artifact = await registerArtifact('attachment-cas');
    const candidate = await personCandidate('attachment-cas');
    await test.prisma.candidate.update({
      where: { id: candidate.candidateId }, data: { sourceArtifactId: artifact.id },
    });
    const request = async (
      key: string,
      expectedVersion = candidate.candidateVersion,
      expectedAclVersion = artifact.aclVersion,
    ) => test.app.inject({
      method: 'POST', url: '/api/review-batches', headers: auth(test.token, key),
      payload: {
        sourceArtifactId: artifact.id,
        expectedSourceAclVersion: artifact.aclVersion,
        candidates: [{
          id: candidate.candidateId, expectedVersion, expectedAclVersion,
        }],
      },
    });

    const staleVersion = await request(
      'core-205-attachment-stale-version', candidate.candidateVersion + 1,
    );
    expect(staleVersion.statusCode, staleVersion.body).toBe(409);
    const staleAcl = await request(
      'core-205-attachment-stale-acl', candidate.candidateVersion, artifact.aclVersion + 1,
    );
    expect(staleAcl.statusCode, staleAcl.body).toBe(409);
    await test.prisma.candidate.update({
      where: { id: candidate.candidateId }, data: { status: 'rejected' },
    });
    const terminal = await request('core-205-attachment-terminal');
    expect(terminal.statusCode, terminal.body).toBe(409);
    await test.prisma.candidate.update({
      where: { id: candidate.candidateId }, data: { status: 'pending' },
    });
    const created = await request('core-205-attachment-created');
    expect(created.statusCode, created.body).toBe(200);
    const alreadyBatched = await request('core-205-attachment-already-batched');
    expect(alreadyBatched.statusCode, alreadyBatched.body).toBe(409);
    await expect(test.prisma.reviewBatch.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(0);
    await expect(test.prisma.person.count()).resolves.toBe(0);
  });

  it('fails closed when any attached Candidate drifts to a different SourceArtifact', async () => {
    const sourceA = await registerArtifact('drift-source-a');
    const sourceB = await registerArtifact('drift-source-b');
    const candidateA = await personCandidate('drift-source-a');
    const candidateB = await personCandidate('drift-source-b');
    const batch = await createBatch('drift-source', sourceA, [candidateA, candidateB]);

    await test.prisma.candidate.update({
      where: { id: candidateB.candidateId },
      data: { sourceArtifactId: sourceB.id },
    });

    const hidden = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${batch.id}`, headers: auth(),
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual({
      error: '会后速审批次不存在', code: 'review_batch_not_found',
    });
  });

  it('lists metadata-only batches with bounded batched ACL queries and no formal writes', async () => {
    for (let index = 0; index < 6; index += 1) {
      const suffix = `list-${index}`;
      const artifact = await registerArtifact(suffix);
      const candidate = await personCandidate(suffix);
      await createBatch(suffix, artifact, [candidate]);
    }
    const formalBefore = await Promise.all([
      test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(), test.prisma.interaction.count(),
    ]);
    const firstPage = await test.app.inject({
      method: 'GET', url: '/api/review-batches?limit=5', headers: auth(),
    });
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json().items).toHaveLength(5);
    expect(firstPage.json().nextCursor).toBeTruthy();
    expect(firstPage.body).not.toContain('private candidate excerpt');
    expect(firstPage.body).not.toContain('Private meeting source');
    const secondPage = await test.app.inject({
      method: 'GET',
      url: `/api/review-batches?limit=5&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
      headers: auth(),
    });
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json()).toMatchObject({ nextCursor: null });
    expect(secondPage.json().items).toHaveLength(1);
    const queryClient = new PrismaClient();
    let queryCount = 0;
    queryClient.$use(async (params, next) => {
      queryCount += 1;
      return next(params);
    });
    try {
      const result = await queryClient.$transaction((tx) => readableReviewBatches(tx, {
        tenantId: test.tenant.id,
        actorId: test.owner.id,
        actorRole: 'owner',
        channel: 'web',
        requestId: 'core-205-list-query-bound',
        assertionMode: 'user_asserted',
      }, internalPolicy, { limit: 5 }), {
        isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000,
      });
      expect(result.items).toHaveLength(5);
      expect(result.nextCursor).toBeTruthy();
      expect(JSON.stringify(result)).not.toContain('private candidate excerpt');
      expect(JSON.stringify(result)).not.toContain('Private meeting source');
      expect(queryCount).toBeLessThanOrEqual(20);
    } finally {
      await queryClient.$disconnect();
    }
    expect(await Promise.all([
      test.prisma.person.count(), test.prisma.edge.count(), test.prisma.evidenceEvent.count(),
      test.prisma.planAction.count(), test.prisma.interaction.count(),
    ])).toEqual(formalBefore);
  });

  it('reauthorizes a completed batch-creation replay against the current parent scope', async () => {
    const member = await addUser('member', 'Replay creator');
    const memberToken = test.app.jwt.sign({
      userId: member.id, tenantId: test.tenant.id, role: 'member',
    });
    const sourceResponse = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(memberToken, 'core-205-create-replay-source'),
      payload: {
        source: 'meeting-test', externalRef: 'create-replay-source',
        title: 'Member private source', matterId,
      },
    });
    expect(sourceResponse.statusCode, sourceResponse.body).toBe(200);
    const artifact = sourceResponse.json<{ id: string; aclVersion: number }>();
    const candidate = await createPersonCandidate(test.prisma, {
      id: 'core-205-create-replay-candidate', tenantId: test.tenant.id, accountId, matterId,
      name: 'Replay candidate', source: 'meeting-test', sourceRef: 'create-replay:candidate',
      evidence: 'private replay evidence', confidence: 0.8, createdByUserId: member.id,
      dedupeKey: 'core-205-create-replay-candidate',
    });
    await test.prisma.candidate.update({
      where: { id: candidate.candidateId }, data: { sourceArtifactId: artifact.id },
    });
    const payload = {
      sourceArtifactId: artifact.id,
      expectedSourceAclVersion: artifact.aclVersion,
      candidates: [{
        id: candidate.candidateId,
        expectedVersion: candidate.candidateVersion,
        expectedAclVersion: artifact.aclVersion,
      }],
    };
    const first = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(memberToken, 'core-205-batch-create-replay-auth'), payload,
    });
    expect(first.statusCode, first.body).toBe(200);
    await test.prisma.tenant.update({
      where: { id: test.tenant.id }, data: { dataScopePolicy: 'scoped' },
    });

    const replay = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(memberToken, 'core-205-batch-create-replay-auth'), payload,
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.json()).toMatchObject({ code: 'review_batch_not_found' });
    await expect(test.prisma.reviewBatch.count()).resolves.toBe(1);
  });

  it('accepts once and replays the same batch/version without duplicate Person or Interaction', async () => {
    const artifact = await registerArtifact('person-accept');
    const candidate = await personCandidate('person-accept');
    const batch = await createBatch('person-accept', artifact, [candidate]);
    const item = batch.candidates[0]!;
    const payload = {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      decisions: [{
        candidateId: item.id, expectedVersion: item.version,
        expectedAclVersion: item.aclVersion, decision: 'accept',
        person: { name: 'Confirmed Person', title: 'Sponsor' },
      }],
    };
    const accepted = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-person-accept-a'), payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', businessReplayed: false });
    expect(accepted.json().interactionId).toMatch(/^interaction_/);
    expect(accepted.json().items[0]).toMatchObject({
      candidateId: item.id, status: 'accepted', formalKind: 'person',
    });
    const receipt = accepted.json();
    await expect(test.prisma.person.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);

    const replay = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-person-accept-b'), payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      businessReplayed: true,
      interactionId: receipt.interactionId,
      items: receipt.items,
    });
    await expect(test.prisma.person.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);

    const changedReplay = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-person-accept-c'),
      payload: { ...payload, activityKind: 'visit' },
    });
    expect(changedReplay.statusCode).toBe(409);
    await expect(test.prisma.person.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
    await expect(reportReviewBatchMigration(test.prisma)).resolves.toMatchObject({
      ok: true, reviewBatches: 1, interactions: 1, attachedCandidates: 1, conflicts: [],
    });
    const storedBatch = await test.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batch.id } });
    const driftedReceipt = JSON.parse(storedBatch.lastAcceptanceResult) as {
      items: Array<{ candidateId: string; formalId: string | null }>;
    };
    driftedReceipt.items[0]!.candidateId = 'core-205-receipt-foreign-candidate';
    await test.prisma.reviewBatch.update({
      where: { id: batch.id }, data: { lastAcceptanceResult: JSON.stringify(driftedReceipt) },
    });
    const driftedReport = await reportReviewBatchMigration(test.prisma);
    expect(driftedReport.ok).toBe(false);
    expect(driftedReport.conflicts).toContain(
      `${test.tenant.id}:review_batch:${batch.id}:acceptance_candidate_missing`,
    );
    driftedReceipt.items[0]!.candidateId = item.id;
    driftedReceipt.items[0]!.formalId = 'core-205-wrong-formal-person';
    await test.prisma.reviewBatch.update({
      where: { id: batch.id }, data: { lastAcceptanceResult: JSON.stringify(driftedReceipt) },
    });
    const formalDriftReport = await reportReviewBatchMigration(test.prisma);
    expect(formalDriftReport.ok).toBe(false);
    expect(formalDriftReport.conflicts).toContain(
      `${test.tenant.id}:review_batch:${batch.id}:acceptance_formal_identity_mismatch`,
    );
  });

  it('links only an exact tenant/source/parent/time Interaction and never creates a duplicate', async () => {
    const artifact = await registerArtifact('existing-interaction');
    const candidate = await personCandidate('existing-interaction');
    const batch = await createBatch('existing-interaction', artifact, [candidate]);
    const interactionId = 'core-205-existing-interaction';
    await test.prisma.interaction.create({ data: {
      id: interactionId,
      tenantId: test.tenant.id,
      accountId,
      matterId,
      sourceArtifactId: artifact.id,
      activityKind: 'meeting',
      occurredAt: new Date('2026-08-25T18:00:00.000Z'),
      createdByUserId: test.owner.id,
      confirmedByUserId: test.owner.id,
    } });
    const item = batch.candidates[0]!;
    const payload = {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      existingInteractionId: interactionId,
      decisions: [{
        candidateId: item.id,
        expectedVersion: item.version,
        expectedAclVersion: item.aclVersion,
        decision: 'accept',
      }],
    };
    const accepted = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-existing-interaction-accept'), payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ interactionId, status: 'accepted' });
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
    await expect(test.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batch.id } }))
      .resolves.toMatchObject({ interactionId });
  });

  it('reports a deterministic Interaction identity collision as an all-item conflict', async () => {
    const artifact = await registerArtifact('interaction-collision');
    const candidate = await personCandidate('interaction-collision');
    const batch = await createBatch('interaction-collision', artifact, [candidate]);
    const interactionId = interactionIdForReviewBatch(test.tenant.id, batch.id);
    await test.prisma.interaction.create({ data: {
      id: interactionId, tenantId: test.tenant.id, accountId, matterId,
      sourceArtifactId: artifact.id, activityKind: 'visit',
      occurredAt: new Date('2026-08-24T18:00:00.000Z'),
      createdByUserId: test.owner.id, confirmedByUserId: test.owner.id,
    } });
    const item = batch.candidates[0]!;
    const response = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-interaction-collision'),
      payload: {
        expectedVersion: batch.version,
        expectedAcceptanceVersion: batch.acceptanceVersion,
        accountId,
        matterId,
        activityKind: 'meeting',
        occurredAt: '2026-08-25T18:00:00.000Z',
        decisions: [{
          candidateId: item.id,
          expectedVersion: item.version,
          expectedAclVersion: item.aclVersion,
          decision: 'accept',
        }],
      },
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({
      code: 'review_batch_conflict',
      items: [{
        candidateId: item.id, status: 'conflict', reason: 'interaction_id_conflict',
      }],
    });
    await expect(test.prisma.person.count()).resolves.toBe(0);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: item.id } }))
      .resolves.toMatchObject({ status: 'pending' });
  });

  it('returns per-item conflicts and rolls the whole selected set back', async () => {
    const artifact = await registerArtifact('mixed-conflict');
    const createPerson = await personCandidate('mixed-conflict');
    const existingPersonId = 'core-205-existing-person';
    await test.prisma.person.create({ data: {
      id: existingPersonId, tenantId: test.tenant.id, accountId,
      name: 'Existing Person', title: 'Old title', form: '{}', logs: '[]',
    } });
    const field = await createFieldCandidate(test.prisma, {
      id: 'core-205-stale-field', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: existingPersonId, fieldKey: 'title',
      oldValue: 'Old title', newValue: 'New title', source: 'meeting-test',
      sourceRef: 'meeting:mixed-conflict', evidence: 'private field excerpt', confidence: 0.9,
      createdByUserId: test.owner.id,
    });
    const batch = await createBatch('mixed-conflict', artifact, [createPerson, field]);
    await test.prisma.person.update({ where: { id: existingPersonId }, data: { title: 'Human update' } });
    const byId = new Map(batch.candidates.map((candidate) => [candidate.id, candidate]));
    const payload = {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      decisions: [
        {
          candidateId: createPerson.candidateId,
          expectedVersion: byId.get(createPerson.candidateId)!.version,
          expectedAclVersion: byId.get(createPerson.candidateId)!.aclVersion,
          decision: 'accept',
        },
        {
          candidateId: field.candidateId,
          expectedVersion: byId.get(field.candidateId)!.version,
          expectedAclVersion: byId.get(field.candidateId)!.aclVersion,
          decision: 'accept',
        },
      ],
    };
    const response = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-mixed-conflict'), payload,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json()).toMatchObject({ code: 'review_batch_conflict' });
    expect(response.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: field.candidateId, status: 'conflict' }),
      expect.objectContaining({ candidateId: createPerson.candidateId, status: 'not_applied' }),
    ]));
    await expect(test.prisma.person.count({ where: { name: 'Candidate mixed-conflict' } })).resolves.toBe(0);
    await expect(test.prisma.interaction.count()).resolves.toBe(0);
    await expect(test.prisma.candidate.count({ where: {
      id: { in: [createPerson.candidateId, field.candidateId] }, status: 'pending',
    } })).resolves.toBe(2);
    await expect(test.prisma.person.findUniqueOrThrow({ where: { id: existingPersonId } }))
      .resolves.toMatchObject({ title: 'Human update' });
  });

  it('accepts edited field and evidence candidates through their existing formal authorities', async () => {
    const artifact = await registerArtifact('field-evidence');
    const personId = 'core-205-field-evidence-person';
    await test.prisma.person.create({ data: {
      id: personId, tenantId: test.tenant.id, accountId,
      name: 'Field and evidence person', title: 'Unconfirmed title', form: '{}', logs: '[]',
    } });
    await test.prisma.pdeDecisionContext.create({ data: {
      id: 'core-205-field-evidence-context', tenantId: test.tenant.id,
      opportunityId: matterId, stageKey: 'initiation', source: 'system_default',
    } });
    const field = await createFieldCandidate(test.prisma, {
      id: 'core-205-field-success', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: personId, fieldKey: 'title',
      oldValue: 'Unconfirmed title', newValue: 'Suggested title', source: 'meeting-test',
      sourceRef: 'meeting:field-evidence:field', evidence: 'private field evidence', confidence: 0.9,
      createdByUserId: test.owner.id,
    });
    const evidence = await createEvidenceCandidate(test.prisma, {
      id: 'core-205-evidence-success', tenantId: test.tenant.id, accountId, matterId, personId,
      signalKey: 'relationship_change', direction: 1, tier: 'strong',
      rawContent: 'private evidence body', occurredAt: '2026-08-25', source: 'meeting-test',
      sourceRef: 'meeting:field-evidence:evidence', confidence: 0.8,
      createdByUserId: test.owner.id,
    });
    const batch = await createBatch('field-evidence', artifact, [field, evidence]);
    const byId = new Map(batch.candidates.map((candidate) => [candidate.id, candidate]));
    const accepted = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-field-evidence-accept'),
      payload: {
        expectedVersion: batch.version,
        expectedAcceptanceVersion: batch.acceptanceVersion,
        accountId,
        matterId,
        activityKind: 'meeting',
        occurredAt: '2026-08-25T18:00:00.000Z',
        decisions: [
          {
            candidateId: field.candidateId,
            expectedVersion: byId.get(field.candidateId)!.version,
            expectedAclVersion: byId.get(field.candidateId)!.aclVersion,
            decision: 'accept',
            newValue: 'Confirmed title',
          },
          {
            candidateId: evidence.candidateId,
            expectedVersion: byId.get(evidence.candidateId)!.version,
            expectedAclVersion: byId.get(evidence.candidateId)!.aclVersion,
            decision: 'accept',
            evidence: { direction: -1, tier: 'weak' },
          },
        ],
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted' });
    expect(accepted.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: field.candidateId, formalKind: 'person' }),
      expect.objectContaining({ candidateId: evidence.candidateId, formalKind: 'evidence' }),
    ]));
    await expect(test.prisma.person.findUniqueOrThrow({ where: { id: personId } }))
      .resolves.toMatchObject({ title: 'Confirmed title' });
    await expect(test.prisma.evidenceEvent.findUniqueOrThrow({ where: { id: evidence.row.id } }))
      .resolves.toMatchObject({ status: 'approved', direction: -1, tier: 'weak' });
    await expect(test.prisma.candidate.count({ where: {
      id: { in: [field.candidateId, evidence.candidateId] }, status: 'accepted',
    } })).resolves.toBe(2);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
  });

  it('freezes SourceArtifact parent and visibility authority after a batch is anchored', async () => {
    const artifact = await registerArtifact('source-lock');
    const candidate = await personCandidate('source-lock');
    const batch = await createBatch('source-lock', artifact, [candidate]);
    const otherMatterId = 'core-205-other-matter';
    await test.prisma.opportunity.create({ data: {
      id: otherMatterId, tenantId: test.tenant.id, accountId, name: 'Other review matter',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });

    const visibility = await test.app.inject({
      method: 'PUT', url: `/api/source-artifacts/${artifact.id}/visibility`,
      headers: auth(test.token, 'core-205-source-lock-visibility'),
      payload: { visibility: 'matter_shared', expectedAclVersion: artifact.aclVersion },
    });
    expect(visibility.statusCode, visibility.body).toBe(409);
    expect(visibility.json()).toMatchObject({ code: 'source_artifact_review_batch_locked' });

    const mount = await test.app.inject({
      method: 'PATCH', url: `/api/source-artifacts/${artifact.id}/mount`,
      headers: auth(test.token, 'core-205-source-lock-mount'),
      payload: { matterId: otherMatterId, expectedAclVersion: artifact.aclVersion },
    });
    expect(mount.statusCode, mount.body).toBe(409);
    expect(mount.json()).toMatchObject({ code: 'source_artifact_review_batch_locked' });
    await expect(setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      kind: 'candidate',
      resourceId: candidate.candidateId,
      visibility: 'matter_shared',
      expectedAclVersion: artifact.aclVersion,
    }, internalPolicy)).rejects.toMatchObject({ code: 'candidate_review_batch_locked' });
    await expect(setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      kind: 'source_artifact',
      resourceId: artifact.id,
      visibility: 'matter_shared',
      expectedAclVersion: artifact.aclVersion,
    }, internalPolicy)).rejects.toMatchObject({ code: 'source_artifact_review_batch_locked' });
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({ where: { id: artifact.id } }))
      .resolves.toMatchObject({ matterId, visibility: 'private', aclVersion: artifact.aclVersion });
    await expect(test.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batch.id } }))
      .resolves.toMatchObject({ matterId, visibility: 'private', aclVersion: artifact.aclVersion });
  });

  it('honors a current explicit reviewer grant after batch attachment and denies replay after role downgrade', async () => {
    const artifact = await registerArtifact('reviewer');
    const candidate = await personCandidate('reviewer');
    const sourceShared = await test.app.inject({
      method: 'PUT', url: `/api/source-artifacts/${artifact.id}/visibility`,
      headers: auth(test.token, 'core-205-reviewer-source-share'),
      payload: { visibility: 'matter_shared', expectedAclVersion: artifact.aclVersion },
    });
    expect(sourceShared.statusCode, sourceShared.body).toBe(200);
    const candidateShared = await setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      kind: 'candidate',
      resourceId: candidate.candidateId,
      visibility: 'matter_shared',
      expectedAclVersion: artifact.aclVersion,
    }, internalPolicy);
    expect(candidateShared.aclVersion).toBe(sourceShared.json().aclVersion);
    const batch = await createBatch('reviewer', sourceShared.json(), [candidate]);
    const reviewer = await addUser('member', 'Batch reviewer');
    const reviewerToken = test.app.jwt.sign({
      userId: reviewer.id, tenantId: test.tenant.id, role: 'member',
    });
    const granted = await grantCandidateReviewer(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      candidateId: candidate.candidateId,
      granteeUserId: reviewer.id,
      expectedAclVersion: candidateShared.aclVersion,
    }, internalPolicy);
    const attached = await test.prisma.candidate.findUniqueOrThrow({
      where: { id: candidate.candidateId },
    });
    expect(attached.aclVersion).toBe(granted.aclVersion);

    const payload = {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      decisions: [{
        candidateId: candidate.candidateId,
        expectedVersion: attached.version,
        expectedAclVersion: attached.aclVersion,
        decision: 'accept',
      }],
    };
    const accepted = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(reviewerToken, 'core-205-reviewer-accept'), payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({ status: 'accepted', businessReplayed: false });
    await test.prisma.user.update({ where: { id: reviewer.id }, data: { role: 'viewer' } });
    const before = await Promise.all([
      test.prisma.person.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    const deniedReplay = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(reviewerToken, 'core-205-reviewer-accept'), payload,
    });
    expect(deniedReplay.statusCode, deniedReplay.body).toBe(403);
    expect(deniedReplay.json()).toMatchObject({ code: 'viewer_write_denied' });
    expect(await Promise.all([
      test.prisma.person.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).toEqual(before);

    await test.prisma.user.update({ where: { id: reviewer.id }, data: { role: 'member' } });
    await revokeCandidateReviewer(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      candidateId: candidate.candidateId,
      granteeUserId: reviewer.id,
      expectedAclVersion: granted.aclVersion,
    }, internalPolicy);
    const revokedReplay = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(reviewerToken, 'core-205-reviewer-accept'), payload,
    });
    expect(revokedReplay.statusCode, revokedReplay.body).toBe(404);
    await expect(test.prisma.person.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
  });

  it('never implicitly materializes a pending relation endpoint and replays an explicit pair without duplicates', async () => {
    const artifact = await registerArtifact('relation');
    const suggested = await personCandidate('relation-endpoint');
    const existingPersonId = 'core-205-relation-existing';
    await test.prisma.person.create({ data: {
      id: existingPersonId, tenantId: test.tenant.id, accountId,
      name: 'Existing endpoint', title: 'Sponsor', form: '{}', logs: '[]',
    } });
    const relation = await createRelationCandidate(test.prisma, {
      id: 'core-205-relation-candidate',
      tenantId: test.tenant.id,
      matterId,
      source: { kind: 'suggestion', id: suggested.row.id },
      target: { kind: 'person', id: existingPersonId },
      layer: 'L3',
      label: 'Candidate relation',
      sourceType: 'meeting-test',
      sourceRef: 'meeting:relation',
      evidence: 'private relation excerpt',
      confidence: 0.75,
      createdByUserId: test.owner.id,
      dedupeKey: 'core-205-relation-dedupe',
    });
    const batch = await createBatch('relation', artifact, [suggested, relation]);
    const byId = new Map(batch.candidates.map((candidate) => [candidate.id, candidate]));
    const relationOnly = {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      decisions: [{
        candidateId: relation.candidateId,
        expectedVersion: byId.get(relation.candidateId)!.version,
        expectedAclVersion: byId.get(relation.candidateId)!.aclVersion,
        decision: 'accept',
      }],
    };
    const blocked = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-relation-implicit-blocked'), payload: relationOnly,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json().items).toEqual([
      expect.objectContaining({ candidateId: relation.candidateId, reason: 'relation_endpoint_not_selected' }),
    ]);
    await expect(test.prisma.person.count({ where: { id: { not: existingPersonId } } })).resolves.toBe(0);
    await expect(test.prisma.edge.count()).resolves.toBe(0);
    await expect(test.prisma.interaction.count()).resolves.toBe(0);

    const explicit = {
      ...relationOnly,
      decisions: [
        {
          candidateId: suggested.candidateId,
          expectedVersion: byId.get(suggested.candidateId)!.version,
          expectedAclVersion: byId.get(suggested.candidateId)!.aclVersion,
          decision: 'accept',
        },
        relationOnly.decisions[0],
      ],
    };
    const accepted = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-relation-explicit'), payload: explicit,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateId: suggested.candidateId, formalKind: 'person' }),
      expect.objectContaining({ candidateId: relation.candidateId, formalKind: 'relation' }),
    ]));
    await expect(test.prisma.person.count()).resolves.toBe(2);
    await expect(test.prisma.edge.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
    const replay = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-relation-replay'), payload: explicit,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ businessReplayed: true });
    await expect(test.prisma.person.count()).resolves.toBe(2);
    await expect(test.prisma.edge.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
  });

  it('creates a Commitment once, keeps receipts content-free, and rolls back a later apply conflict', async () => {
    const artifact = await registerArtifact('commitment');
    const placeholder = await personCandidate('commitment-placeholder');
    const batch = await createBatch('commitment', artifact, [placeholder]);
    const secret = 'CORE205_SECRET_EVIDENCE_DO_NOT_COPY';
    const commitment = createCommitmentReviewCandidate({
      tenantId: test.tenant.id,
      accountId,
      matterId,
      sourceArtifactId: artifact.id,
      reviewBatchId: batch.id,
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: artifact.aclVersion,
      source: 'post_meeting_extract',
      sourceRef: 'artifact:commitment',
      evidence: secret,
      confidence: 0.8,
      commitment: {
        customerId: accountId, matterId, personId: null,
        title: 'Sensitive commitment title', kind: 'follow_up', ownerUserId: test.owner.id,
        confirmationStatus: 'not_required', scheduledAtUtc: '2026-08-26T02:00:00.000Z',
        dueAtUtc: null, timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
        confirmationDueAtUtc: null,
      },
    });
    await test.prisma.candidate.create({ data: commitment });
    const payload = {
      expectedVersion: batch.version,
      expectedAcceptanceVersion: batch.acceptanceVersion,
      accountId,
      matterId,
      activityKind: 'meeting',
      occurredAt: '2026-08-25T18:00:00.000Z',
      decisions: [{
        candidateId: commitment.id,
        expectedVersion: commitment.version,
        expectedAclVersion: commitment.aclVersion,
        decision: 'accept',
      }],
    };
    const accepted = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-commitment-accept'), payload,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({
      status: 'pending',
      items: [{ candidateId: commitment.id, formalKind: 'commitment' }],
    });
    const replay = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-commitment-replay'), payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ businessReplayed: true });
    await expect(test.prisma.planAction.count()).resolves.toBe(1);
    await expect(test.prisma.interaction.count()).resolves.toBe(1);
    const [storedBatch, commandRuns, audits, interaction] = await Promise.all([
      test.prisma.reviewBatch.findUniqueOrThrow({ where: { id: batch.id } }),
      test.prisma.commandRun.findMany({ where: { tenantId: test.tenant.id } }),
      test.prisma.auditEvent.findMany({ where: { tenantId: test.tenant.id } }),
      test.prisma.interaction.findFirstOrThrow({ where: { tenantId: test.tenant.id } }),
    ]);
    expect(JSON.stringify({ storedBatch, commandRuns, audits, interaction })).not.toContain(secret);
    expect(JSON.stringify({ storedBatch, commandRuns, audits, interaction })).not.toContain('Sensitive commitment title');
    expect(interaction.title).toBe('');

    const secondArtifact = await registerArtifact('late-conflict');
    const validPerson = await personCandidate('late-conflict');
    const secondBatch = await createBatch('late-conflict', secondArtifact, [validPerson]);
    const invalidCommitment = createCommitmentReviewCandidate({
      tenantId: test.tenant.id,
      accountId,
      matterId,
      sourceArtifactId: secondArtifact.id,
      reviewBatchId: secondBatch.id,
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: secondArtifact.aclVersion,
      source: 'post_meeting_extract',
      sourceRef: 'artifact:late-conflict',
      evidence: 'late apply conflict',
      confidence: 0.8,
      commitment: {
        customerId: accountId, matterId, personId: null,
        title: 'Must roll back', kind: 'follow_up', ownerUserId: 'missing-owner',
        confirmationStatus: 'not_required', scheduledAtUtc: '2026-08-27T02:00:00.000Z',
        dueAtUtc: null, timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
        confirmationDueAtUtc: null,
      },
    });
    await test.prisma.candidate.create({ data: invalidCommitment });
    const attachedPerson = await test.prisma.candidate.findUniqueOrThrow({
      where: { id: validPerson.candidateId },
    });
    const beforeLateConflict = await Promise.all([
      test.prisma.person.count(), test.prisma.planAction.count(), test.prisma.interaction.count(),
    ]);
    const lateConflict = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${secondBatch.id}/accept`,
      headers: auth(test.token, 'core-205-late-apply-conflict'),
      payload: {
        expectedVersion: secondBatch.version,
        expectedAcceptanceVersion: secondBatch.acceptanceVersion,
        accountId,
        matterId,
        activityKind: 'meeting',
        occurredAt: '2026-08-25T18:00:00.000Z',
        decisions: [
          {
            candidateId: validPerson.candidateId,
            expectedVersion: attachedPerson.version,
            expectedAclVersion: attachedPerson.aclVersion,
            decision: 'accept',
          },
          {
            candidateId: invalidCommitment.id,
            expectedVersion: invalidCommitment.version,
            expectedAclVersion: invalidCommitment.aclVersion,
            decision: 'accept',
          },
        ],
      },
    });
    expect(lateConflict.statusCode, lateConflict.body).toBe(409);
    expect(await Promise.all([
      test.prisma.person.count(), test.prisma.planAction.count(), test.prisma.interaction.count(),
    ])).toEqual(beforeLateConflict);
    await expect(test.prisma.candidate.count({ where: {
      id: { in: [validPerson.candidateId, invalidCommitment.id] }, status: 'pending',
    } })).resolves.toBe(2);
  });

  it('fails closed when a pending batch SourceArtifact becomes a tombstone', async () => {
    const artifact = await registerArtifact('deleted-source');
    const candidate = await personCandidate('deleted-source');
    const batch = await createBatch('deleted-source', artifact, [candidate]);
    const deleted = await test.app.inject({
      method: 'DELETE', url: `/api/source-artifacts/${artifact.id}`,
      headers: auth(test.token, 'core-205-delete-source'),
      payload: { expectedAclVersion: artifact.aclVersion },
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toMatchObject({ retentionState: 'deleted' });
    const item = batch.candidates[0]!;
    const accepted = await test.app.inject({
      method: 'POST', url: `/api/review-batches/${batch.id}/accept`,
      headers: auth(test.token, 'core-205-deleted-source-accept'),
      payload: {
        expectedVersion: batch.version,
        expectedAcceptanceVersion: batch.acceptanceVersion,
        accountId,
        matterId,
        activityKind: 'meeting',
        occurredAt: '2026-08-25T18:00:00.000Z',
        decisions: [{
          candidateId: item.id,
          expectedVersion: item.version,
          expectedAclVersion: item.aclVersion,
          decision: 'accept',
        }],
      },
    });
    expect(accepted.statusCode, accepted.body).toBe(404);
    await expect(test.prisma.person.count()).resolves.toBe(0);
    await expect(test.prisma.interaction.count()).resolves.toBe(0);
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: item.id } }))
      .resolves.toMatchObject({ status: 'pending' });
  });

  it('denies viewer writes and hides another creator private batch with the same 404 shape', async () => {
    const artifact = await registerArtifact('acl');
    const candidate = await personCandidate('acl');
    const batch = await createBatch('acl', artifact, [candidate]);
    const viewer = await addUser('viewer', 'Viewer');
    const viewerToken = test.app.jwt.sign({
      userId: viewer.id, tenantId: test.tenant.id, role: 'viewer',
    });
    const hidden = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${batch.id}`, headers: auth(viewerToken),
    });
    const missing = await test.app.inject({
      method: 'GET', url: '/api/review-batches/missing-batch', headers: auth(viewerToken),
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual(missing.json());

    const before = await Promise.all([
      test.prisma.reviewBatch.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ]);
    const denied = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(viewerToken, 'core-205-viewer-denied'),
      payload: {
        sourceArtifactId: artifact.id,
        expectedSourceAclVersion: artifact.aclVersion,
        candidates: [{
          id: candidate.candidateId,
          expectedVersion: candidate.candidateVersion,
          expectedAclVersion: artifact.aclVersion,
        }],
      },
    });
    expect(denied.statusCode).toBe(403);
    expect(await Promise.all([
      test.prisma.reviewBatch.count(), test.prisma.interaction.count(),
      test.prisma.commandRun.count(), test.prisma.auditEvent.count(),
    ])).toEqual(before);
  });

  it('never exposes a valid batch from another tenant by ID or list pagination', async () => {
    const localArtifact = await registerArtifact('tenant-cursor-local');
    const localCandidate = await personCandidate('tenant-cursor-local');
    const localBatch = await createBatch(
      'tenant-cursor-local', localArtifact, [localCandidate],
    );
    const registration = await test.app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: {
        email: `foreign-core-205-${randomUUID()}@example.test`,
        password: 'test-password', name: 'Foreign owner', tenantName: 'Foreign tenant',
      },
    });
    expect(registration.statusCode, registration.body).toBe(200);
    const foreign = registration.json<{
      token: string;
      tenant: { id: string };
      user: { id: string };
    }>();
    const foreignAccountId = 'core-205-foreign-account';
    const foreignMatterId = 'core-205-foreign-matter';
    await test.prisma.account.create({ data: {
      id: foreignAccountId, tenantId: foreign.tenant.id, name: 'Foreign account',
      primaryOwnerUserId: foreign.user.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: foreignMatterId, tenantId: foreign.tenant.id, accountId: foreignAccountId,
      name: 'Foreign matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      primaryOwnerUserId: foreign.user.id,
    } });
    const sourceResponse = await test.app.inject({
      method: 'POST', url: '/api/source-artifacts/external',
      headers: auth(foreign.token, 'core-205-foreign-source'),
      payload: {
        source: 'meeting-test', externalRef: 'foreign-source',
        title: 'Foreign private source', matterId: foreignMatterId,
      },
    });
    expect(sourceResponse.statusCode, sourceResponse.body).toBe(200);
    const source = sourceResponse.json<{ id: string; aclVersion: number }>();
    const candidate = await createPersonCandidate(test.prisma, {
      id: 'core-205-foreign-candidate', tenantId: foreign.tenant.id,
      accountId: foreignAccountId, matterId: foreignMatterId,
      name: 'Foreign candidate', source: 'meeting-test', sourceRef: 'foreign:candidate',
      evidence: 'foreign private evidence', confidence: 0.8,
      createdByUserId: foreign.user.id, dedupeKey: 'core-205-foreign-candidate',
    });
    await test.prisma.candidate.update({
      where: { id: candidate.candidateId }, data: { sourceArtifactId: source.id },
    });
    const created = await test.app.inject({
      method: 'POST', url: '/api/review-batches',
      headers: auth(foreign.token, 'core-205-foreign-batch'),
      payload: {
        sourceArtifactId: source.id,
        expectedSourceAclVersion: source.aclVersion,
        candidates: [{
          id: candidate.candidateId,
          expectedVersion: candidate.candidateVersion,
          expectedAclVersion: source.aclVersion,
        }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const foreignBatchId = created.json().id as string;

    const byId = await test.app.inject({
      method: 'GET', url: `/api/review-batches/${foreignBatchId}`, headers: auth(),
    });
    expect(byId.statusCode).toBe(404);
    const list = await test.app.inject({
      method: 'GET', url: '/api/review-batches?limit=100', headers: auth(),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.body).not.toContain(foreignBatchId);
    expect(list.body).toContain(localBatch.id);
    expect(list.body).not.toContain('Foreign candidate');
    expect(list.body).not.toContain('foreign private evidence');

    const foreignCursor = await test.app.inject({
      method: 'GET',
      url: `/api/review-batches?limit=100&cursor=${encodeURIComponent(foreignBatchId)}`,
      headers: auth(),
    });
    const missingCursor = await test.app.inject({
      method: 'GET', url: '/api/review-batches?limit=100&cursor=missing-foreign-cursor',
      headers: auth(),
    });
    expect(foreignCursor.statusCode, foreignCursor.body).toBe(200);
    expect(missingCursor.statusCode, missingCursor.body).toBe(200);
    expect(foreignCursor.json()).toEqual({ items: [], nextCursor: null });
    expect(foreignCursor.json()).toEqual(missingCursor.json());
  });
});
