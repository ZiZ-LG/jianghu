import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleProductAccess, type CapabilityPolicy } from '@jianghu/domain-contracts';
import {
  authorizeSensitiveResource,
  createSensitiveAccessEvaluator,
  requireCandidateReviewAccess,
  requireCandidateReviewAccessMany,
  type SensitiveResourceDescriptor,
} from '../src/sensitiveAccess.js';
import {
  grantCandidateReviewer,
  revokeCandidateReviewer,
  setSensitiveResourceVisibility,
} from '../src/sensitiveAcl/service.js';
import { createFieldCandidate } from '../src/candidates/reviewItems.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

const internalPolicy = assembleProductAccess({ edition: 'internal' }).policy;
const commercialPolicy = assembleProductAccess({ edition: 'commercial' }).policy;

describe('CORE-204 sensitive creator/share ACL', () => {
  let test: TestContext;
  const accountId = 'core-204-account';
  const matterId = 'core-204-matter';

  beforeEach(async () => {
    test = await createTestContext();
    await test.prisma.account.create({ data: {
      id: accountId,
      tenantId: test.tenant.id,
      name: 'Sensitive account',
      primaryOwnerUserId: test.owner.id,
    } });
    await test.prisma.opportunity.create({ data: {
      id: matterId,
      tenantId: test.tenant.id,
      accountId,
      name: 'Sensitive matter',
      customerType: 1,
      pipelineStage: 'lead',
      engageStage: 'discover',
      primaryOwnerUserId: test.owner.id,
    } });
  });

  afterEach(async () => test.cleanup());

  async function addUser(role: Role, label: string) {
    return test.prisma.user.create({ data: {
      tenantId: test.tenant.id,
      email: `${label}-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: label,
      role,
    } });
  }

  function principal(userId: string, role: Role = 'member') {
    return { tenantId: test.tenant.id, userId, role };
  }

  function descriptor(overrides: Partial<SensitiveResourceDescriptor> = {}): SensitiveResourceDescriptor {
    return {
      kind: 'candidate',
      id: 'candidate-core-204',
      tenantId: test.tenant.id,
      accountId,
      matterId,
      personId: null,
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: 1,
      ...overrides,
    };
  }

  async function allowed(
    actorId: string,
    resource: SensitiveResourceDescriptor,
    intent: 'read' | 'manage' | 'review',
    policy: CapabilityPolicy = internalPolicy,
    role: Role = 'member',
  ) {
    return authorizeSensitiveResource(test.prisma, principal(actorId, role), policy, resource, intent);
  }

  it('keeps known private content creator-only even for owner/admin and manager-shaped members', async () => {
    const manager = await addUser('member', 'Regional Manager');
    const admin = await addUser('admin', 'Admin');

    await expect(allowed(test.owner.id, descriptor(), 'read', internalPolicy, 'viewer'))
      .resolves.toMatchObject({ allowed: true, actorRole: 'owner' });
    await expect(allowed(manager.id, descriptor(), 'read')).resolves.toMatchObject({
      allowed: false,
      reason: 'private_creator_required',
    });
    await expect(allowed(admin.id, descriptor(), 'read', internalPolicy, 'admin')).resolves.toMatchObject({
      allowed: false,
      reason: 'private_creator_required',
    });
  });

  it('intersects matter sharing with current product permission and parent scope', async () => {
    const reader = await addUser('member', 'Shared reader');
    const shared = descriptor({ visibility: 'matter_shared' });

    await expect(allowed(reader.id, shared, 'read', commercialPolicy)).resolves.toMatchObject({
      allowed: false,
      reason: 'shared_permission_required',
    });
    await expect(allowed(reader.id, shared, 'read')).resolves.toMatchObject({ allowed: true });

    await test.prisma.tenant.update({
      where: { id: test.tenant.id },
      data: { dataScopePolicy: 'scoped' },
    });
    await expect(allowed(reader.id, shared, 'read')).resolves.toMatchObject({
      allowed: false,
      reason: 'parent_scope_denied',
    });
    await test.prisma.opportunity.update({
      where: { id: matterId },
      data: { primaryOwnerUserId: reader.id },
    });
    await expect(allowed(reader.id, shared, 'read')).resolves.toMatchObject({ allowed: true });
  });

  it('requires an active same-version reviewer grant and rechecks role and revocation every request', async () => {
    const reviewer = await addUser('member', 'Reviewer');
    await test.prisma.candidate.create({ data: {
      id: 'candidate-core-204', tenantId: test.tenant.id, kind: 'field', status: 'pending',
      accountId, matterId, targetKind: 'account', source: 'voice', sourceRef: 'voice:204',
      evidence: 'sensitive evidence', confidence: 0.8, createdByUserId: test.owner.id,
      visibility: 'matter_shared', aclVersion: 1, dedupeKey: 'candidate-core-204',
    } });

    await expect(allowed(reviewer.id, descriptor({ visibility: 'matter_shared' }), 'review'))
      .resolves.toMatchObject({ allowed: false, reason: 'reviewer_grant_required' });

    const grant = await grantCandidateReviewer(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      candidateId: 'candidate-core-204',
      granteeUserId: reviewer.id,
      expectedAclVersion: 1,
      requestId: 'grant-request',
    }, internalPolicy);
    expect(grant.aclVersion).toBe(2);
    expect(grant.grantId).toBeTruthy();

    const current = descriptor({ visibility: 'matter_shared', aclVersion: 2 });
    await expect(allowed(reviewer.id, current, 'review')).resolves.toMatchObject({ allowed: true });

    await test.prisma.user.update({ where: { id: reviewer.id }, data: { role: 'viewer' } });
    await expect(allowed(reviewer.id, current, 'review', internalPolicy, 'member'))
      .resolves.toMatchObject({ allowed: false, reason: 'write_role_denied' });
    await test.prisma.user.update({ where: { id: reviewer.id }, data: { role: 'member' } });

    const revoked = await revokeCandidateReviewer(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      candidateId: 'candidate-core-204',
      granteeUserId: reviewer.id,
      expectedAclVersion: 2,
      requestId: 'revoke-request',
    }, internalPolicy);
    expect(revoked.aclVersion).toBe(3);
    await expect(allowed(reviewer.id, descriptor({ visibility: 'matter_shared', aclVersion: 3 }), 'review'))
      .resolves.toMatchObject({ allowed: false, reason: 'reviewer_grant_required' });
  });

  it('permits only current owner/admin to handle creatorless quarantine and rejects malformed ACL state', async () => {
    const member = await addUser('member', 'Member');
    const admin = await addUser('admin', 'Admin');
    const quarantined = descriptor({ createdByUserId: null, visibility: 'owner_admin_only' });

    await expect(allowed(admin.id, quarantined, 'manage', internalPolicy, 'member'))
      .resolves.toMatchObject({ allowed: true, actorRole: 'admin' });
    await expect(allowed(member.id, quarantined, 'read')).resolves.toMatchObject({
      allowed: false,
      reason: 'quarantine_role_required',
    });
    await expect(allowed(admin.id, descriptor({ visibility: 'owner_admin_only' }), 'read'))
      .resolves.toMatchObject({ allowed: false, reason: 'invalid_quarantine_creator' });
    await expect(allowed(test.owner.id, descriptor({
      createdByUserId: null,
      visibility: 'matter_shared',
    }), 'read', internalPolicy, 'owner')).resolves.toMatchObject({
      allowed: false,
      reason: 'invalid_quarantine_creator',
    });
    await expect(allowed(test.owner.id, descriptor({
      createdByUserId: null,
      visibility: 'private',
    }), 'read', internalPolicy, 'owner')).resolves.toMatchObject({
      allowed: false,
      reason: 'invalid_quarantine_creator',
    });
    await expect(allowed(test.owner.id, descriptor({ aclVersion: 0 }), 'read'))
      .resolves.toMatchObject({ allowed: false, reason: 'invalid_acl_version' });
    await expect(allowed(test.owner.id, descriptor({ visibility: 'public' as never }), 'read'))
      .resolves.toMatchObject({ allowed: false, reason: 'invalid_visibility' });
    await expect(allowed(test.owner.id, descriptor({ tenantId: 'foreign' }), 'read'))
      .resolves.toMatchObject({ allowed: false, reason: 'tenant_mismatch' });
  });

  it('fails closed when a non-null creator is not a current User in the resource tenant', async () => {
    const malformed = descriptor({ createdByUserId: 'missing-current-user' });
    await expect(allowed(test.owner.id, malformed, 'read')).resolves.toMatchObject({
      allowed: false,
      reason: 'invalid_creator',
    });

    const evaluator = await createSensitiveAccessEvaluator(
      test.prisma,
      principal(test.owner.id, 'owner'),
      internalPolicy,
    );
    await expect(evaluator.authorizeMany([malformed], 'read')).resolves.toEqual([
      expect.objectContaining({ allowed: false, reason: 'invalid_creator' }),
    ]);
  });

  it('uses CAS for visibility changes and writes only content-free audit metadata', async () => {
    await test.prisma.note.create({ data: {
      id: 'note-core-204', tenantId: test.tenant.id, accountId, opportunityId: matterId,
      content: 'must never enter audit', createdBy: test.owner.id,
      createdByUserId: test.owner.id, visibility: 'private', aclVersion: 1,
    } });

    const changed = await setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'viewer',
      kind: 'note',
      resourceId: 'note-core-204',
      visibility: 'matter_shared',
      expectedAclVersion: 1,
      requestId: 'share-request',
    }, internalPolicy);
    expect(changed.aclVersion).toBe(2);
    await expect(setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      kind: 'note',
      resourceId: 'note-core-204',
      visibility: 'private',
      expectedAclVersion: 1,
    }, internalPolicy)).rejects.toMatchObject({ code: 'acl_version_conflict' });

    const audit = await test.prisma.auditEvent.findFirst({
      where: { tenantId: test.tenant.id, entityKind: 'note', entityId: 'note-core-204' },
    });
    expect(audit).toMatchObject({ action: 'SENSITIVE_VISIBILITY_SET', actorId: test.owner.id });
    expect(JSON.stringify(audit)).not.toContain('must never enter audit');
  });

  it('keeps a private Candidate creator-domain dedupe key immutable when it is shared', async () => {
    const person = await test.prisma.person.create({ data: {
      id: 'core-204-share-dedupe-person', tenantId: test.tenant.id, accountId,
      name: '分享候选目标', title: '负责人',
    } });
    const created = await createFieldCandidate(test.prisma, {
      id: 'core-204-share-dedupe-candidate', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'person', targetId: person.id, fieldKey: 'title',
      oldValue: '负责人', newValue: '决策人', source: 'mcp',
      sourceRef: 'mcp:core-204-share-dedupe', evidence: '分享前私有依据',
      confidence: 0.8, createdByUserId: test.owner.id,
    });
    const before = await test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } });

    await expect(setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      kind: 'candidate',
      resourceId: created.candidateId,
      visibility: 'matter_shared',
      expectedAclVersion: before.aclVersion,
    }, internalPolicy)).resolves.toEqual({ aclVersion: before.aclVersion + 1 });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({
        visibility: 'matter_shared',
        aclVersion: before.aclVersion + 1,
        dedupeKey: before.dedupeKey,
      });
  });

  it('keeps creatorless quarantine unavailable to normal visibility transitions', async () => {
    await test.prisma.note.create({ data: {
      id: 'note-core-204-quarantine', tenantId: test.tenant.id, accountId,
      opportunityId: matterId, content: 'quarantined body', createdBy: '',
      createdByUserId: null, visibility: 'owner_admin_only', aclVersion: 1,
    } });

    await expect(setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      kind: 'note',
      resourceId: 'note-core-204-quarantine',
      visibility: 'matter_shared',
      expectedAclVersion: 1,
    }, internalPolicy)).rejects.toMatchObject({ code: 'quarantine_not_shareable' });
    await expect(test.prisma.note.findUniqueOrThrow({
      where: { id: 'note-core-204-quarantine' },
      select: { createdByUserId: true, visibility: true, aclVersion: true },
    })).resolves.toEqual({
      createdByUserId: null, visibility: 'owner_admin_only', aclVersion: 1,
    });
  });

  it('fails closed on an unknown runtime resource kind instead of treating it as SourceArtifact', async () => {
    await test.prisma.sourceArtifact.create({ data: {
      id: 'source-artifact-core-204',
      tenantId: test.tenant.id,
      accountId,
      matterId,
      backingKind: 'transcript',
      backingId: 'transcript:core-204',
      createdByUserId: test.owner.id,
      visibility: 'private',
      aclVersion: 1,
    } });

    await expect(setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id,
      actorId: test.owner.id,
      actorRole: 'owner',
      kind: 'bogus' as never,
      resourceId: 'source-artifact-core-204',
      visibility: 'matter_shared',
      expectedAclVersion: 1,
    }, internalPolicy)).rejects.toMatchObject({ code: 'invalid_resource_kind' });
    await expect(test.prisma.sourceArtifact.findUniqueOrThrow({
      where: { id: 'source-artifact-core-204' },
    })).resolves.toMatchObject({ visibility: 'private', aclVersion: 1 });
  });

  it('preserves a shared Candidate ACL on creator refresh while isolating another creator proposal', async () => {
    const reviewer = await addUser('member', 'Refresh reviewer');
    const attacker = await addUser('member', 'Refresh attacker');
    const created = await createFieldCandidate(test.prisma, {
      id: 'field-refresh-original', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'opportunity', targetId: matterId, fieldKey: 'name',
      oldValue: 'Sensitive matter', newValue: 'Sensitive matter v2',
      source: 'voice', sourceRef: 'voice:field-refresh:1', evidence: 'first evidence',
      confidence: 0.7, createdByUserId: test.owner.id,
    });
    const shared = await setSensitiveResourceVisibility(test.prisma, {
      tenantId: test.tenant.id, actorId: test.owner.id, actorRole: 'owner',
      kind: 'candidate', resourceId: created.candidateId,
      visibility: 'matter_shared', expectedAclVersion: 1,
    }, internalPolicy);
    const granted = await grantCandidateReviewer(test.prisma, {
      tenantId: test.tenant.id, actorId: test.owner.id, actorRole: 'owner',
      candidateId: created.candidateId, granteeUserId: reviewer.id,
      expectedAclVersion: shared.aclVersion,
    }, internalPolicy);

    await expect(createFieldCandidate(test.prisma, {
      id: 'field-refresh-owner', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'opportunity', targetId: matterId, fieldKey: 'name',
      oldValue: 'Sensitive matter', newValue: 'Sensitive matter v3',
      source: 'voice', sourceRef: 'voice:field-refresh:2', evidence: 'second evidence',
      confidence: 0.8, createdByUserId: test.owner.id,
    })).resolves.toMatchObject({ created: false });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({
        createdByUserId: test.owner.id,
        visibility: 'matter_shared',
        aclVersion: granted.aclVersion,
      });
    await expect(test.prisma.sensitiveResourceGrant.findFirstOrThrow({
      where: { tenantId: test.tenant.id, resourceId: created.candidateId, granteeUserId: reviewer.id },
    })).resolves.toMatchObject({ resourceAclVersion: granted.aclVersion, revokedAt: null });

    const isolated = await createFieldCandidate(test.prisma, {
      id: 'field-refresh-attacker', tenantId: test.tenant.id, accountId, matterId,
      targetKind: 'opportunity', targetId: matterId, fieldKey: 'name',
      oldValue: 'Sensitive matter', newValue: 'attacker value',
      source: 'voice', sourceRef: 'voice:field-refresh:attacker', evidence: 'attacker evidence',
      confidence: 0.9, createdByUserId: attacker.id,
    });
    expect(isolated.created).toBe(true);
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: isolated.candidateId } }))
      .resolves.toMatchObject({
        createdByUserId: attacker.id,
        visibility: 'private',
        aclVersion: 1,
        evidence: 'attacker evidence',
      });
    await expect(test.prisma.candidate.findUniqueOrThrow({ where: { id: created.candidateId } }))
      .resolves.toMatchObject({
        createdByUserId: test.owner.id,
        visibility: 'matter_shared',
        aclVersion: granted.aclVersion,
        evidence: 'second evidence',
      });
  });

  it('fails closed for every compatibility review kind when Candidate authority is missing', async () => {
    const person = await test.prisma.person.create({ data: {
      id: 'missing-authority-person', tenantId: test.tenant.id, accountId,
      name: 'Compatibility target', title: 'Target',
    } });
    await test.prisma.personSuggestion.create({ data: {
      id: 'missing-authority-person-suggestion', tenantId: test.tenant.id,
      accountId, opportunityId: matterId, name: 'Candidate authority required', status: 'pending',
    } });
    await test.prisma.relSuggestion.create({ data: {
      id: 'missing-authority-relation', tenantId: test.tenant.id, opportunityId: matterId,
      sourcePersonId: person.id, targetPersonId: person.id, layer: 'L2', label: 'candidate-only',
      status: 'pending',
    } });
    await test.prisma.changeProposal.create({ data: {
      id: 'missing-authority-field', tenantId: test.tenant.id, accountId,
      opportunityId: matterId, entityKind: 'opportunity', entityId: matterId,
      field: 'name', oldValue: 'Sensitive matter', newValue: 'must remain proposed',
      status: 'pending', dedupeKey: 'missing-authority-field-key',
    } });
    await test.prisma.reminder.create({ data: {
      id: 'missing-authority-reminder', tenantId: test.tenant.id, accountId,
      accountName: 'Sensitive account', opportunityId: matterId, oppName: 'Sensitive matter',
      kind: 'stalled', title: 'Candidate authority required', detail: 'compatibility only',
      dedupeKey: 'missing-authority-reminder-key', status: 'pending',
    } });
    await test.prisma.evidenceEvent.create({ data: {
      id: 'missing-authority-evidence', tenantId: test.tenant.id, accountId,
      opportunityId: matterId, personId: person.id, signalKey: 'candidate_only',
      rawContent: 'compatibility evidence', status: 'pending_review', createdBy: test.owner.id,
    } });

    const refs = [
      { sourceKind: 'PersonSuggestion' as const, sourceId: 'missing-authority-person-suggestion' },
      { sourceKind: 'RelSuggestion' as const, sourceId: 'missing-authority-relation' },
      { sourceKind: 'ChangeProposal' as const, sourceId: 'missing-authority-field' },
      { sourceKind: 'Reminder' as const, sourceId: 'missing-authority-reminder' },
      { sourceKind: 'EvidenceEvent' as const, sourceId: 'missing-authority-evidence' },
    ];
    const review = {
      actorId: test.owner.id,
      actorRole: 'owner' as const,
      capabilityPolicy: internalPolicy,
    };
    for (const ref of refs) {
      await expect(requireCandidateReviewAccess(
        test.prisma, test.tenant.id, ref.sourceKind, ref.sourceId, review,
      )).rejects.toMatchObject({ scopedNotFound: true });
    }
    await expect(requireCandidateReviewAccessMany(
      test.prisma, test.tenant.id, refs, review,
    )).rejects.toMatchObject({ scopedNotFound: true });

    expect(await test.prisma.candidate.count({ where: { tenantId: test.tenant.id } })).toBe(0);
    await expect(test.prisma.personSuggestion.findUniqueOrThrow({
      where: { id: 'missing-authority-person-suggestion' },
    })).resolves.toMatchObject({ status: 'pending', resolvedPersonId: null });
    await expect(test.prisma.relSuggestion.findUniqueOrThrow({
      where: { id: 'missing-authority-relation' },
    })).resolves.toMatchObject({ status: 'pending' });
    await expect(test.prisma.changeProposal.findUniqueOrThrow({
      where: { id: 'missing-authority-field' },
    })).resolves.toMatchObject({ status: 'pending', newValue: 'must remain proposed' });
    await expect(test.prisma.reminder.findUniqueOrThrow({
      where: { id: 'missing-authority-reminder' },
    })).resolves.toMatchObject({ status: 'pending' });
    await expect(test.prisma.evidenceEvent.findUniqueOrThrow({
      where: { id: 'missing-authority-evidence' },
    })).resolves.toMatchObject({ status: 'pending_review' });
  });
});
