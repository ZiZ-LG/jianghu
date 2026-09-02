import { describe, expect, it } from 'vitest';
import {
  artifactIdForBacking,
  artifactIdForExternalReference,
  contentFingerprint,
  referenceFingerprint,
  sourceArtifactProjectionForNote,
  sourceArtifactProjectionForTranscript,
  validateSourceArtifactProjection,
} from '../src/sourceArtifacts/model.js';

describe('SAAS-201 SourceArtifact projection model', () => {
  it('derives stable tenant- and creator-domain identities without copying bodies', () => {
    expect(artifactIdForBacking('tenant-a', 'note', 'note-1'))
      .toBe(artifactIdForBacking('tenant-a', 'note', 'note-1'));
    expect(artifactIdForBacking('tenant-a', 'note', 'note-1'))
      .not.toBe(artifactIdForBacking('tenant-b', 'note', 'note-1'));
    expect(artifactIdForExternalReference('tenant-a', 'creator-private-v1:"user-a"', 'feishu', 'minute-1'))
      .not.toBe(artifactIdForExternalReference('tenant-a', 'creator-private-v1:"user-b"', 'feishu', 'minute-1'));

    expect(contentFingerprint('private body')).toMatch(/^[a-f0-9]{64}$/);
    expect(referenceFingerprint({
      idempotencyDomain: 'creator-private-v1:"user-a"', source: 'feishu', externalRef: 'minute-1',
    })).toMatch(/^[a-f0-9]{64}$/);
  });

  it('maps Note and Transcript authorities to strict body-free metadata', () => {
    const note = sourceArtifactProjectionForNote({
      id: 'note-1', tenantId: 'tenant-a', accountId: null, opportunityId: null, personId: null,
      content: 'private body', source: 'manual', createdByUserId: 'user-a', visibility: 'private',
      aclVersion: 1, createdAt: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(note).toMatchObject({
      id: artifactIdForBacking('tenant-a', 'note', 'note-1'),
      backingKind: 'note', backingId: 'note-1', artifactKind: 'note', source: 'manual',
      retentionState: 'available', fingerprintKind: 'content_sha256_v1',
      createdByUserId: 'user-a', visibility: 'private', aclVersion: 1,
    });
    expect(note).not.toHaveProperty('content');
    expect(JSON.stringify(note)).not.toContain('private body');

    const upload = sourceArtifactProjectionForTranscript({
      id: 'tr-1', tenantId: 'tenant-a', accountId: 'account-a', opportunityId: 'matter-a',
      personId: null, source: 'upload', externalRef: 'upload-1',
      idempotencyDomain: 'creator-private-v1:"user-a"', title: 'meeting.txt',
      contentEnc: 'ciphertext-only', recordedAt: null, status: 'active',
      createdByUserId: 'user-a', visibility: 'matter_shared', aclVersion: 3,
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(upload).toMatchObject({
      backingKind: 'transcript', backingId: 'tr-1', artifactKind: 'uploaded_file',
      source: 'upload', externalRef: 'upload-1', retentionState: 'available',
      fingerprintKind: 'content_sha256_v1', visibility: 'matter_shared', aclVersion: 3,
    });
    expect(upload).not.toHaveProperty('contentEnc');
    expect(JSON.stringify(upload)).not.toContain('ciphertext-only');
  });

  it('distinguishes degraded content and rejects malformed lifecycle metadata', () => {
    const degraded = sourceArtifactProjectionForTranscript({
      id: 'tr-redacted', tenantId: 'tenant-a', accountId: null, opportunityId: null, personId: null,
      source: 'manual', externalRef: null, idempotencyDomain: 'creator-private-v1:"user-a"',
      title: '', contentEnc: '', recordedAt: null, status: 'redacted',
      createdByUserId: 'user-a', visibility: 'private', aclVersion: 1,
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(degraded).toMatchObject({
      retentionState: 'degraded', fingerprintKind: 'reference_sha256_v1',
    });
    expect(validateSourceArtifactProjection(degraded)).toEqual({ ok: true });
    expect(validateSourceArtifactProjection({ ...degraded, retentionState: 'available' }))
      .toEqual({ ok: false, code: 'available_content_fingerprint_required' });
    expect(validateSourceArtifactProjection({ ...degraded, visibility: 'matter_shared' }))
      .toEqual({ ok: false, code: 'shared_matter_required' });
    expect(validateSourceArtifactProjection({
      ...degraded, idempotencyDomain: 'creator-private-v1:"another-user"',
    })).toEqual({ ok: false, code: 'idempotency_domain_invalid' });
    expect(validateSourceArtifactProjection({
      ...degraded, backingKind: 'note', artifactKind: 'note',
    })).toEqual({ ok: false, code: 'degraded_transcript_required' });
    expect(validateSourceArtifactProjection({ ...degraded, artifactKind: 'uploaded_file' }))
      .toEqual({ ok: false, code: 'transcript_artifact_kind_invalid' });
  });
});
