import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateCommitmentCommandSchema } from '@jianghu/domain-contracts';
import { canonicalCandidateJson } from '../src/candidates/migration.js';
import {
  createCommitmentReviewCandidate,
  interactionIdForReviewBatch,
} from '../src/reviewBatches/model.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

describe('CORE-205 acceptance model', () => {
  let test: TestContext;

  beforeEach(async () => { test = await createTestContext(); });
  afterEach(async () => test.cleanup());

  it('derives deterministic formal identities and a strict Commitment candidate without a parallel contract', () => {
    expect(interactionIdForReviewBatch('tenant-a', 'batch-a'))
      .toBe(interactionIdForReviewBatch('tenant-a', 'batch-a'));
    expect(interactionIdForReviewBatch('tenant-a', 'batch-a'))
      .not.toBe(interactionIdForReviewBatch('tenant-b', 'batch-a'));

    const input = {
      tenantId: test.tenant.id,
      accountId: 'account-a',
      matterId: null,
      sourceArtifactId: 'artifact-a',
      reviewBatchId: null,
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: 1,
      source: 'post_meeting_extract',
      sourceRef: 'artifact:artifact-a',
      evidence: 'review-only excerpt',
      confidence: 0.7,
      commitment: {
        customerId: 'account-a', matterId: null, personId: null,
        title: 'Send confirmed proposal', kind: 'follow_up', ownerUserId: test.owner.id,
        confirmationStatus: 'not_required', scheduledAtUtc: '2026-08-26T02:00:00.000Z',
        dueAtUtc: null, timeZone: 'Asia/Shanghai', isAllDay: false, localDate: null,
        confirmationDueAtUtc: null,
      },
    } as const;
    const candidate = createCommitmentReviewCandidate(input);
    expect(candidate.kind).toBe('commitment_create');
    expect(candidate.sourceArtifactId).toBe('artifact-a');
    expect(candidate.reviewBatchId).toBeNull();
    expect(candidate.payload).toBe(canonicalCandidateJson(JSON.parse(candidate.payload)));
    const parsed = JSON.parse(candidate.payload) as { command: unknown };
    expect(CreateCommitmentCommandSchema.safeParse(parsed.command).success).toBe(true);
    expect(candidate).not.toHaveProperty('reviewCandidate');
    expect(() => createCommitmentReviewCandidate({ ...input, tenantId: '' }))
      .toThrow('commitment candidate tenant required');
    expect(() => createCommitmentReviewCandidate({ ...input, sourceRef: '' }))
      .toThrow('commitment candidate source ref required');
    expect(() => createCommitmentReviewCandidate({ ...input, evidence: '' }))
      .toThrow('commitment candidate evidence required');
    expect(() => createCommitmentReviewCandidate({ ...input, aclVersion: 0 }))
      .toThrow('commitment candidate ACL version invalid');
    expect(() => createCommitmentReviewCandidate({ ...input, reviewBatchId: '' }))
      .toThrow('commitment candidate review batch invalid');
  });
});
