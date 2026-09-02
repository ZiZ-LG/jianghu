import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ReviewHypothesisVerificationCommand,
  SalesHypothesisCommand,
} from '@jianghu/domain-contracts';
import { api } from './api';
import { RELATIONSHIP_WORKSPACE_FIXTURE } from './testFixtures/relationshipWorkspace';

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

afterEach(() => {
  api.setToken(null);
  vi.unstubAllGlobals();
});

describe('SAAS-208 relationship workspace transport', () => {
  it('encodes exact parents and rejects a successful cross-parent projection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, RELATIONSHIP_WORKSPACE_FIXTURE))
      .mockResolvedValueOnce(response(200, RELATIONSHIP_WORKSPACE_FIXTURE));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.relationshipWorkspace('customer-208', 'matter-208'))
      .resolves.toEqual(RELATIONSHIP_WORKSPACE_FIXTURE);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://localhost:3001/api/relationship-workspace?customerId=customer-208&matterId=matter-208',
    );
    await expect(api.relationshipWorkspace('other-customer', 'matter-208'))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('keeps the human review idempotency key and validates the exact receipt', async () => {
    const command: ReviewHypothesisVerificationCommand = {
      type: 'REVIEW_HYPOTHESIS_VERIFICATION',
      customerId: 'customer-208', matterId: 'matter-208',
      commitmentId: 'commitment_00000000000000000000000000000208',
      expectedCommitmentVersion: 1, expectedCommitmentScheduleVersion: 0,
      salesHypothesisId: 'hypothesis-208', expectedHypothesisVersion: 0,
      expectedCurrentRevisionId: 'revision-208', disposition: 'keep',
      ownerUserId: 'owner-208', nextReviewAt: '2026-09-08T12:00:00.000Z',
    };
    const receipt = {
      type: command.type, customerId: command.customerId, matterId: command.matterId,
      commitmentId: command.commitmentId, salesHypothesisId: command.salesHypothesisId,
      previousRevisionId: command.expectedCurrentRevisionId,
      currentRevisionId: command.expectedCurrentRevisionId, disposition: 'kept',
      commitmentVersion: 2, hypothesisVersion: 1, replayed: true, undoable: false,
    };
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(response(200, receipt))
      .mockResolvedValueOnce(response(200, { ...receipt, commitmentId: 'other-commitment' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.reviewHypothesisVerification(command, 'stable-review-key')).resolves.toEqual(receipt);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls.slice(0, 2)) {
      expect(((init as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('stable-review-key');
      expect(JSON.parse(String((init as RequestInit).body))).toEqual(command);
    }
    await expect(api.reviewHypothesisVerification(command, 'mismatched-review-key'))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

  it('sends only the typed approved-Evidence link command and checks its Commitment pointer', async () => {
    const command: SalesHypothesisCommand = {
      type: 'LINK_HYPOTHESIS_EVIDENCE',
      link: {
        id: 'hypothesisevidence_00000000000000000000000000000208',
        salesHypothesisId: 'hypothesis-208', expectedVersion: 0,
        expectedCurrentRevisionId: 'revision-208', evidenceId: 'evidence-208', evidenceVersion: 0,
        direction: 'supporting',
        verificationCommitmentId: 'commitment_00000000000000000000000000000208',
      },
    };
    const receipt = {
      type: command.type, salesHypothesisId: command.link.salesHypothesisId,
      customerId: 'customer-208', matterId: 'matter-208',
      currentRevisionId: command.link.expectedCurrentRevisionId, currentRevisionNumber: 1,
      evidenceLinkId: command.link.id,
      verificationCommitmentId: command.link.verificationCommitmentId,
      status: 'testing', version: 1, replayed: false, undoable: false,
    };
    vi.stubGlobal('fetch', vi.fn(async () => response(200, receipt)));

    await expect(api.salesHypothesisCommand(command, 'stable-evidence-key')).resolves.toEqual(receipt);
  });
});
