import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityPolicy, ResearchBriefPreparedPayload } from '@jianghu/domain-contracts';
import {
  commitResearchBriefSnapshot,
  researchBriefCrmFactFingerprint,
  researchBriefCuratedSummaryFingerprint,
} from '../src/researchBriefs/service.js';
import {
  referenceFingerprint,
  sourceArtifactIdempotencyDomain,
} from '../src/sourceArtifacts/model.js';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';

const salesPolicy: CapabilityPolicy = { entitlements: ['sales.workspace'], permissions: [] };
const generatedAt = new Date('2026-08-27T01:00:00.000Z');

describe('SAAS-204 creator-private research brief routes', () => {
  let test: TestContext | null = null;
  afterEach(async () => test?.cleanup());

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function setup(productAccess?: unknown) {
    test = await createTestContext(productAccess === undefined ? {} : { productAccess });
    await test.prisma.account.create({ data: {
      id: 'customer-204', tenantId: test.tenant.id, name: '江湖科技', version: 7,
      primaryOwnerUserId: test.owner.id, unifiedCreditCode: '91110108MA00JIANGHU',
    } });
    await test.prisma.opportunity.create({ data: {
      id: 'matter-204', tenantId: test.tenant.id, accountId: 'customer-204',
      name: '江湖数字化项目', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
      version: 3, primaryOwnerUserId: test.owner.id,
    } });
  }

  function payload(content = '授权后可见的加密简报正文。'): ResearchBriefPreparedPayload {
    const refId = 'customer-204@7';
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
        id: 'source-crm', kind: 'crm_fact', refId, version: 7,
        fingerprint: researchBriefCrmFactFingerprint({ kind: 'customer', id: 'customer-204', version: 7 }),
        provider: 'jianghu-crm', label: '客户基本信息', url: null,
        subjectAnchor: 'crm_customer:customer-204', observedAt: '2026-08-26T08:00:00.000Z',
        retrievedAt: '2026-08-27T00:00:00.000Z', freshUntil: '2026-08-28T00:00:00.000Z',
        status: 'fresh', failureCode: null,
      }],
      sections: [{
        key: 'company_overview', title: '公司概览', content,
        sourceIds: ['source-crm'], asOf: '2026-08-27T00:00:00.000Z',
      }],
      unknowns: [], failures: [],
      generator: { version: 'saas-204.v1', modelRef: 'tenant-byo-ai', connectorRefs: ['crm'] },
    };
  }

  async function commit(options: {
    key?: string;
    at?: Date;
    prepared?: ResearchBriefPreparedPayload;
    matterId?: string | null;
  } = {}) {
    return commitResearchBriefSnapshot(test!.prisma, {
      tenantId: test!.tenant.id, actorId: test!.owner.id, actorRole: 'owner',
      customerId: 'customer-204', matterId: options.matterId === undefined ? 'matter-204' : options.matterId,
      generationKey: options.key ?? `route-${randomUUID()}`,
      generatedAt: options.at ?? generatedAt,
      payload: options.prepared ?? payload(),
    }, salesPolicy);
  }

  async function sourceArtifact() {
    const id = `src_${randomUUID().replaceAll('-', '')}`;
    const externalRef = `external-${id}`;
    const idempotencyDomain = sourceArtifactIdempotencyDomain(test!.owner.id);
    return test!.prisma.sourceArtifact.create({ data: {
      id, tenantId: test!.tenant.id, accountId: 'customer-204', matterId: 'matter-204',
      personId: null, backingKind: 'external_reference', backingId: id,
      artifactKind: 'external_reference', source: 'saas-204-route-test', externalRef,
      idempotencyDomain, title: '会前材料', occurredAt: new Date('2026-08-26T10:00:00.000Z'),
      fingerprintKind: 'reference_sha256_v1',
      sourceFingerprint: referenceFingerprint({ idempotencyDomain, source: 'saas-204-route-test', externalRef }),
      retentionState: 'reference_only', createdByUserId: test!.owner.id,
      visibility: 'private', aclVersion: 1,
    } });
  }

  function addArtifact(prepared: ResearchBriefPreparedPayload, source: Awaited<ReturnType<typeof sourceArtifact>>) {
    prepared.sources.push({
      id: 'source-artifact', kind: 'source_artifact', refId: source.id,
      version: source.aclVersion, fingerprint: source.sourceFingerprint,
      provider: 'jianghu-source-artifact', label: '会前材料', url: null,
      subjectAnchor: 'crm_customer:customer-204', observedAt: '2026-08-26T10:00:00.000Z',
      retrievedAt: '2026-08-27T00:10:00.000Z', freshUntil: '2026-08-28T00:10:00.000Z',
      status: 'fresh', failureCode: null,
    });
    prepared.sections[0]!.sourceIds.push('source-artifact');
    return prepared;
  }

  it('requires authentication and hides cross-tenant and non-creator IDs with one shape', async () => {
    await setup();
    const result = await commit();
    const unauthenticated = await test!.app.inject({ method: 'GET', url: `/api/research-briefs/${result.id}` });
    expect(unauthenticated.statusCode).toBe(401);

    const other = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `other-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'Other', role: 'member',
    } });
    const otherToken = test!.app.jwt.sign({ userId: other.id, tenantId: test!.tenant.id, role: 'member' });
    const nonCreator = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(otherToken),
    });
    const missing = await test!.app.inject({
      method: 'GET', url: '/api/research-briefs/missing-brief', headers: auth(otherToken),
    });
    expect(nonCreator.statusCode).toBe(404);
    expect(nonCreator.body).toBe(missing.body);

    await test!.prisma.tenant.create({ data: { id: 'other-tenant', name: 'Other tenant' } });
    await test!.prisma.researchBriefSnapshot.create({ data: {
      id: 'cross-tenant-brief', tenantId: 'other-tenant', customerId: 'other-customer',
      matterId: null, createdByUserId: test!.owner.id, generationKey: 'g'.repeat(64),
      status: 'partial', subjectStatus: 'matched', payloadEnc: 'opaque',
      payloadFingerprint: 'a'.repeat(64), sourceSetHash: 'b'.repeat(64),
      sourceCount: 0, sectionCount: 0, unknownCount: 0, failureCount: 0,
      version: 1, generatedAt, createdAt: new Date('2026-08-27T01:00:01.000Z'),
    } });
    const crossTenant = await test!.app.inject({
      method: 'GET', url: '/api/research-briefs/cross-tenant-brief', headers: auth(test!.token),
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.body).toBe(missing.body);

    const list = await test!.app.inject({
      method: 'GET', url: '/api/research-briefs?customerId=customer-204', headers: auth(otherToken),
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ items: [], nextCursor: null });
    await expect(test!.prisma.agentRun.count()).resolves.toBe(0);
  });

  it('allows a downgraded viewer creator only while current Customer ownership remains', async () => {
    await setup();
    const result = await commit();
    await test!.prisma.user.update({ where: { id: test!.owner.id }, data: { role: 'viewer' } });
    const visible = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
    });
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.json().item.payload.sections[0].content).toContain('加密简报正文');

    const newOwner = await test!.prisma.user.create({ data: {
      tenantId: test!.tenant.id, email: `new-owner-${randomUUID()}@example.test`,
      passwordHash: 'unused', name: 'New owner', role: 'member',
    } });
    await test!.prisma.account.update({
      where: { id: 'customer-204' }, data: { primaryOwnerUserId: newOwner.id },
    });
    const hidden = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
    });
    expect(hidden.statusCode).toBe(404);
  });

  it('rejects archived or mismatched parents and revoked sales capability', async () => {
    await setup();
    const result = await commit();
    await test!.prisma.opportunity.update({ where: { id: 'matter-204' }, data: { archivedAt: new Date() } });
    const archived = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
    });
    expect(archived.statusCode).toBe(404);

    await test!.prisma.account.create({ data: {
      id: 'customer-other', tenantId: test!.tenant.id, name: 'Other customer',
      primaryOwnerUserId: test!.owner.id,
    } });
    await test!.prisma.opportunity.update({
      where: { id: 'matter-204' }, data: { archivedAt: null, accountId: 'customer-other' },
    });
    const parentMismatch = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
    });
    expect(parentMismatch.statusCode).toBe(404);

    await test!.cleanup();
    test = null;
    await setup({ edition: 'commercial' });
    const revoked = await commit();
    const response = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${revoked.id}`, headers: auth(test!.token),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'capability_denied' });
  });

  it('lists metadata without decrypting, paginates deterministically, and validates bounds', async () => {
    await setup();
    const first = await commit({ key: 'route-page-first', at: new Date('2026-08-27T01:00:00.000Z') });
    const second = await commit({ key: 'route-page-second', at: new Date('2026-08-27T02:00:00.000Z') });
    await test!.prisma.researchBriefSnapshot.update({ where: { id: first.id }, data: { payloadEnc: 'corrupt' } });

    const pageOne = await test!.app.inject({
      method: 'GET', url: '/api/research-briefs?customerId=customer-204&limit=1', headers: auth(test!.token),
    });
    expect(pageOne.statusCode, pageOne.body).toBe(200);
    expect(pageOne.json().items).toHaveLength(1);
    expect(pageOne.json().items[0].id).toBe(second.id);
    expect(pageOne.json().items[0]).not.toHaveProperty('payload');
    expect(pageOne.json().items[0]).not.toHaveProperty('payloadEnc');
    expect(pageOne.json().nextCursor).toEqual(expect.any(String));

    const pageTwo = await test!.app.inject({
      method: 'GET',
      url: `/api/research-briefs?customerId=customer-204&limit=1&cursor=${encodeURIComponent(pageOne.json().nextCursor)}`,
      headers: auth(test!.token),
    });
    expect(pageTwo.statusCode, pageTwo.body).toBe(200);
    expect(pageTwo.json().items.map((item: { id: string }) => item.id)).toEqual([first.id]);
    expect(pageTwo.json().nextCursor).toBeNull();

    for (const url of [
      '/api/research-briefs?customerId=customer-204&limit=51',
      '/api/research-briefs?customerId=customer-204&cursor=not-a-cursor',
    ]) {
      const invalid = await test!.app.inject({ method: 'GET', url, headers: auth(test!.token) });
      expect(invalid.statusCode).toBe(400);
    }
  });

  it('returns no ciphertext or hashes and marks changed formal or curated sources stale', async () => {
    await setup();
    const result = await commit();
    await test!.prisma.account.update({ where: { id: 'customer-204' }, data: { version: 8 } });
    const response = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
    });
    expect(response.statusCode, response.body).toBe(200);
    const item = response.json().item;
    expect(item.status).toBe('partial');
    expect(item.payload.sources[0].status).toBe('stale');
    expect(item.payload.sections[0].content).toContain('加密简报正文');
    expect(response.body).not.toContain('payloadEnc');
    expect(response.body).not.toContain('payloadFingerprint');
    expect(response.body).not.toContain('sourceSetHash');

    await test!.prisma.account.update({ where: { id: 'customer-204' }, data: { version: 7 } });
    const curatedAt = new Date('2026-08-27T00:20:00.000Z');
    const curated = await test!.prisma.curatedSummary.create({ data: {
      id: 'route-curated-human', tenantId: test!.tenant.id, entityKind: 'account', entityId: 'customer-204',
      content: '人工确认的历史背景。', editedByHuman: true, editedBy: test!.owner.id,
      aclVersion: 0, createdAt: curatedAt, updatedAt: curatedAt,
    } });
    const withCurated = payload('这段由人工摘要支持，应在来源变更后保留。');
    withCurated.sources.push({
      id: 'source-curated', kind: 'curated_human', refId: curated.id, version: curated.aclVersion,
      fingerprint: researchBriefCuratedSummaryFingerprint(curated), provider: 'jianghu-curated',
      label: '人工摘要', url: null, subjectAnchor: 'crm_customer:customer-204',
      observedAt: curatedAt.toISOString(), retrievedAt: curatedAt.toISOString(),
      freshUntil: '2026-08-28T00:00:00.000Z', status: 'fresh', failureCode: null,
    });
    withCurated.sections[0]!.sourceIds.push('source-curated');
    const curatedBrief = await commit({ key: 'route-curated-stale', prepared: withCurated });
    await test!.prisma.curatedSummary.update({
      where: { id: curated.id }, data: { content: '后来人工修改的内容。' },
    });
    const curatedResponse = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${curatedBrief.id}`, headers: auth(test!.token),
    });
    expect(curatedResponse.statusCode, curatedResponse.body).toBe(200);
    expect(curatedResponse.json().item.payload.sources.find(
      (entry: { id: string }) => entry.id === 'source-curated',
    )).toMatchObject({ status: 'stale' });
    expect(curatedResponse.json().item.payload.sections[0].content).toContain('应在来源变更后保留');
  });

  it('redacts dependent content and emits bounded unknown/failure markers after source ACL or retention drift', async () => {
    await setup();
    const source = await sourceArtifact();
    const prepared = addArtifact(payload('这段依赖已被删除的敏感来源。'), source);
    const result = await commit({ prepared });
    await test!.prisma.sourceArtifact.update({
      where: { id: source.id }, data: { retentionState: 'deleted' },
    });
    const response = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
    });
    expect(response.statusCode, response.body).toBe(200);
    const item = response.json().item;
    expect(item.status).toBe('partial');
    expect(item.payload.sections).toEqual([]);
    const unavailable = item.payload.sources.find((entry: { status: string }) => entry.status === 'unavailable');
    expect(unavailable).toMatchObject({
      id: expect.stringMatching(/^unavailable_/),
      refId: expect.stringMatching(/^unavailable_/),
      provider: 'jianghu-redacted',
      label: '来源当前不可用',
      status: 'unavailable',
      failureCode: 'source_unavailable',
    });
    expect(response.body).not.toContain(source.id);
    expect(item.payload.unknowns).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'source_unavailable' }),
    ]));
    expect(item.payload.failures).toEqual(expect.arrayContaining([
      { sourceId: unavailable.id, code: 'source_unavailable', retryable: false },
    ]));
    expect(response.body).not.toContain('这段依赖已被删除的敏感来源。');

    for (const data of [
      { retentionState: 'reference_only', aclVersion: 2 },
      { retentionState: 'reference_only', aclVersion: 1, sourceFingerprint: 'f'.repeat(64) },
    ]) {
      await test!.prisma.sourceArtifact.update({ where: { id: source.id }, data });
      const drifted = await test!.app.inject({
        method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
      });
      expect(drifted.statusCode, drifted.body).toBe(200);
      expect(drifted.json().item.payload.sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'unavailable', failureCode: 'source_unavailable' }),
      ]));
      expect(drifted.body).not.toContain(source.id);
      expect(drifted.body).not.toContain('这段依赖已被删除的敏感来源。');
    }
  });

  it('reserves bounded revocation markers and removes source-dependent unknown text at the limit', async () => {
    await setup();
    const source = await sourceArtifact();
    const prepared = addArtifact(payload('该段落依赖稍后撤权的来源。'), source);
    prepared.unknowns = Array.from({ length: 20 }, (_, index) => ({
      key: `existing_unknown_${index}`,
      question: index === 0 ? '敏感来源原文摘要不应继续可见。' : `既有待核问题 ${index}`,
      reasonCode: `existing_unknown_${index}`,
      sourceIds: [index === 0 ? 'source-artifact' : 'source-crm'],
    }));
    prepared.failures = Array.from({ length: 20 }, (_, index) => ({
      sourceId: index === 0 ? 'source-artifact' : 'source-crm',
      code: `existing_failure_${index}`,
      retryable: true,
    }));
    const result = await commit({ key: 'route-bounded-revocation', prepared });
    await test!.prisma.sourceArtifact.update({
      where: { id: source.id }, data: { retentionState: 'deleted' },
    });

    const response = await test!.app.inject({
      method: 'GET', url: `/api/research-briefs/${result.id}`, headers: auth(test!.token),
    });
    expect(response.statusCode, response.body).toBe(200);
    const item = response.json().item;
    const unavailable = item.payload.sources.find((entry: { status: string }) => entry.status === 'unavailable');
    expect(item.payload.unknowns).toHaveLength(20);
    expect(item.payload.failures).toHaveLength(20);
    expect(item.payload.unknowns).toEqual(expect.arrayContaining([
      expect.objectContaining({ reasonCode: 'source_unavailable', sourceIds: [unavailable.id] }),
    ]));
    expect(item.payload.failures).toEqual(expect.arrayContaining([
      { sourceId: unavailable.id, code: 'source_unavailable', retryable: false },
    ]));
    expect(response.body).not.toContain('敏感来源原文摘要不应继续可见');
    expect(response.body).not.toContain(source.id);
  });

  it('exposes no creation, refresh, selection, or sharing mutation route', async () => {
    await setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await test!.app.inject({
        method, url: '/api/research-briefs', headers: auth(test!.token), payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
