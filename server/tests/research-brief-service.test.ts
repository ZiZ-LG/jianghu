import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityPolicy, ResearchBriefPreparedPayload } from '@jianghu/domain-contracts';
import { dec } from '../src/ai.js';
import {
  commitResearchBriefSnapshot,
  ResearchBriefError,
  researchBriefCrmFactFingerprint,
  researchBriefCuratedSummaryFingerprint,
} from '../src/researchBriefs/service.js';
import {
  referenceFingerprint,
  sourceArtifactIdempotencyDomain,
} from '../src/sourceArtifacts/model.js';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

const generatedAt = new Date('2026-08-27T01:00:00.000Z');
const policy: CapabilityPolicy = { entitlements: ['sales.workspace'], permissions: [] };

describe('SAAS-204 encrypted research brief commit service', () => {
  let test: TestContext | null = null;
  afterEach(async () => test?.cleanup());

  async function setup() {
    test = await createTestContext();
    const customer = await test.prisma.account.create({ data: {
      id: 'customer-204', tenantId: test.tenant.id, name: '江湖科技', version: 7,
      primaryOwnerUserId: test.owner.id, unifiedCreditCode: '91110108MA00JIANGHU',
    } });
    const matter = await test.prisma.opportunity.create({ data: {
      id: 'matter-204', tenantId: test.tenant.id, accountId: customer.id,
      name: '江湖数字化项目', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      version: 3, primaryOwnerUserId: test.owner.id,
    } });
    return { customer, matter };
  }

  function crmPayload(customerVersion = 7): ResearchBriefPreparedPayload {
    const refId = `customer-204@${customerVersion}`;
    return {
      subject: {
        status: 'matched', query: '江湖科技', crmCustomerId: 'customer-204',
        selected: {
          legalName: '江湖科技有限公司', anchorKind: 'unified_credit_code',
          anchorValue: '91110108MA00JIANGHU', provider: 'qcc',
        },
        candidates: [],
      },
      sources: [{
        id: 'source-crm', kind: 'crm_fact', refId, version: customerVersion,
        fingerprint: researchBriefCrmFactFingerprint({ kind: 'customer', id: 'customer-204', version: customerVersion }),
        provider: 'jianghu-crm', label: '客户基本信息', url: null,
        subjectAnchor: 'crm_customer:customer-204',
        observedAt: '2026-08-26T08:00:00.000Z', retrievedAt: '2026-08-27T00:00:00.000Z',
        freshUntil: '2026-08-28T00:00:00.000Z', status: 'fresh', failureCode: null,
      }],
      sections: [{
        key: 'company_overview', title: '公司概览', content: '仅存在于加密负载的客户简报正文。',
        sourceIds: ['source-crm'], asOf: '2026-08-27T00:00:00.000Z',
      }],
      unknowns: [], failures: [],
      generator: { version: 'saas-204.v1', modelRef: 'tenant-byo-ai', connectorRefs: ['crm'] },
    };
  }

  function input(payload = crmPayload(), generationKey = `brief-${randomUUID()}`) {
    return {
      tenantId: test!.tenant.id,
      actorId: test!.owner.id,
      actorRole: 'owner' as const,
      customerId: 'customer-204',
      matterId: 'matter-204',
      generationKey,
      generatedAt,
      payload,
    };
  }

  async function createExternalSource(options: {
    id?: string;
    createdByUserId?: string;
    matterId?: string | null;
  } = {}) {
    const id = options.id ?? `src_${randomUUID().replaceAll('-', '')}`;
    const creator = options.createdByUserId ?? test!.owner.id;
    const externalRef = `external-${id}`;
    return test!.prisma.sourceArtifact.create({ data: {
      id, tenantId: test!.tenant.id, accountId: 'customer-204',
      matterId: options.matterId === undefined ? 'matter-204' : options.matterId,
      personId: null, backingKind: 'external_reference', backingId: id,
      artifactKind: 'external_reference', source: 'saas-204-test', externalRef,
      idempotencyDomain: sourceArtifactIdempotencyDomain(creator), title: '受控外部来源',
      occurredAt: new Date('2026-08-26T10:00:00.000Z'), fingerprintKind: 'reference_sha256_v1',
      sourceFingerprint: referenceFingerprint({
        idempotencyDomain: sourceArtifactIdempotencyDomain(creator), source: 'saas-204-test', externalRef,
      }),
      retentionState: 'reference_only', createdByUserId: creator, visibility: 'private', aclVersion: 1,
    } });
  }

  function withSourceArtifact(payload: ResearchBriefPreparedPayload, source: Awaited<ReturnType<typeof createExternalSource>>) {
    return {
      ...payload,
      sources: [...payload.sources, {
        id: 'source-artifact', kind: 'source_artifact' as const, refId: source.id,
        version: source.aclVersion, fingerprint: source.sourceFingerprint,
        provider: 'jianghu-source-artifact', label: '受控外部来源', url: null,
        subjectAnchor: 'crm_customer:customer-204', observedAt: '2026-08-26T10:00:00.000Z',
        retrievedAt: '2026-08-27T00:10:00.000Z', freshUntil: '2026-08-28T00:10:00.000Z',
        status: 'fresh' as const, failureCode: null,
      }],
      sections: payload.sections.map((section) => ({
        ...section, sourceIds: [...section.sourceIds, 'source-artifact'],
      })),
    };
  }

  it('reloads the current role and denies a downgraded viewer before any side effect', async () => {
    await setup();
    await test!.prisma.user.update({ where: { id: test!.owner.id }, data: { role: 'viewer' } });

    await expect(commitResearchBriefSnapshot(test!.prisma, input(), policy))
      .rejects.toMatchObject({ code: 'viewer_write_denied', statusCode: 403 });
    await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(0);
    await expect(test!.prisma.auditEvent.count()).resolves.toBe(0);
  });

  it('fails closed on capability, tenant, parent, archive, scope, and version drift', async () => {
    await setup();
    const noSales: CapabilityPolicy = { entitlements: ['crm.core'], permissions: [] };
    await expect(commitResearchBriefSnapshot(test!.prisma, input(), noSales))
      .rejects.toMatchObject({ code: 'capability_denied', statusCode: 403 });

    await expect(commitResearchBriefSnapshot(test!.prisma, {
      ...input(), tenantId: 'other-tenant',
    }, policy)).rejects.toMatchObject({ scopedNotFound: true });
    await expect(commitResearchBriefSnapshot(test!.prisma, {
      ...input(), matterId: 'missing-matter',
    }, policy)).rejects.toMatchObject({ scopedNotFound: true });

    await test!.prisma.opportunity.update({ where: { id: 'matter-204' }, data: { archivedAt: new Date() } });
    await expect(commitResearchBriefSnapshot(test!.prisma, input(), policy))
      .rejects.toMatchObject({ scopedNotFound: true });
    await test!.prisma.opportunity.update({ where: { id: 'matter-204' }, data: { archivedAt: null } });

    await expect(commitResearchBriefSnapshot(test!.prisma, input(crmPayload(6)), policy))
      .rejects.toMatchObject({ code: 'research_brief_source_version_conflict', statusCode: 409 });
    await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(0);
  });

  it('requires current SourceArtifact mount, creator ACL, retention, version, and fingerprint', async () => {
    await setup();
    const source = await createExternalSource();
    await expect(commitResearchBriefSnapshot(
      test!.prisma, input(withSourceArtifact(crmPayload(), source)), policy,
    )).resolves.toMatchObject({ version: 1, replayed: false });

    await test!.prisma.sourceArtifact.update({ where: { id: source.id }, data: { aclVersion: 2 } });
    await expect(commitResearchBriefSnapshot(
      test!.prisma, input(withSourceArtifact(crmPayload(), source)), policy,
    )).rejects.toMatchObject({ code: 'research_brief_source_version_conflict', statusCode: 409 });

    await test!.prisma.sourceArtifact.update({
      where: { id: source.id }, data: { aclVersion: 1, retentionState: 'deleted' },
    });
    await expect(commitResearchBriefSnapshot(
      test!.prisma, input(withSourceArtifact(crmPayload(), source)), policy,
    )).rejects.toMatchObject({ scopedNotFound: true });

    const other = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `other-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Other', role: 'member',
    } });
    const privateOther = await createExternalSource({ createdByUserId: other.id });
    await expect(commitResearchBriefSnapshot(
      test!.prisma, input(withSourceArtifact(crmPayload(), privateOther)), policy,
    )).rejects.toMatchObject({ scopedNotFound: true });

    const otherMatter = await test!.prisma.opportunity.create({ data: {
      id: 'matter-other', tenantId: test!.tenant.id, accountId: 'customer-204', name: '其他事项',
      customerType: 1, pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: test!.owner.id,
    } });
    const wrongMount = await createExternalSource({ matterId: otherMatter.id });
    await expect(commitResearchBriefSnapshot(
      test!.prisma, input(withSourceArtifact(crmPayload(), wrongMount)), policy,
    )).rejects.toMatchObject({ scopedNotFound: true });
  });

  it('accepts attributable human summaries and labeled ACL-safe legacy AI cache only', async () => {
    await setup();
    const curatedAt = new Date('2026-08-27T00:20:00.000Z');
    const human = await test!.prisma.curatedSummary.create({ data: {
      id: 'curated-human', tenantId: test!.tenant.id, entityKind: 'account', entityId: 'customer-204',
      content: '人工确认的客户背景。', editedByHuman: true, editedBy: test!.owner.id, aclVersion: 0,
      createdAt: curatedAt, updatedAt: curatedAt,
    } });
    const ai = await test!.prisma.curatedSummary.create({ data: {
      id: 'curated-ai', tenantId: test!.tenant.id, entityKind: 'opportunity', entityId: 'matter-204',
      content: '旧 AI 缓存，待核。', model: 'legacy-model', editedByHuman: false, aclVersion: 1,
      createdAt: curatedAt, updatedAt: curatedAt,
    } });
    const payload = crmPayload();
    payload.sources.push(
      {
        id: 'source-human', kind: 'curated_human', refId: human.id, version: human.aclVersion,
        fingerprint: researchBriefCuratedSummaryFingerprint(human), provider: 'jianghu-curated',
        label: '人工整理摘要', url: null, subjectAnchor: 'crm_customer:customer-204',
        observedAt: human.updatedAt.toISOString(), retrievedAt: human.updatedAt.toISOString(),
        freshUntil: '2026-08-28T00:00:00.000Z', status: 'fresh', failureCode: null,
      },
      {
        id: 'source-ai-cache', kind: 'curated_ai_cache', refId: ai.id, version: ai.aclVersion,
        fingerprint: researchBriefCuratedSummaryFingerprint(ai), provider: 'jianghu-curated',
        label: '旧 AI 缓存·待核', url: null, subjectAnchor: 'crm_customer:customer-204',
        observedAt: ai.updatedAt.toISOString(), retrievedAt: ai.updatedAt.toISOString(),
        freshUntil: '2026-08-28T00:00:00.000Z', status: 'fresh', failureCode: null,
      },
    );
    payload.sections[0]!.sourceIds.push('source-human', 'source-ai-cache');
    await expect(commitResearchBriefSnapshot(test!.prisma, input(payload), policy))
      .resolves.toMatchObject({ replayed: false });

    const mislabeled = crmPayload();
    mislabeled.sources.push({
      id: 'source-human', kind: 'curated_ai_cache', refId: human.id, version: human.aclVersion,
      fingerprint: researchBriefCuratedSummaryFingerprint(human), provider: 'jianghu-curated',
      label: '错误标签', url: null, subjectAnchor: 'crm_customer:customer-204',
      observedAt: human.updatedAt.toISOString(), retrievedAt: human.updatedAt.toISOString(),
      freshUntil: '2026-08-28T00:00:00.000Z', status: 'fresh', failureCode: null,
    });
    mislabeled.sections[0]!.sourceIds.push('source-human');
    await expect(commitResearchBriefSnapshot(test!.prisma, input(mislabeled), policy))
      .rejects.toMatchObject({ code: 'research_brief_source_kind_conflict', statusCode: 409 });
  });

  it('replays the same key, conflicts on changed content, and deduplicates concurrent commits', async () => {
    await setup();
    const key = 'stable-research-brief-key';
    const first = await commitResearchBriefSnapshot(test!.prisma, input(crmPayload(), key), policy);
    const second = await commitResearchBriefSnapshot(test!.prisma, input(crmPayload(), key), policy);
    expect(first).toMatchObject({ replayed: false, version: 1 });
    expect(second).toEqual({ ...first, replayed: true });

    const changed = crmPayload();
    changed.sections[0] = { ...changed.sections[0]!, content: '同一 key 的不同正文。' };
    await expect(commitResearchBriefSnapshot(test!.prisma, input(changed, key), policy))
      .rejects.toMatchObject({ code: 'research_brief_idempotency_conflict', statusCode: 409 });

    await test!.prisma.researchBriefSnapshot.update({
      where: { id: first.id }, data: { payloadEnc: 'corrupt-ciphertext' },
    });
    await expect(commitResearchBriefSnapshot(test!.prisma, input(crmPayload(), key), policy))
      .rejects.toMatchObject({ code: 'research_brief_idempotency_conflict', statusCode: 409 });

    const concurrentKey = 'concurrent-research-brief-key';
    const concurrent = await Promise.all([
      commitResearchBriefSnapshot(test!.prisma, input(crmPayload(), concurrentKey), policy),
      commitResearchBriefSnapshot(test!.prisma, input(crmPayload(), concurrentKey), policy),
    ]);
    expect(concurrent.map((item) => item.replayed).sort()).toEqual([false, true]);
    await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(2);
    await expect(test!.prisma.auditEvent.count({ where: { action: 'research_brief_snapshot_created' } }))
      .resolves.toBe(2);
  });

  it('encrypts the only payload, writes body-free audit metadata, and changes no formal state', async () => {
    await setup();
    const before = await Promise.all([
      test!.prisma.account.findMany(), test!.prisma.opportunity.findMany(),
      test!.prisma.person.findMany(), test!.prisma.edge.findMany(),
      test!.prisma.evidenceEvent.findMany(), test!.prisma.planAction.findMany(),
      test!.prisma.interaction.findMany(), test!.prisma.candidate.findMany(),
      test!.prisma.reviewBatch.findMany(), test!.prisma.curatedSummary.findMany(),
      test!.prisma.agentRun.findMany(), test!.prisma.commandRun.findMany(),
    ]);
    const result = await commitResearchBriefSnapshot(test!.prisma, input(), policy);
    const after = await Promise.all([
      test!.prisma.account.findMany(), test!.prisma.opportunity.findMany(),
      test!.prisma.person.findMany(), test!.prisma.edge.findMany(),
      test!.prisma.evidenceEvent.findMany(), test!.prisma.planAction.findMany(),
      test!.prisma.interaction.findMany(), test!.prisma.candidate.findMany(),
      test!.prisma.reviewBatch.findMany(), test!.prisma.curatedSummary.findMany(),
      test!.prisma.agentRun.findMany(), test!.prisma.commandRun.findMany(),
    ]);
    expect(after).toEqual(before);

    const row = await test!.prisma.researchBriefSnapshot.findUniqueOrThrow({ where: { id: result.id } });
    const audit = await test!.prisma.auditEvent.findFirstOrThrow({
      where: { tenantId: test!.tenant.id, action: 'research_brief_snapshot_created', entityId: result.id },
    });
    const plaintext = '仅存在于加密负载的客户简报正文。';
    expect(row.payloadEnc).not.toContain(plaintext);
    expect(dec(row.payloadEnc)).toContain(plaintext);
    expect(JSON.stringify({ ...row, payloadEnc: '[ciphertext]', audit })).not.toContain(plaintext);
    expect(audit.changedFields).toBe('[]');
    expect(JSON.parse(audit.metadata)).toEqual(expect.objectContaining({
      version: 1,
      payloadFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceSetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceCount: 1,
      sectionCount: 1,
    }));
  });

  it('rolls the snapshot back when its audit receipt cannot be inserted', async () => {
    await setup();
    await test!.prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_research_brief_audit
      BEFORE INSERT ON AuditEvent
      WHEN NEW.action = 'research_brief_snapshot_created'
      BEGIN SELECT RAISE(ABORT, 'injected research brief audit failure'); END;
    `);
    try {
      await expect(commitResearchBriefSnapshot(test!.prisma, input(), policy)).rejects.toThrow();
      await expect(test!.prisma.researchBriefSnapshot.count()).resolves.toBe(0);
      await expect(test!.prisma.auditEvent.count({
        where: { action: 'research_brief_snapshot_created' },
      })).resolves.toBe(0);
    } finally {
      await test!.prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_research_brief_audit');
    }
  });

  it('uses a typed service error without exposing source identifiers as not-found details', () => {
    const error = new ResearchBriefError('research_brief_not_found', 404, true);
    expect(error).toMatchObject({ scopedNotFound: true, statusCode: 404 });
    expect(error.message).toBe('research_brief_not_found');
  });
});
