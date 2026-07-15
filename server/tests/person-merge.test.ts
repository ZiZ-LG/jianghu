import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TestContext } from './helpers/testApp.js';
import { createTestContext } from './helpers/testApp.js';
import { executePersonMerge } from '../src/personMerge.js';
import type { CommandContext } from '@jianghu/domain-contracts';
import { assembleDeal } from '../src/pde/assemble.js';
import { handleMcpBody } from '../src/mcpServer.js';
import { resolveScopedRelSuggestions } from '../src/suggestionScope.js';

const auth = (token: string, key = 'person-merge-key-0001') => ({
  authorization: `Bearer ${token}`,
  'idempotency-key': key,
});

async function seedMergeGraph(context: TestContext, suffix: string) {
  const accountId = `acc-merge-${suffix}`;
  const targetPersonId = `person-target-${suffix}`;
  const sourcePersonId = `person-source-${suffix}`;
  const otherPersonId = `person-other-${suffix}`;
  const opportunityId = `opp-merge-${suffix}`;
  const secondOpportunityId = `opp-merge-second-${suffix}`;
  await context.prisma.account.create({ data: {
    id: accountId, tenantId: context.tenant.id, name: 'Merge account', customerType: 1,
  } });
  await context.prisma.person.createMany({ data: [
    {
      id: targetPersonId, tenantId: context.tenant.id, accountId, name: 'Target', title: 'VP',
      form: JSON.stringify({ targetOnly: 'target', conflict: 'target wins', family: '', family7: { 籍贯: '', 年纪: '50' } }),
      logs: JSON.stringify([{ id: 'same', text: 'target private log' }, { id: 'target', text: 'target unique' }]),
    },
    {
      id: sourcePersonId, tenantId: context.tenant.id, accountId, name: 'Source', title: 'Director',
      form: JSON.stringify({ sourceOnly: 'source', conflict: 'source loses', family: 'source family', family7: { 籍贯: '陕西', 子女: '独子' } }),
      logs: JSON.stringify([{ id: 'same', text: 'target private log' }, { id: 'source', text: 'source secret log' }]),
    },
    { id: otherPersonId, tenantId: context.tenant.id, accountId, name: 'Other', title: 'Manager' },
  ] });
  await context.prisma.opportunity.createMany({ data: [
    {
      id: opportunityId, tenantId: context.tenant.id, accountId, name: 'Opportunity', customerType: 1,
      pipelineStage: '线索', engageStage: '需求调研立项',
    },
    {
      id: secondOpportunityId, tenantId: context.tenant.id, accountId, name: 'Second opportunity', customerType: 1,
      pipelineStage: '线索', engageStage: '需求调研立项',
    },
  ] });
  await context.prisma.oppRole.createMany({ data: [
    { id: `role-target-${suffix}`, tenantId: context.tenant.id, opportunityId, personId: targetPersonId, role: 'D', sentiment: 'plus', confidence: '明确', isKeyInfluencer: true },
    { id: `role-source-${suffix}`, tenantId: context.tenant.id, opportunityId, personId: sourcePersonId, role: 'U', sentiment: 'minus', confidence: '推测', procurementType: '公开招标' },
    { id: `role-source-second-${suffix}`, tenantId: context.tenant.id, opportunityId: secondOpportunityId, personId: sourcePersonId, role: 'A', sentiment: 'star', confidence: '明确' },
  ] });
  await context.prisma.opportunityMember.createMany({ data: [
    { id: `member-target-${suffix}`, tenantId: context.tenant.id, opportunityId, personId: targetPersonId },
    { id: `member-source-${suffix}`, tenantId: context.tenant.id, opportunityId, personId: sourcePersonId },
    { id: `member-source-second-${suffix}`, tenantId: context.tenant.id, opportunityId: secondOpportunityId, personId: sourcePersonId },
  ] });
  await context.prisma.edge.createMany({ data: [
    { id: `edge-self-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, source: sourcePersonId, target: targetPersonId, layer: 'L1', label: 'secret self' },
    { id: `edge-duplicate-keep-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, source: targetPersonId, target: otherPersonId, layer: 'L2', label: 'same', directed: false, color: '#123' },
    { id: `edge-duplicate-drop-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, source: sourcePersonId, target: otherPersonId, layer: 'L2', label: 'same', directed: false, color: '#123' },
    { id: `edge-reverse-preserved-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, source: otherPersonId, target: sourcePersonId, layer: 'L2', label: 'same', directed: false, color: '#123' },
  ] });
  await Promise.all([
    context.prisma.burningIssue.create({ data: { id: `bi-${suffix}`, tenantId: context.tenant.id, opportunityId, personId: sourcePersonId, description: 'secret BI', category: '关系', confidence: '明确' } }),
    context.prisma.evidenceEvent.create({ data: { id: `ev-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, personId: sourcePersonId, signalKey: 'intro_referral', rawContent: 'secret evidence' } }),
    context.prisma.note.create({ data: { id: `note-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, personId: sourcePersonId, content: 'secret note' } }),
    context.prisma.planAction.create({ data: { id: `action-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, personId: sourcePersonId, title: 'secret action' } }),
    context.prisma.strategyCard.create({ data: { id: `card-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, personId: sourcePersonId, title: 'secret card' } }),
    context.prisma.transcript.create({ data: { id: `transcript-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, personId: sourcePersonId, title: 'secret transcript', contentEnc: 'encrypted-secret' } }),
    context.prisma.advisorMsg.create({ data: { id: `advisor-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, personId: sourcePersonId, role: 'user', text: 'secret advisor text' } }),
    context.prisma.relSuggestion.create({ data: { id: `rel-${suffix}`, tenantId: context.tenant.id, opportunityId, sourcePersonId, targetPersonId: otherPersonId, sourceKind: 'person', targetKind: 'person', layer: 'L3', label: 'secret relation evidence', evidence: 'secret relation body' } }),
    context.prisma.personSuggestion.create({ data: { id: `candidate-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, name: 'Candidate', status: 'accepted', resolvedPersonId: sourcePersonId, evidence: 'secret candidate evidence' } }),
    context.prisma.changeProposal.create({ data: { id: `proposal-person-${suffix}`, tenantId: context.tenant.id, accountId, entityKind: 'person', entityId: sourcePersonId, field: 'title', oldValue: 'secret old', newValue: 'secret new' } }),
    context.prisma.changeProposal.create({ data: { id: `proposal-role-${suffix}`, tenantId: context.tenant.id, accountId, opportunityId, entityKind: 'oppRole', entityId: sourcePersonId, field: 'sentiment', oldValue: 'secret old', newValue: 'secret new' } }),
    context.prisma.reminder.create({ data: { id: `reminder-source-${suffix}`, tenantId: context.tenant.id, accountId, accountName: 'Merge account', opportunityId, kind: 'sentiment_recheck', title: 'secret reminder', entityId: sourcePersonId, dedupeKey: `${opportunityId}:sentiment_recheck:${sourcePersonId}` } }),
    context.prisma.reminder.create({ data: { id: `reminder-target-${suffix}`, tenantId: context.tenant.id, accountId, accountName: 'Merge account', opportunityId, kind: 'sentiment_recheck', title: 'target reminder', entityId: targetPersonId, dedupeKey: `${opportunityId}:sentiment_recheck:${targetPersonId}` } }),
  ]);
  return { accountId, targetPersonId, sourcePersonId, otherPersonId, opportunityId, secondOpportunityId };
}

describe('INT-302 safe duplicate Person merge', () => {
  it('sanitizes unexpected endpoint failures while preserving known safe command errors', async () => {
    const module = await import('../src/personMerge.js') as unknown as {
      personMergeHttpError?: (error: unknown, fallback: string) => { statusCode: number; body: { error: string; code?: string }; unexpected: boolean };
    };
    expect(typeof module.personMergeHttpError).toBe('function');
    expect(module.personMergeHttpError!(new Error('secret SQL/table detail'), '人物合并失败')).toEqual({
      statusCode: 500, body: { error: '人物合并失败' }, unexpected: true,
    });
    expect(module.personMergeHttpError!({ statusCode: 409, code: 'idempotency_key_reused', message: 'safe conflict' }, '人物合并失败')).toEqual({
      statusCode: 409, body: { error: 'safe conflict', code: 'idempotency_key_reused' }, unexpected: false,
    });
  });

  it('migrates references and requires role decisions inside normally archived opportunities', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'archived-opportunity');
      await context.prisma.opportunity.update({ where: { id: tree.secondOpportunityId }, data: { archivedAt: new Date(), archivedBy: context.owner.id, archiveReason: 'normal archive' } });
      await context.prisma.oppRole.create({ data: {
        id: 'role-target-second-archived-opportunity', tenantId: context.tenant.id, opportunityId: tree.secondOpportunityId,
        personId: tree.targetPersonId, role: 'R', sentiment: 'neutral', confidence: '明确',
      } });
      const preview = await context.app.inject({
        method: 'GET',
        url: `/api/repair/person-merge/preview?targetPersonId=${encodeURIComponent(tree.targetPersonId)}&sourcePersonId=${encodeURIComponent(tree.sourcePersonId)}`,
        headers: auth(context.token),
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        accountId: tree.accountId,
        conflicts: expect.arrayContaining([
          expect.objectContaining({ opportunityId: tree.opportunityId, opportunityName: 'Opportunity', archived: false }),
          expect.objectContaining({ opportunityId: tree.secondOpportunityId, opportunityName: 'Second opportunity', archived: true }),
        ]),
      });
      const missing = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-archived-missing'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' } },
      });
      expect(missing.statusCode).toBe(400);
      const merged = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-archived-complete'),
        payload: {
          targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId,
          roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target', [tree.secondOpportunityId]: 'keep_source' },
        },
      });
      expect(merged.statusCode).toBe(200);
      await expect(context.prisma.oppRole.findFirstOrThrow({ where: { tenantId: context.tenant.id, opportunityId: tree.secondOpportunityId } }))
        .resolves.toMatchObject({ personId: tree.targetPersonId, role: 'A' });
    } finally { await context.cleanup(); }
  });

  it('rolls back when either Person version changes before its CAS write', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'person-cas');
      const ctx: CommandContext = {
        tenantId: context.tenant.id, actorId: context.owner.id, actorRole: 'owner', channel: 'web',
        requestId: 'person-cas-test', assertionMode: 'user_asserted',
      };
      await expect(context.prisma.$transaction((tx) => executePersonMerge(ctx, {
        targetPersonId: tree.targetPersonId,
        sourcePersonId: tree.sourcePersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' },
      }, tx, {
        beforeTargetCas: () => tx.person.update({ where: { id: tree.targetPersonId }, data: { version: { increment: 1 }, title: 'concurrent target edit' } }),
      }))).rejects.toMatchObject({ statusCode: 409 });
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.targetPersonId } })).resolves.toMatchObject({ title: 'VP', version: 0 });
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).resolves.toMatchObject({ archivedAt: null, version: 0 });
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);

      await expect(context.prisma.$transaction((tx) => executePersonMerge(ctx, {
        targetPersonId: tree.targetPersonId,
        sourcePersonId: tree.sourcePersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' },
      }, tx, {
        beforeArchiveCas: () => tx.person.update({ where: { id: tree.sourcePersonId }, data: { version: { increment: 1 }, title: 'concurrent source edit' } }),
      }))).rejects.toMatchObject({ statusCode: 409 });
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.targetPersonId } })).resolves.toMatchObject({ title: 'VP', version: 0 });
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).resolves.toMatchObject({ title: 'Director', archivedAt: null, version: 0 });
    } finally { await context.cleanup(); }
  });

  it('rolls back all redirects and audit if a failure occurs after reference writes', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'fault-rollback');
      const ctx: CommandContext = {
        tenantId: context.tenant.id, actorId: context.owner.id, actorRole: 'owner', channel: 'web',
        requestId: 'fault-rollback', assertionMode: 'user_asserted',
      };
      await expect(context.prisma.$transaction((tx) => executePersonMerge(ctx, {
        targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_source' },
      }, tx, { afterReferenceWrites: async () => { throw new Error('injected after redirects'); } }))).rejects.toThrow('injected after redirects');
      expect(await context.prisma.oppRole.count({ where: { tenantId: context.tenant.id, personId: tree.sourcePersonId } })).toBe(2);
      expect(await context.prisma.evidenceEvent.count({ where: { tenantId: context.tenant.id, personId: tree.sourcePersonId } })).toBe(1);
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).resolves.toMatchObject({ archivedAt: null });
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);
    } finally { await context.cleanup(); }
  });

  it('does not opportunistically delete pre-existing exact duplicate edges unrelated to source redirection', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'unrelated-edges');
      await context.prisma.edge.createMany({ data: [
        { id: 'edge-unrelated-a', tenantId: context.tenant.id, accountId: tree.accountId, opportunityId: tree.opportunityId, source: tree.otherPersonId, target: tree.targetPersonId, layer: 'L4', label: 'legacy duplicate' },
        { id: 'edge-unrelated-b', tenantId: context.tenant.id, accountId: tree.accountId, opportunityId: tree.opportunityId, source: tree.otherPersonId, target: tree.targetPersonId, layer: 'L4', label: 'legacy duplicate' },
      ] });
      const response = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-unrelated-edges'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' } },
      });
      expect(response.statusCode).toBe(200);
      expect(await context.prisma.edge.count({ where: { tenantId: context.tenant.id, id: { in: ['edge-unrelated-a', 'edge-unrelated-b'] } } })).toBe(2);
    } finally { await context.cleanup(); }
  });

  it('fails closed on person-backed proposal/reminder rows with missing opportunity parentage', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'missing-parentage');
      await context.prisma.changeProposal.update({ where: { id: 'proposal-role-missing-parentage' }, data: { opportunityId: null } });
      await context.prisma.reminder.update({ where: { id: 'reminder-source-missing-parentage' }, data: { opportunityId: null } });
      const response = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-missing-parentage'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' } },
      });
      expect(response.statusCode).toBe(404);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);
    } finally { await context.cleanup(); }
  });

  it('redirects personLog proposals and preserves conflicting proposal review information without duplicate pending keys', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'proposal-reconcile');
      await context.prisma.changeProposal.deleteMany({ where: { tenantId: context.tenant.id } });
      const key = (entityKind: string, entityId: string, field: string) => JSON.stringify([context.tenant.id, tree.accountId, entityKind, entityId, field]);
      await context.prisma.changeProposal.createMany({ data: [
        { id: 'cp-person-target', tenantId: context.tenant.id, accountId: tree.accountId, entityKind: 'person', entityId: tree.targetPersonId, field: 'title', oldValue: 'target old', newValue: 'target proposal', dedupeKey: key('person', tree.targetPersonId, 'title') },
        { id: 'cp-person-source', tenantId: context.tenant.id, accountId: tree.accountId, entityKind: 'person', entityId: tree.sourcePersonId, field: 'title', oldValue: 'source old', newValue: 'source proposal', dedupeKey: key('person', tree.sourcePersonId, 'title') },
        { id: 'cp-log-source', tenantId: context.tenant.id, accountId: tree.accountId, entityKind: 'personLog', entityId: tree.sourcePersonId, field: 'append', oldValue: '', newValue: '{"content":"review me"}', dedupeKey: key('personLog', tree.sourcePersonId, 'append') },
        { id: 'cp-role-target', tenantId: context.tenant.id, accountId: tree.accountId, opportunityId: tree.opportunityId, entityKind: 'oppRole', entityId: tree.targetPersonId, field: 'sentiment', oldValue: 'plus', newValue: 'neutral', dedupeKey: key('oppRole', tree.targetPersonId, 'sentiment') },
        { id: 'cp-role-source', tenantId: context.tenant.id, accountId: tree.accountId, opportunityId: tree.opportunityId, entityKind: 'oppRole', entityId: tree.sourcePersonId, field: 'sentiment', oldValue: 'minus', newValue: 'star', dedupeKey: key('oppRole', tree.sourcePersonId, 'sentiment') },
      ] });
      const response = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-proposal-reconcile'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: { [tree.opportunityId]: 'keep_source' } },
      });
      expect(response.statusCode).toBe(200);
      const proposals = await context.prisma.changeProposal.findMany({ where: { tenantId: context.tenant.id }, orderBy: { id: 'asc' } });
      expect(proposals.every((proposal) => proposal.entityId === tree.targetPersonId)).toBe(true);
      expect(proposals.find((proposal) => proposal.id === 'cp-person-target')).toMatchObject({ status: 'pending', dedupeKey: key('person', tree.targetPersonId, 'title'), newValue: 'target proposal' });
      expect(proposals.find((proposal) => proposal.id === 'cp-person-source')).toMatchObject({ status: 'pending', dedupeKey: null, newValue: 'source proposal' });
      expect(proposals.find((proposal) => proposal.id === 'cp-log-source')).toMatchObject({ status: 'pending', dedupeKey: key('personLog', tree.targetPersonId, 'append') });
      expect(proposals.find((proposal) => proposal.id === 'cp-role-source')).toMatchObject({ status: 'pending', dedupeKey: key('oppRole', tree.targetPersonId, 'sentiment'), newValue: 'star' });
      expect(proposals.find((proposal) => proposal.id === 'cp-role-target')).toMatchObject({ status: 'rejected', dedupeKey: null, newValue: 'neutral' });
    } finally { await context.cleanup(); }
  });

  it('merges FORM/logs, redirects every Person reference, resolves role conflicts, cleans edges, archives and audits once', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'success');
      await context.prisma.oppRole.updateMany({
        where: { tenantId: context.tenant.id, opportunityId: tree.secondOpportunityId, personId: tree.sourcePersonId },
        data: { role: 'D' },
      });
      await context.prisma.opportunity.update({
        where: { id: tree.secondOpportunityId }, data: { primaryDPersonId: tree.sourcePersonId },
      });
      const payload = {
        targetPersonId: tree.targetPersonId,
        sourcePersonId: tree.sourcePersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_source' },
      };
      const first = await context.app.inject({ method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token), payload });
      expect(first.statusCode).toBe(200);
      const replay = await context.app.inject({ method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token), payload });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());

      const target = await context.prisma.person.findUniqueOrThrow({ where: { id: tree.targetPersonId } });
      expect(JSON.parse(target.form)).toEqual({
        targetOnly: 'target', conflict: 'target wins', sourceOnly: 'source', family: 'source family',
        family7: { 籍贯: '陕西', 年纪: '50', 子女: '独子' },
      });
      expect(JSON.parse(target.logs)).toEqual([
        { id: 'same', text: 'target private log' },
        { id: 'target', text: 'target unique' },
        { id: 'source', text: 'source secret log' },
      ]);
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).resolves.toMatchObject({
        archivedBy: context.owner.id,
        archiveReason: 'merged_duplicate',
        mergedIntoPersonId: tree.targetPersonId,
      });

      await expect(context.prisma.oppRole.findMany({ where: { tenantId: context.tenant.id }, orderBy: { opportunityId: 'asc' } })).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ opportunityId: tree.opportunityId, personId: tree.targetPersonId, role: 'U', sentiment: 'minus', procurementType: '公开招标' }),
        expect.objectContaining({ opportunityId: tree.secondOpportunityId, personId: tree.targetPersonId, role: 'D' }),
      ]));
      await expect(context.prisma.opportunity.findUniqueOrThrow({ where: { id: tree.secondOpportunityId } }))
        .resolves.toMatchObject({ primaryDPersonId: tree.targetPersonId });
      expect(await context.prisma.oppRole.count({ where: { tenantId: context.tenant.id, personId: tree.sourcePersonId } })).toBe(0);
      expect(await context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id, personId: tree.sourcePersonId } })).toBe(0);
      expect(await context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id, personId: tree.targetPersonId } })).toBe(2);

      const edges = await context.prisma.edge.findMany({ where: { tenantId: context.tenant.id }, orderBy: { id: 'asc' } });
      expect(edges).toHaveLength(2);
      expect(edges).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `edge-duplicate-keep-success`, source: tree.targetPersonId, target: tree.otherPersonId }),
        expect.objectContaining({ id: `edge-reverse-preserved-success`, source: tree.otherPersonId, target: tree.targetPersonId }),
      ]));

      for (const [model, field] of [
        [context.prisma.burningIssue, 'personId'], [context.prisma.evidenceEvent, 'personId'], [context.prisma.note, 'personId'],
        [context.prisma.planAction, 'personId'], [context.prisma.strategyCard, 'personId'], [context.prisma.transcript, 'personId'],
        [context.prisma.advisorMsg, 'personId'], [context.prisma.personSuggestion, 'resolvedPersonId'],
      ] as const) {
        const rows = await (model as any).findMany({ where: { tenantId: context.tenant.id } });
        expect(rows).toEqual([expect.objectContaining({ [field]: tree.targetPersonId })]);
      }
      await expect(context.prisma.relSuggestion.findFirstOrThrow({ where: { tenantId: context.tenant.id } })).resolves.toMatchObject({ sourcePersonId: tree.targetPersonId });
      await expect(context.prisma.changeProposal.findMany({ where: { tenantId: context.tenant.id } })).resolves.toEqual([
        expect.objectContaining({ entityId: tree.targetPersonId }), expect.objectContaining({ entityId: tree.targetPersonId }),
      ]);
      await expect(context.prisma.reminder.findMany({ where: { tenantId: context.tenant.id } })).resolves.toEqual([
        expect.objectContaining({ id: 'reminder-target-success', entityId: tree.targetPersonId, dedupeKey: `${tree.opportunityId}:sentiment_recheck:${tree.targetPersonId}` }),
      ]);

      const audits = await context.prisma.auditEvent.findMany({ where: { tenantId: context.tenant.id, action: 'person_merge' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ entityKind: 'person', entityId: tree.targetPersonId, sourceRef: tree.sourcePersonId });
      const auditJson = JSON.stringify(audits[0]);
      for (const secret of ['private log', 'secret BI', 'secret evidence', 'secret note', 'secret transcript', 'secret advisor', 'secret reminder']) {
        expect(auditJson).not.toContain(secret);
      }
      expect(JSON.parse((audits[0] as typeof audits[0] & { metadata: string }).metadata)).toMatchObject({
        sourcePersonId: tree.sourcePersonId,
        targetPersonId: tree.targetPersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_source' },
      });

      const state = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(context.token) });
      expect(state.statusCode).toBe(200);
      const stateAccount = state.json<{ accounts: Array<{ id: string; persons: Array<{ id: string }> }> }>()
        .accounts.find((item) => item.id === tree.accountId);
      expect(stateAccount?.persons.map((person) => person.id)).toEqual(expect.arrayContaining([tree.targetPersonId, tree.otherPersonId]));
      expect(stateAccount?.persons.map((person) => person.id)).not.toContain(tree.sourcePersonId);
      const archivedWrite = await context.app.inject({
        method: 'POST', url: '/api/mutate', headers: auth(context.token),
        payload: { action: { type: 'UPDATE_PERSON', accId: tree.accountId, personId: tree.sourcePersonId, patch: { title: 'must not revive' }, baseVersion: 0 } },
      });
      expect(archivedWrite.statusCode).toBe(404);
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).resolves.not.toMatchObject({ title: 'must not revive' });

      await context.prisma.oppRole.create({ data: {
        id: 'archived-source-pde-role', tenantId: context.tenant.id, opportunityId: tree.secondOpportunityId,
        personId: tree.sourcePersonId, role: 'U', sentiment: 'plus', confidence: '明确',
      } });
      const pde = await assembleDeal(context.tenant.id, tree.secondOpportunityId, {
        scoringSchema: { items: [] }, signalCatalog: { deltaAlphaMap: {} },
      }, 'test-pack', context.prisma);
      expect(pde?.deal.stakeholders.map((stakeholder) => stakeholder.id)).not.toContain(tree.sourcePersonId);

      const mcp = await handleMcpBody({
        tenantId: context.tenant.id, actorId: context.owner.id, actorRole: 'owner', channel: 'mcp',
        requestId: 'merge-mcp-read', assertionMode: 'machine_proposed',
      }, { jsonrpc: '2.0', id: 302, method: 'tools/call', params: { name: 'get_account_detail', arguments: { accountId: tree.accountId } } });
      expect(JSON.stringify(mcp)).not.toContain(tree.sourcePersonId);

      const archivedCandidate = await context.prisma.relSuggestion.create({ data: {
        id: 'archived-source-candidate', tenantId: context.tenant.id, opportunityId: tree.secondOpportunityId,
        sourcePersonId: tree.sourcePersonId, targetPersonId: tree.otherPersonId, sourceKind: 'person', targetKind: 'person',
        layer: 'L1', label: 'historical malformed archived endpoint',
      } });
      await expect(resolveScopedRelSuggestions(context.prisma, context.tenant.id, [archivedCandidate])).resolves.toEqual([]);

      for (const request of [
        { method: 'GET', url: `/api/advisor/messages?opportunityId=${tree.secondOpportunityId}&personId=${tree.sourcePersonId}` },
        { method: 'POST', url: '/api/advisor/messages', payload: { opportunityId: tree.secondOpportunityId, personId: tree.sourcePersonId, entries: [{ role: 'user', text: 'must not recreate archived ref' }] } },
        { method: 'DELETE', url: `/api/advisor/messages?opportunityId=${tree.secondOpportunityId}&personId=${tree.sourcePersonId}` },
      ] as const) {
        const response = await context.app.inject({ ...request, headers: auth(context.token) });
        expect(response.statusCode).toBe(404);
      }
    } finally { await context.cleanup(); }
  });

  it('fails closed before writes for missing role decisions and idempotency-key payload reuse', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'validation');
      const missingDecision = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-validation'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: {} },
      });
      expect(missingDecision.statusCode).toBe(400);
      expect(await context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).toMatchObject({ name: 'Source' });
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);

      const accepted = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-payload-reuse'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' } },
      });
      expect(accepted.statusCode).toBe(200);
      const conflict = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-payload-reuse'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.otherPersonId, roleConflictByOpportunity: {} },
      });
      expect(conflict.statusCode).toBe(409);
    } finally { await context.cleanup(); }
  });

  it('serializes concurrent merge attempts so only one archive/audit can commit', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'concurrent');
      const payload = {
        targetPersonId: tree.targetPersonId,
        sourcePersonId: tree.sourcePersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' },
      };
      const responses = await Promise.all([
        context.app.inject({ method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-concurrent-a'), payload }),
        context.app.inject({ method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-concurrent-b'), payload }),
      ]);
      expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(1);
      expect(responses.filter((response) => response.statusCode !== 200)).toHaveLength(1);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(1);
      expect(await context.prisma.oppRole.count({ where: { tenantId: context.tenant.id, personId: tree.sourcePersonId } })).toBe(0);
      expect(await context.prisma.opportunityMember.count({ where: { tenantId: context.tenant.id, personId: tree.sourcePersonId } })).toBe(0);
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).resolves.toMatchObject({ mergedIntoPersonId: tree.targetPersonId });
    } finally { await context.cleanup(); }
  });

  it('denies viewers and rejects cross-account/cross-tenant source identities without partial writes', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'scope');
      const otherAccount = await context.prisma.account.create({ data: { id: 'acc-other-scope', tenantId: context.tenant.id, name: 'Other account', customerType: 2 } });
      const crossAccount = await context.prisma.person.create({ data: { id: 'person-cross-account', tenantId: context.tenant.id, accountId: otherAccount.id, name: 'Cross', title: '' } });
      const denied = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-cross-account'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: crossAccount.id, roleConflictByOpportunity: {} },
      });
      expect(denied.statusCode).toBe(404);

      for (const request of [
        { method: 'GET', url: `/api/advisor/messages?opportunityId=${tree.opportunityId}&personId=${crossAccount.id}` },
        { method: 'POST', url: '/api/advisor/messages', payload: { opportunityId: tree.opportunityId, personId: crossAccount.id, entries: [{ role: 'user', text: 'cross account' }] } },
        { method: 'DELETE', url: `/api/advisor/messages?opportunityId=${tree.opportunityId}&personId=${crossAccount.id}` },
      ] as const) {
        const response = await context.app.inject({ ...request, headers: auth(context.token) });
        expect(response.statusCode).toBe(404);
      }

      await context.prisma.edge.create({ data: {
        id: 'edge-malformed-source-parent', tenantId: context.tenant.id, accountId: otherAccount.id,
        source: tree.sourcePersonId, target: crossAccount.id, layer: 'L1', label: 'malformed source parent',
      } });
      const malformedReference = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-malformed-edge'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' } },
      });
      expect(malformedReference.statusCode).toBe(404);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);

      const foreignTenant = await context.prisma.tenant.create({ data: { id: 'tenant-foreign-merge', name: 'Foreign merge tenant' } });
      const foreignAccount = await context.prisma.account.create({ data: { id: 'acc-foreign-merge', tenantId: foreignTenant.id, name: 'Foreign', customerType: 1 } });
      const foreignPerson = await context.prisma.person.create({ data: { id: 'person-foreign-merge', tenantId: foreignTenant.id, accountId: foreignAccount.id, name: 'Foreign', title: '' } });
      const crossTenant = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-cross-tenant'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: foreignPerson.id, roleConflictByOpportunity: {} },
      });
      expect(crossTenant.statusCode).toBe(404);

      const viewer = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id, email: `viewer-${randomUUID()}@example.test`, passwordHash: 'not-used', name: 'Viewer', role: 'viewer',
      } });
      const viewerToken = context.app.jwt.sign({ userId: viewer.id, tenantId: context.tenant.id, role: viewer.role });
      const viewerResponse = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(viewerToken, 'person-merge-viewer'),
        payload: { targetPersonId: tree.targetPersonId, sourcePersonId: tree.sourcePersonId, roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' } },
      });
      expect(viewerResponse.statusCode).toBe(403);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);
      expect(await context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } })).toMatchObject({ name: 'Source' });
    } finally { await context.cleanup(); }
  });

  it('fails closed before writes when a source Edge has a missing, cross-account, or archived endpoint', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'malformed-endpoint-parent');
      const otherAccount = await context.prisma.account.create({ data: {
        id: 'acc-other-endpoint-parent', tenantId: context.tenant.id, name: 'Other endpoint account', customerType: 2,
      } });
      const crossAccountPerson = await context.prisma.person.create({ data: {
        id: 'person-cross-endpoint-parent', tenantId: context.tenant.id, accountId: otherAccount.id, name: 'Cross endpoint', title: '',
      } });
      await context.prisma.edge.create({ data: {
        id: 'edge-cross-endpoint-parent', tenantId: context.tenant.id, accountId: tree.accountId,
        opportunityId: tree.opportunityId, source: tree.sourcePersonId, target: crossAccountPerson.id,
        layer: 'L1', label: 'correct row parent but wrong endpoint parent',
      } });

      const payload = {
        targetPersonId: tree.targetPersonId,
        sourcePersonId: tree.sourcePersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' },
      };
      const malformedEdge = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-cross-endpoint-edge'), payload,
      });
      expect(malformedEdge.statusCode).toBe(404);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);

      await context.prisma.edge.delete({ where: { id: 'edge-cross-endpoint-parent' } });
      await context.prisma.edge.create({ data: {
        id: 'edge-missing-endpoint-parent', tenantId: context.tenant.id, accountId: tree.accountId,
        opportunityId: tree.opportunityId, source: tree.sourcePersonId, target: 'person-missing-endpoint-parent',
        layer: 'L1', label: 'missing endpoint parent',
      } });
      const missingEdge = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-missing-endpoint-edge'), payload,
      });
      expect(missingEdge.statusCode).toBe(404);
      await context.prisma.edge.delete({ where: { id: 'edge-missing-endpoint-parent' } });

      await context.prisma.person.update({ where: { id: tree.otherPersonId }, data: { archivedAt: new Date() } });
      const archivedEdge = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-archived-endpoint-edge'), payload,
      });
      expect(archivedEdge.statusCode).toBe(404);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } }))
        .resolves.toMatchObject({ archivedAt: null, mergedIntoPersonId: null });
    } finally { await context.cleanup(); }
  });

  it('fails closed before writes when a source RelSuggestion has a malformed formal or candidate endpoint', async () => {
    const context = await createTestContext();
    try {
      const tree = await seedMergeGraph(context, 'malformed-rel-endpoint-parent');
      const otherAccount = await context.prisma.account.create({ data: {
        id: 'acc-other-rel-endpoint-parent', tenantId: context.tenant.id, name: 'Other rel endpoint account', customerType: 2,
      } });
      const payload = {
        targetPersonId: tree.targetPersonId,
        sourcePersonId: tree.sourcePersonId,
        roleConflictByOpportunity: { [tree.opportunityId]: 'keep_target' },
      };
      const crossAccountSuggestion = await context.prisma.personSuggestion.create({ data: {
        id: 'suggestion-cross-rel-endpoint-parent', tenantId: context.tenant.id, accountId: otherAccount.id,
        opportunityId: tree.opportunityId, name: 'Cross candidate endpoint',
      } });
      await context.prisma.relSuggestion.create({ data: {
        id: 'rel-cross-endpoint-parent', tenantId: context.tenant.id, opportunityId: tree.opportunityId,
        sourceKind: 'person', sourcePersonId: tree.sourcePersonId,
        targetKind: 'suggestion', targetPersonId: crossAccountSuggestion.id,
        layer: 'L2', label: 'correct opportunity but wrong candidate endpoint parent',
      } });
      const malformedSuggestion = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-cross-endpoint-suggestion'), payload,
      });
      expect(malformedSuggestion.statusCode).toBe(404);
      await context.prisma.relSuggestion.delete({ where: { id: 'rel-cross-endpoint-parent' } });

      await context.prisma.relSuggestion.create({ data: {
        id: 'rel-missing-endpoint-parent', tenantId: context.tenant.id, opportunityId: tree.opportunityId,
        sourceKind: 'person', sourcePersonId: tree.sourcePersonId,
        targetKind: 'suggestion', targetPersonId: 'suggestion-missing-endpoint-parent',
        layer: 'L2', label: 'missing candidate endpoint parent',
      } });
      const missingSuggestion = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-missing-endpoint-suggestion'), payload,
      });
      expect(missingSuggestion.statusCode).toBe(404);
      await context.prisma.relSuggestion.delete({ where: { id: 'rel-missing-endpoint-parent' } });

      const archivedPerson = await context.prisma.person.create({ data: {
        id: 'person-archived-rel-endpoint-parent', tenantId: context.tenant.id, accountId: tree.accountId,
        name: 'Archived formal endpoint', title: '', archivedAt: new Date(),
      } });
      await context.prisma.relSuggestion.create({ data: {
        id: 'rel-archived-endpoint-parent', tenantId: context.tenant.id, opportunityId: tree.opportunityId,
        sourceKind: 'person', sourcePersonId: tree.sourcePersonId,
        targetKind: 'person', targetPersonId: archivedPerson.id,
        layer: 'L2', label: 'archived formal endpoint parent',
      } });
      const archivedSuggestion = await context.app.inject({
        method: 'POST', url: '/api/repair/person-merge', headers: auth(context.token, 'person-merge-archived-endpoint-suggestion'), payload,
      });
      expect(archivedSuggestion.statusCode).toBe(404);
      expect(await context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id, action: 'person_merge' } })).toBe(0);
      await expect(context.prisma.person.findUniqueOrThrow({ where: { id: tree.sourcePersonId } }))
        .resolves.toMatchObject({ archivedAt: null, mergedIntoPersonId: null });
    } finally { await context.cleanup(); }
  });
});
