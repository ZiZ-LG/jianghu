import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestContext } from './helpers/testApp.js';
import {
  claimPersonCandidate,
  claimRelationCandidate,
  createPersonCandidate,
  createRelationCandidate,
  finalizePersonCandidate,
  finalizeRelationCandidate,
  redirectCandidatePersonReferences,
  rejectPersonCandidate,
  rejectRelationCandidate,
  updatePendingPersonCandidate,
} from '../src/candidates/personRelation.js';

async function seedCustomerTree(context: Awaited<ReturnType<typeof createTestContext>>, suffix = '') {
  const accountId = `candidate-cutover-account${suffix}`;
  const matterId = `candidate-cutover-matter${suffix}`;
  const sourcePersonId = `candidate-cutover-source${suffix}`;
  const targetPersonId = `candidate-cutover-target${suffix}`;
  await context.prisma.account.create({
    data: { id: accountId, tenantId: context.tenant.id, name: `Candidate Account ${suffix}`, customerType: 1 },
  });
  await context.prisma.opportunity.create({
    data: {
      id: matterId,
      tenantId: context.tenant.id,
      accountId,
      name: `Candidate Matter ${suffix}`,
      customerType: 1,
      pipelineStage: 'qualify',
      engageStage: 'discover',
    },
  });
  await context.prisma.person.createMany({ data: [
    { id: sourcePersonId, tenantId: context.tenant.id, accountId, name: `Source ${suffix}`, title: 'Sponsor' },
    { id: targetPersonId, tenantId: context.tenant.id, accountId, name: `Target ${suffix}`, title: 'User' },
  ] });
  return { accountId, matterId, sourcePersonId, targetPersonId };
}

describe('CORE-202 Candidate person/relation write helper', () => {
  it('atomically writes one authoritative person Candidate and one legacy projection, then replays the same tenant key', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context);
      const input = {
        id: 'ps-core202-person',
        tenantId: context.tenant.id,
        accountId: tree.accountId,
        matterId: tree.matterId,
        name: '候选关键人',
        title: '技术负责人',
        orgLevel: 2,
        source: 'mcp',
        sourceRef: 'mcp:propose-person:request-1',
        evidence: '客户公开资料显示其负责技术评审，仍待人工核实',
        confidence: 0.83,
        createdByUserId: context.owner.id,
        dedupeKey: `person-pending-v1:${tree.accountId}:候选关键人`,
        sourceUrl: 'https://source.example/person',
        suggestedRole: 'D',
        suggestedSentiment: 'plus',
      } as const;

      const first = await createPersonCandidate(context.prisma, input);
      const replay = await createPersonCandidate(context.prisma, { ...input, id: 'ps-core202-person-retry' });

      expect(first.created).toBe(true);
      expect(replay).toMatchObject({ created: false, candidateId: first.candidateId, row: { id: input.id } });
      await expect(context.prisma.personSuggestion.findMany({ where: { tenantId: context.tenant.id } }))
        .resolves.toHaveLength(1);
      const candidate = await context.prisma.candidate.findUniqueOrThrow({ where: { id: first.candidateId } });
      expect(candidate).toMatchObject({
        tenantId: context.tenant.id,
        kind: 'person_create',
        status: 'pending',
        accountId: tree.accountId,
        matterId: tree.matterId,
        targetKind: 'person',
        source: 'mcp',
        sourceRef: input.sourceRef,
        evidence: input.evidence,
        confidence: input.confidence,
        createdByUserId: context.owner.id,
        visibility: 'private',
        dedupeKey: input.dedupeKey,
        legacySourceKind: 'PersonSuggestion',
        legacySourceId: input.id,
        version: 0,
      });
      expect(JSON.parse(candidate.payload)).toEqual({
        legacyStatus: 'pending',
        name: input.name,
        orgLevel: input.orgLevel,
        resolvedPersonId: null,
        sourceUrl: input.sourceUrl,
        suggestedRole: input.suggestedRole,
        suggestedSentiment: input.suggestedSentiment,
        title: input.title,
      });
      await expect(context.prisma.person.count({ where: { tenantId: context.tenant.id, accountId: tree.accountId } }))
        .resolves.toBe(2);
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed on invalid parents, actor, evidence, confidence, and conflicting dedupe identity without partial rows', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context);
      const otherAccountId = 'candidate-cutover-other-account';
      await context.prisma.account.create({
        data: { id: otherAccountId, tenantId: context.tenant.id, name: 'Other Account', customerType: 1 },
      });
      const base = {
        id: 'ps-core202-valid',
        tenantId: context.tenant.id,
        accountId: tree.accountId,
        matterId: tree.matterId,
        name: 'Valid Candidate',
        title: '',
        orgLevel: 3,
        source: 'ai',
        sourceRef: 'enrich:job-1:valid',
        evidence: '来源摘要，待人工核实',
        confidence: 0.5,
        createdByUserId: null,
        dedupeKey: `person-pending-v1:${tree.accountId}:valid candidate`,
      } as const;

      await expect(createPersonCandidate(context.prisma, { ...base, id: 'ps-bad-parent', accountId: otherAccountId }))
        .rejects.toThrow();
      await expect(createPersonCandidate(context.prisma, { ...base, id: 'ps-bad-actor', createdByUserId: 'missing-user' }))
        .rejects.toThrow();
      await expect(createPersonCandidate(context.prisma, { ...base, id: 'ps-bad-evidence', evidence: '   ' }))
        .rejects.toThrow();
      await expect(createPersonCandidate(context.prisma, { ...base, id: 'ps-bad-confidence', confidence: 1.1 }))
        .rejects.toThrow();

      const created = await createPersonCandidate(context.prisma, base);
      await expect(createRelationCandidate(context.prisma, {
        id: 'rs-conflicting-key',
        tenantId: context.tenant.id,
        matterId: tree.matterId,
        source: { kind: 'person', id: tree.sourcePersonId },
        target: { kind: 'person', id: tree.targetPersonId },
        layer: 'L2',
        label: '同盟',
        sourceType: 'graph',
        sourceRef: 'graph:conflict',
        evidence: '共同联系人，待核实',
        confidence: 0.7,
        createdByUserId: null,
        dedupeKey: base.dedupeKey,
      })).rejects.toThrow();

      expect(created.created).toBe(true);
      await expect(context.prisma.candidate.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(1);
      await expect(context.prisma.personSuggestion.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(1);
      await expect(context.prisma.relSuggestion.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('scopes the same dedupe key by tenant and rejects archived or cross-tenant parents and endpoints', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context, '-tenant-a');
      const tenantB = await context.prisma.tenant.create({ data: {
        id: 'core-202-tenant-b', name: 'CORE-202 Tenant B',
      } });
      const userB = await context.prisma.user.create({ data: {
        id: 'core-202-user-b', tenantId: tenantB.id, email: 'core-202-b@example.test',
        passwordHash: 'unused', name: 'Tenant B Owner', role: 'owner',
      } });
      const accountB = await context.prisma.account.create({ data: {
        id: 'core-202-account-b', tenantId: tenantB.id, name: 'Tenant B Account', customerType: 2,
      } });
      const sharedKey = 'core-202-same-key-across-tenants';

      const first = await createPersonCandidate(context.prisma, {
        id: 'core-202-same-key-a', tenantId: context.tenant.id, accountId: tree.accountId,
        name: 'Tenant A Candidate', source: 'mcp', sourceRef: 'mcp:tenant-a',
        evidence: 'Tenant A evidence', confidence: 0.5, createdByUserId: context.owner.id,
        dedupeKey: sharedKey,
      });
      const second = await createPersonCandidate(context.prisma, {
        id: 'core-202-same-key-b', tenantId: tenantB.id, accountId: accountB.id,
        name: 'Tenant B Candidate', source: 'mcp', sourceRef: 'mcp:tenant-b',
        evidence: 'Tenant B evidence', confidence: 0.5, createdByUserId: userB.id,
        dedupeKey: sharedKey,
      });
      expect(first.candidateId).not.toBe(second.candidateId);
      await expect(context.prisma.candidate.count({ where: { dedupeKey: sharedKey } })).resolves.toBe(2);

      await expect(createPersonCandidate(context.prisma, {
        id: 'core-202-cross-tenant-parent', tenantId: context.tenant.id, accountId: accountB.id,
        name: 'Cross Tenant', source: 'mcp', sourceRef: 'mcp:cross-tenant',
        evidence: 'Must fail', confidence: 0.5, createdByUserId: context.owner.id,
        dedupeKey: 'core-202-cross-tenant-parent',
      })).rejects.toThrow();

      await context.prisma.account.update({ where: { id: tree.accountId }, data: { archivedAt: new Date() } });
      await expect(createPersonCandidate(context.prisma, {
        id: 'core-202-archived-account', tenantId: context.tenant.id, accountId: tree.accountId,
        name: 'Archived Account', source: 'mcp', sourceRef: 'mcp:archived-account',
        evidence: 'Must fail', confidence: 0.5, createdByUserId: context.owner.id,
        dedupeKey: 'core-202-archived-account',
      })).rejects.toThrow();
      await context.prisma.account.update({ where: { id: tree.accountId }, data: { archivedAt: null } });
      await context.prisma.opportunity.update({ where: { id: tree.matterId }, data: { archivedAt: new Date() } });
      await expect(createPersonCandidate(context.prisma, {
        id: 'core-202-archived-matter', tenantId: context.tenant.id, accountId: tree.accountId,
        matterId: tree.matterId, name: 'Archived Matter', source: 'mcp', sourceRef: 'mcp:archived-matter',
        evidence: 'Must fail', confidence: 0.5, createdByUserId: context.owner.id,
        dedupeKey: 'core-202-archived-matter',
      })).rejects.toThrow();
      await context.prisma.opportunity.update({ where: { id: tree.matterId }, data: { archivedAt: null } });
      await context.prisma.person.update({ where: { id: tree.sourcePersonId }, data: { archivedAt: new Date() } });
      await expect(createRelationCandidate(context.prisma, {
        id: 'core-202-archived-endpoint', tenantId: context.tenant.id, matterId: tree.matterId,
        source: { kind: 'person', id: tree.sourcePersonId },
        target: { kind: 'person', id: tree.targetPersonId },
        layer: 'L2', label: 'Must fail', sourceType: 'mcp', sourceRef: 'mcp:archived-endpoint',
        evidence: 'Must fail', confidence: 0.5, createdByUserId: context.owner.id,
        dedupeKey: 'core-202-archived-endpoint',
      })).rejects.toThrow();

      await expect(context.prisma.personSuggestion.count({ where: {
        tenantId: context.tenant.id,
        id: { in: ['core-202-cross-tenant-parent', 'core-202-archived-account', 'core-202-archived-matter'] },
      } })).resolves.toBe(0);
      await expect(context.prisma.relSuggestion.count({ where: { id: 'core-202-archived-endpoint' } })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('writes and replays a typed-endpoint relation Candidate without creating a formal Edge', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context);
      const personCandidate = await createPersonCandidate(context.prisma, {
        id: 'ps-core202-endpoint', tenantId: context.tenant.id, accountId: tree.accountId,
        matterId: tree.matterId, name: '候选端点', title: '', orgLevel: 3,
        source: 'voice', sourceRef: 'voice:request-2:person-0', evidence: '录音原句待核实', confidence: 0.6,
        createdByUserId: context.owner.id, dedupeKey: 'voice:request-2:person-0',
      });
      const input = {
        id: 'rs-core202-relation',
        tenantId: context.tenant.id,
        matterId: tree.matterId,
        source: { kind: 'suggestion', id: personCandidate.row.id },
        target: { kind: 'person', id: tree.targetPersonId },
        layer: 'L3',
        label: '可能影响',
        sourceType: 'voice',
        sourceRef: 'voice:request-2:relation-0',
        evidence: '原句提到候选人会影响目标人，待核实',
        confidence: 0.66,
        createdByUserId: context.owner.id,
        dedupeKey: 'voice:request-2:relation-0',
      } as const;

      const first = await createRelationCandidate(context.prisma, input);
      const replay = await createRelationCandidate(context.prisma, { ...input, id: 'rs-core202-relation-retry' });

      expect(first.created).toBe(true);
      expect(replay).toMatchObject({ created: false, candidateId: first.candidateId, row: { id: input.id } });
      const candidate = await context.prisma.candidate.findUniqueOrThrow({ where: { id: first.candidateId } });
      expect(candidate).toMatchObject({
        kind: 'relation_create', accountId: tree.accountId, matterId: tree.matterId,
        targetKind: 'relation', source: input.sourceType, sourceRef: input.sourceRef,
        evidence: input.evidence, confidence: input.confidence,
      });
      expect(JSON.parse(candidate.payload)).toEqual({
        label: input.label,
        layer: input.layer,
        legacyStatus: 'pending',
        sourceKind: 'suggestion',
        sourcePersonId: personCandidate.row.id,
        targetKind: 'person',
        targetPersonId: tree.targetPersonId,
      });
      await expect(context.prisma.relSuggestion.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(1);
      await expect(context.prisma.edge.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('lazily adopts legacy rows and keeps Candidate plus compatibility status under one CAS transaction', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context);
      await context.prisma.personSuggestion.create({ data: {
        id: 'ps-core202-legacy', tenantId: context.tenant.id, accountId: tree.accountId,
        opportunityId: tree.matterId, name: 'Legacy Candidate', title: 'Old', orgLevel: 3,
        origin: 'mcp', evidence: 'legacy evidence', confidence: 0.4, status: 'pending', proposedBy: context.owner.id,
      } });

      await expect(context.prisma.$transaction(async (tx) => {
        await claimPersonCandidate(tx, {
          tenantId: context.tenant.id, id: 'ps-core202-legacy', override: { title: 'Rolled back' },
        });
        throw new Error('fault after claim');
      })).rejects.toThrow('fault after claim');
      await expect(context.prisma.candidate.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(0);
      await expect(context.prisma.personSuggestion.findUniqueOrThrow({ where: { id: 'ps-core202-legacy' } }))
        .resolves.toMatchObject({ status: 'pending', title: 'Old' });

      const finalPersonId = 'candidate-cutover-materialized';
      const receipt = await context.prisma.$transaction(async (tx) => {
        const claim = await claimPersonCandidate(tx, {
          tenantId: context.tenant.id, id: 'ps-core202-legacy', override: { title: 'Reviewed' },
        });
        await tx.person.create({ data: {
          id: finalPersonId, tenantId: context.tenant.id, accountId: tree.accountId,
          name: 'Legacy Candidate', title: 'Reviewed',
        } });
        return finalizePersonCandidate(tx, {
          tenantId: context.tenant.id,
          id: 'ps-core202-legacy',
          expectedVersion: claim.candidateVersion,
          resolvedPersonId: finalPersonId,
        });
      });

      expect(receipt.row).toMatchObject({ status: 'accepted', title: 'Reviewed', resolvedPersonId: finalPersonId });
      const adopted = await context.prisma.candidate.findUniqueOrThrow({
        where: { tenantId_legacySourceKind_legacySourceId: {
          tenantId: context.tenant.id, legacySourceKind: 'PersonSuggestion', legacySourceId: 'ps-core202-legacy',
        } },
      });
      expect(adopted).toMatchObject({ status: 'accepted', version: 2, targetKind: 'person' });
      expect(JSON.parse(adopted.payload)).toMatchObject({
        legacyStatus: 'accepted', title: 'Reviewed', resolvedPersonId: finalPersonId,
      });
      await expect(rejectPersonCandidate(context.prisma, {
        tenantId: context.tenant.id, id: 'ps-core202-legacy',
      })).resolves.toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  it('keeps relation claim/finalize and person-reference redirects in Candidate/legacy parity', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context);
      const pendingPerson = await createPersonCandidate(context.prisma, {
        id: 'ps-core202-redirect', tenantId: context.tenant.id, accountId: tree.accountId,
        matterId: tree.matterId, name: 'Redirect Candidate', title: '', orgLevel: 3,
        source: 'mcp', sourceRef: 'mcp:redirect', evidence: '待核实人物', confidence: 0.5,
        createdByUserId: context.owner.id, dedupeKey: 'person:redirect',
      });
      const relation = await createRelationCandidate(context.prisma, {
        id: 'rs-core202-review', tenantId: context.tenant.id, matterId: tree.matterId,
        source: { kind: 'suggestion', id: pendingPerson.row.id },
        target: { kind: 'person', id: tree.targetPersonId }, layer: 'L3', label: '原关系',
        sourceType: 'mcp', sourceRef: 'mcp:relation-review', evidence: '关系依据待核实', confidence: 0.7,
        createdByUserId: context.owner.id, dedupeKey: 'relation:review',
      });

      await context.prisma.$transaction(async (tx) => {
        await redirectCandidatePersonReferences(tx, {
          tenantId: context.tenant.id, accountId: tree.accountId,
          from: { kind: 'suggestion', id: pendingPerson.row.id }, toPersonId: tree.sourcePersonId,
        });
        const claim = await claimRelationCandidate(tx, { tenantId: context.tenant.id, id: relation.row.id });
        await finalizeRelationCandidate(tx, {
          tenantId: context.tenant.id, id: relation.row.id, expectedVersion: claim.candidateVersion,
          sourcePersonId: tree.sourcePersonId, targetPersonId: tree.targetPersonId,
          layer: 'L2', label: '人工确认关系',
        });
      });

      const [legacy, candidate] = await Promise.all([
        context.prisma.relSuggestion.findUniqueOrThrow({ where: { id: relation.row.id } }),
        context.prisma.candidate.findUniqueOrThrow({ where: { id: relation.candidateId } }),
      ]);
      expect(legacy).toMatchObject({
        status: 'accepted', sourceKind: 'person', sourcePersonId: tree.sourcePersonId,
        targetKind: 'person', targetPersonId: tree.targetPersonId, layer: 'L2', label: '人工确认关系',
      });
      expect(candidate).toMatchObject({ status: 'accepted', version: 3 });
      expect(JSON.parse(candidate.payload)).toMatchObject({
        legacyStatus: 'accepted', sourceKind: 'person', sourcePersonId: tree.sourcePersonId,
        targetKind: 'person', targetPersonId: tree.targetPersonId, layer: 'L2', label: '人工确认关系',
      });
      await expect(rejectRelationCandidate(context.prisma, {
        tenantId: context.tenant.id, id: relation.row.id,
      })).resolves.toBe(false);
    } finally {
      await context.cleanup();
    }
  });

  it('updates an adopted pending person through the helper and keeps canonical payload parity', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context);
      await context.prisma.personSuggestion.create({ data: {
        id: 'ps-core202-pending-update', tenantId: context.tenant.id, accountId: tree.accountId,
        name: 'Pending Update', title: '', orgLevel: 3, origin: 'ai', evidence: 'old evidence',
        confidence: 0.3, status: 'pending', proposedBy: '',
      } });
      const updated = await updatePendingPersonCandidate(context.prisma, {
        tenantId: context.tenant.id,
        id: 'ps-core202-pending-update',
        dedupeKey: `person-pending-v1:${tree.accountId}:pending update`,
        patch: { title: 'New title', evidence: 'new evidence with source', confidence: 0.8 },
      });
      expect(updated.row).toMatchObject({ title: 'New title', evidence: 'new evidence with source', confidence: 0.8 });
      const candidate = await context.prisma.candidate.findUniqueOrThrow({ where: { id: updated.candidateId } });
      expect(candidate).toMatchObject({ status: 'pending', evidence: 'new evidence with source', confidence: 0.8, version: 1 });
      expect(JSON.parse(candidate.payload)).toMatchObject({ title: 'New title', legacyStatus: 'pending' });
    } finally {
      await context.cleanup();
    }
  });

  it('releases a terminal semantic key for a later pending observation and rejects stale relation finalization', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedCustomerTree(context, '-terminal');
      const semanticKey = `person-pending-v1:${tree.accountId}:reobserved person`;
      const first = await createPersonCandidate(context.prisma, {
        id: 'core-202-terminal-first', tenantId: context.tenant.id, accountId: tree.accountId,
        name: 'Reobserved Person', source: 'mcp', sourceRef: 'mcp:observation:first',
        evidence: 'First observation', confidence: 0.4, createdByUserId: context.owner.id,
        dedupeKey: semanticKey,
      });
      await expect(rejectPersonCandidate(context.prisma, {
        tenantId: context.tenant.id, id: first.row.id,
      })).resolves.toBe(true);
      const second = await createPersonCandidate(context.prisma, {
        id: 'core-202-terminal-second', tenantId: context.tenant.id, accountId: tree.accountId,
        name: 'Reobserved Person', source: 'mcp', sourceRef: 'mcp:observation:second',
        evidence: 'Later independent observation', confidence: 0.7, createdByUserId: context.owner.id,
        dedupeKey: semanticKey,
      });
      expect(second).toMatchObject({ created: true, row: { status: 'pending' } });
      expect(second.candidateId).not.toBe(first.candidateId);
      await expect(context.prisma.candidate.findUniqueOrThrow({ where: { id: first.candidateId } }))
        .resolves.toMatchObject({ status: 'rejected', dedupeKey: `terminal-v1:${first.candidateId}`, version: 1 });
      await expect(context.prisma.candidate.findUniqueOrThrow({ where: { id: second.candidateId } }))
        .resolves.toMatchObject({ status: 'pending', dedupeKey: semanticKey, version: 0 });

      const relation = await createRelationCandidate(context.prisma, {
        id: 'core-202-stale-relation', tenantId: context.tenant.id, matterId: tree.matterId,
        source: { kind: 'person', id: tree.sourcePersonId },
        target: { kind: 'person', id: tree.targetPersonId },
        layer: 'L3', label: 'Before review', sourceType: 'graph', sourceRef: 'graph:stale-cas',
        evidence: 'Two common contacts', confidence: 0.64, createdByUserId: null,
        dedupeKey: 'core-202-stale-relation',
      });
      const claimed = await claimRelationCandidate(context.prisma, {
        tenantId: context.tenant.id, id: relation.row.id,
      });
      await expect(finalizeRelationCandidate(context.prisma, {
        tenantId: context.tenant.id, id: relation.row.id, expectedVersion: claimed.candidateVersion - 1,
        sourcePersonId: tree.sourcePersonId, targetPersonId: tree.targetPersonId,
        layer: 'L2', label: 'Stale must fail',
      })).rejects.toThrow();
      await expect(finalizeRelationCandidate(context.prisma, {
        tenantId: context.tenant.id, id: relation.row.id, expectedVersion: claimed.candidateVersion,
        sourcePersonId: tree.sourcePersonId, targetPersonId: tree.targetPersonId,
        layer: 'L2', label: 'Human reviewed',
      })).resolves.toMatchObject({ row: { status: 'accepted', layer: 'L2', label: 'Human reviewed' } });
      await expect(finalizeRelationCandidate(context.prisma, {
        tenantId: context.tenant.id, id: relation.row.id, expectedVersion: claimed.candidateVersion,
        sourcePersonId: tree.sourcePersonId, targetPersonId: tree.targetPersonId,
        layer: 'L1', label: 'Double finalize must fail',
      })).rejects.toThrow();
      await expect(context.prisma.edge.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('allows PersonSuggestion/RelSuggestion mutations only inside the CORE-202 helper', async () => {
    const sourceRoot = resolve('src');
    const names = (await readdir(sourceRoot, { recursive: true }))
      .filter((name) => typeof name === 'string' && name.endsWith('.ts')) as string[];
    const mutation = /\.(personSuggestion|relSuggestion)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/g;
    const violations: string[] = [];
    for (const name of names) {
      if (name === 'candidates/personRelation.ts') continue;
      const text = await readFile(resolve(sourceRoot, name), 'utf8');
      if (mutation.test(text)) violations.push(name);
      mutation.lastIndex = 0;
    }
    expect(violations).toEqual([]);
  });
});
