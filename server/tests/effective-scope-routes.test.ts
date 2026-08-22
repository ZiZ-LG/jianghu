import { randomUUID } from 'node:crypto';
import type { CommandContext } from '@jianghu/domain-contracts';
import { describe, expect, it } from 'vitest';
import { buildServerAiContext } from '../src/ai.js';
import { handleMcpBody } from '../src/mcpServer.js';
import { computePde } from '../src/pde/routes.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function addMember(context: TestContext, label: string) {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id,
    email: `${label}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name: label,
    role: 'member',
  } });
  const token = context.app.jwt.sign({
    userId: user.id,
    tenantId: context.tenant.id,
    role: 'member',
  });
  return { user, token };
}

function mcpContext(context: TestContext, actorId: string): CommandContext {
  return {
    tenantId: context.tenant.id,
    actorId,
    actorRole: 'member',
    channel: 'mcp',
    requestId: `scope-routes-${randomUUID()}`,
    assertionMode: 'machine_proposed',
  };
}

async function callTool(ctx: CommandContext, id: number, name: string, args: Record<string, unknown> = {}) {
  return handleMcpBody(ctx, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  }) as Promise<any>;
}

function toolResult(response: any): any {
  return response?.result;
}

function toolJson<T>(response: any): T {
  const text = toolResult(response)?.content?.[0]?.text;
  return JSON.parse(text) as T;
}

async function stateIds(context: TestContext, token: string) {
  const response = await context.app.inject({ method: 'GET', url: '/api/state', headers: auth(token) });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<any>();
  return {
    accountIds: body.accounts.map((account: any) => account.id).sort(),
    matterIds: body.accounts.flatMap((account: any) => account.opportunities.map((matter: any) => matter.id)).sort(),
  };
}

async function expectStatus(context: TestContext, token: string, input: {
  method?: 'GET' | 'POST';
  url: string;
  payload?: unknown;
}, status: number): Promise<any> {
  const response: any = await context.app.inject({
    method: input.method ?? 'GET',
    url: input.url,
    headers: auth(token),
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  } as any);
  expect(response.statusCode, response.body).toBe(status);
  return response;
}

describe('CORE-109 effective scope parity across read surfaces', () => {
  it('uses one current-state Customer/Matter set across HTTP, MCP and analytical reads', async () => {
    const context = await createTestContext();
    try {
      const actor = await addMember(context, 'Scoped actor');
      const other = await addMember(context, 'Other owner');
      const tenantId = context.tenant.id;
      const fullAccountId = 'scope-routes-full-account';
      const partialAccountId = 'scope-routes-partial-account';
      const fullMatterId = 'scope-routes-full-matter';
      const directMatterId = 'scope-routes-direct-matter';
      const hiddenMatterId = 'scope-routes-hidden-matter';
      const fullPersonId = 'scope-routes-full-person';
      const fullSecondPersonId = 'scope-routes-full-second-person';
      const directPersonId = 'scope-routes-direct-person';
      const hiddenPersonId = 'scope-routes-hidden-person';

      await context.prisma.tenant.update({
        where: { id: tenantId },
        data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.account.createMany({ data: [
        {
          id: fullAccountId,
          tenantId,
          name: 'FULL_ACCOUNT_VISIBLE',
          customerType: 1,
          primaryOwnerUserId: actor.user.id,
          externalRef: 'FULL_ACCOUNT_REF',
        },
        {
          id: partialAccountId,
          tenantId,
          name: 'PARTIAL_ACCOUNT_HEADER',
          customerType: 2,
          primaryOwnerUserId: other.user.id,
          externalRef: 'PARTIAL_ACCOUNT_SECRET_REF',
        },
      ] });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: fullMatterId,
          tenantId,
          accountId: fullAccountId,
          name: 'FULL_MATTER_VISIBLE',
          customerType: 1,
          pipelineStage: '线索',
          engageStage: '需求调研立项',
          primaryOwnerUserId: other.user.id,
        },
        {
          id: directMatterId,
          tenantId,
          accountId: partialAccountId,
          name: 'DIRECT_MATTER_VISIBLE',
          customerType: 2,
          pipelineStage: '线索',
          engageStage: '需求调研立项',
          primaryOwnerUserId: actor.user.id,
        },
        {
          id: hiddenMatterId,
          tenantId,
          accountId: partialAccountId,
          name: 'HIDDEN_MATTER_SECRET',
          customerType: 2,
          pipelineStage: '线索',
          engageStage: '需求调研立项',
          primaryOwnerUserId: other.user.id,
        },
      ] });
      await context.prisma.pdeDecisionContext.createMany({ data: [
        { id: 'scope-routes-pde-full', tenantId, opportunityId: fullMatterId, stageKey: 'initiation', source: 'legacy_shadow' },
        { id: 'scope-routes-pde-direct', tenantId, opportunityId: directMatterId, stageKey: 'initiation', source: 'legacy_shadow' },
        { id: 'scope-routes-pde-hidden', tenantId, opportunityId: hiddenMatterId, stageKey: 'initiation', source: 'legacy_shadow' },
      ] });
      await context.prisma.person.createMany({ data: [
        { id: fullPersonId, tenantId, accountId: fullAccountId, name: 'FULL_PERSON_VISIBLE', title: 'Full' },
        { id: fullSecondPersonId, tenantId, accountId: fullAccountId, name: 'FULL_SECOND_PERSON_VISIBLE', title: 'Full second' },
        { id: directPersonId, tenantId, accountId: partialAccountId, name: 'DIRECT_PERSON_VISIBLE', title: 'Direct' },
        {
          id: hiddenPersonId,
          tenantId,
          accountId: partialAccountId,
          name: 'HIDDEN_PERSON_SECRET',
          title: 'Hidden',
          form: JSON.stringify({ family7: { family: 'HIDDEN_FORM_SECRET' } }),
        },
      ] });
      await context.prisma.oppRole.createMany({ data: [
        { id: 'scope-routes-full-role', tenantId, opportunityId: fullMatterId, personId: fullPersonId, role: 'D', sentiment: 'plus', confidence: '明确' },
        { id: 'scope-routes-direct-role', tenantId, opportunityId: directMatterId, personId: directPersonId, role: 'D', sentiment: 'plus', confidence: '明确' },
        { id: 'scope-routes-hidden-role', tenantId, opportunityId: hiddenMatterId, personId: hiddenPersonId, role: 'D', sentiment: 'minus', confidence: '明确' },
      ] });
      await context.prisma.curatedSummary.createMany({ data: [
        { id: 'scope-routes-curated-full-account', tenantId, entityKind: 'account', entityId: fullAccountId, content: 'CURATED_FULL_ACCOUNT', editedByHuman: true },
        { id: 'scope-routes-curated-partial-account', tenantId, entityKind: 'account', entityId: partialAccountId, content: 'CURATED_PARTIAL_ACCOUNT_SECRET', editedByHuman: true },
        { id: 'scope-routes-curated-direct', tenantId, entityKind: 'opportunity', entityId: directMatterId, content: 'CURATED_DIRECT_MATTER', editedByHuman: true },
        { id: 'scope-routes-curated-hidden', tenantId, entityKind: 'opportunity', entityId: hiddenMatterId, content: 'CURATED_HIDDEN_MATTER_SECRET', editedByHuman: true },
      ] });
      await context.prisma.aiConfig.create({ data: { tenantId, provider: 'mock' } });
      await context.prisma.advisorMsg.createMany({ data: [
        { id: 'scope-routes-advisor-full', tenantId, accountId: fullAccountId, opportunityId: fullMatterId, personId: fullPersonId, role: 'assistant', text: 'ADVISOR_FULL_VISIBLE' },
        { id: 'scope-routes-advisor-direct', tenantId, accountId: partialAccountId, opportunityId: directMatterId, personId: directPersonId, role: 'assistant', text: 'ADVISOR_DIRECT_VISIBLE' },
        { id: 'scope-routes-advisor-hidden', tenantId, accountId: partialAccountId, opportunityId: hiddenMatterId, personId: hiddenPersonId, role: 'assistant', text: 'ADVISOR_HIDDEN_SECRET' },
      ] });
      await context.prisma.personSuggestion.createMany({ data: [
        { id: 'scope-routes-person-suggestion-full', tenantId, accountId: fullAccountId, name: 'PENDING_FULL_PERSON_VISIBLE' },
        { id: 'scope-routes-person-suggestion-partial', tenantId, accountId: partialAccountId, opportunityId: directMatterId, name: 'PENDING_PARTIAL_PERSON_SECRET' },
      ] });
      await context.prisma.relSuggestion.createMany({ data: [
        { id: 'scope-routes-rel-direct', tenantId, opportunityId: directMatterId, sourcePersonId: directPersonId, targetPersonId: directPersonId, layer: 'L3', label: 'PENDING_DIRECT_REL_VISIBLE' },
        { id: 'scope-routes-rel-hidden', tenantId, opportunityId: hiddenMatterId, sourcePersonId: hiddenPersonId, targetPersonId: hiddenPersonId, layer: 'L3', label: 'PENDING_HIDDEN_REL_SECRET' },
      ] });
      await context.prisma.changeProposal.createMany({ data: [
        { id: 'scope-routes-proposal-full', tenantId, accountId: fullAccountId, entityKind: 'account', entityId: fullAccountId, field: 'name', newValue: 'PROPOSAL_FULL_VISIBLE' },
        { id: 'scope-routes-proposal-direct', tenantId, accountId: partialAccountId, opportunityId: directMatterId, entityKind: 'opportunity', entityId: directMatterId, field: 'name', newValue: 'PROPOSAL_DIRECT_VISIBLE' },
        { id: 'scope-routes-proposal-hidden', tenantId, accountId: partialAccountId, opportunityId: hiddenMatterId, entityKind: 'opportunity', entityId: hiddenMatterId, field: 'name', newValue: 'PROPOSAL_HIDDEN_SECRET' },
        { id: 'scope-routes-proposal-partial', tenantId, accountId: partialAccountId, entityKind: 'account', entityId: partialAccountId, field: 'name', newValue: 'PROPOSAL_PARTIAL_ACCOUNT_SECRET' },
      ] });
      await context.prisma.reminder.createMany({ data: [
        { id: 'scope-routes-reminder-full', tenantId, accountId: fullAccountId, accountName: 'FULL_ACCOUNT_VISIBLE', kind: 'stalled', title: 'REMINDER_FULL_VISIBLE', dedupeKey: 'scope-routes-reminder-full' },
        { id: 'scope-routes-reminder-direct', tenantId, accountId: partialAccountId, accountName: 'PARTIAL_ACCOUNT_HEADER', opportunityId: directMatterId, oppName: 'DIRECT_MATTER_VISIBLE', kind: 'stalled', title: 'REMINDER_DIRECT_VISIBLE', dedupeKey: 'scope-routes-reminder-direct' },
        { id: 'scope-routes-reminder-hidden', tenantId, accountId: partialAccountId, accountName: 'PARTIAL_ACCOUNT_HEADER', opportunityId: hiddenMatterId, oppName: 'HIDDEN_MATTER_SECRET', kind: 'stalled', title: 'REMINDER_HIDDEN_SECRET', dedupeKey: 'scope-routes-reminder-hidden' },
        { id: 'scope-routes-reminder-partial', tenantId, accountId: partialAccountId, accountName: 'PARTIAL_ACCOUNT_HEADER', kind: 'stalled', title: 'REMINDER_PARTIAL_ACCOUNT_SECRET', dedupeKey: 'scope-routes-reminder-partial' },
      ] });
      await context.prisma.evidenceEvent.createMany({ data: [
        { id: 'scope-routes-evidence-direct', tenantId, accountId: partialAccountId, opportunityId: directMatterId, personId: directPersonId, signalKey: 'scope-direct', rawContent: 'EVIDENCE_DIRECT_VISIBLE', status: 'pending_review' },
        { id: 'scope-routes-evidence-hidden', tenantId, accountId: partialAccountId, opportunityId: hiddenMatterId, personId: hiddenPersonId, signalKey: 'scope-hidden', rawContent: 'EVIDENCE_HIDDEN_SECRET', status: 'pending_review' },
      ] });
      await context.prisma.transcript.createMany({ data: [
        { id: 'scope-routes-transcript-full', tenantId, accountId: fullAccountId, title: 'TRANSCRIPT_FULL_VISIBLE', contentEnc: 'cipher' },
        { id: 'scope-routes-transcript-direct', tenantId, accountId: partialAccountId, opportunityId: directMatterId, title: 'TRANSCRIPT_DIRECT_VISIBLE', contentEnc: 'cipher' },
        { id: 'scope-routes-transcript-hidden', tenantId, accountId: partialAccountId, opportunityId: hiddenMatterId, title: 'TRANSCRIPT_HIDDEN_SECRET', contentEnc: 'cipher' },
        { id: 'scope-routes-transcript-partial', tenantId, accountId: partialAccountId, title: 'TRANSCRIPT_PARTIAL_ACCOUNT_SECRET', contentEnc: 'cipher' },
      ] });
      await context.prisma.enrichJob.createMany({ data: [
        { id: 'scope-routes-job-full', tenantId, accountId: fullAccountId, type: 'enrich_account', status: 'done', result: 'JOB_FULL_VISIBLE' },
        { id: 'scope-routes-job-direct', tenantId, accountId: partialAccountId, opportunityId: directMatterId, type: 'suggest_relations', status: 'done', result: 'JOB_DIRECT_VISIBLE' },
        { id: 'scope-routes-job-hidden', tenantId, accountId: partialAccountId, opportunityId: hiddenMatterId, type: 'suggest_relations', status: 'done', result: 'JOB_HIDDEN_SECRET' },
        { id: 'scope-routes-job-partial', tenantId, accountId: partialAccountId, type: 'enrich_account', status: 'done', result: 'JOB_PARTIAL_ACCOUNT_SECRET' },
      ] });

      expect(await stateIds(context, actor.token)).toEqual({
        accountIds: [fullAccountId, partialAccountId],
        matterIds: [directMatterId, fullMatterId],
      });

      const ctx = mcpContext(context, actor.user.id);
      const accounts = toolJson<{ accounts: Array<{ id: string; externalRef?: string }> }>(await callTool(ctx, 1, 'list_accounts'));
      expect(accounts.accounts.map((account) => account.id).sort()).toEqual([fullAccountId, partialAccountId]);
      expect(JSON.stringify(accounts)).not.toContain('PARTIAL_ACCOUNT_SECRET_REF');
      expect(toolResult(await callTool(ctx, 2, 'get_account_detail', { accountId: fullAccountId }))?.isError).not.toBe(true);
      expect(toolResult(await callTool(ctx, 3, 'get_account_detail', { accountId: partialAccountId }))).toMatchObject({ isError: true });
      expect(toolResult(await callTool(ctx, 4, 'get_win_tendency', { opportunityId: directMatterId }))?.isError).not.toBe(true);
      expect(toolResult(await callTool(ctx, 5, 'get_win_tendency', { opportunityId: hiddenMatterId }))).toMatchObject({ isError: true });
      const pending = toolJson<{ pendingPersons: Array<{ id: string }>; pendingRelationships: Array<{ id: string }> }>(await callTool(ctx, 6, 'list_pending'));
      expect(pending.pendingPersons.map((row) => row.id)).toEqual(['scope-routes-person-suggestion-full']);
      expect(pending.pendingRelationships.map((row) => row.id)).toEqual(['scope-routes-rel-direct']);

      const directManifest = await expectStatus(context, actor.token, {
        method: 'POST', url: '/api/ai/context-manifest', payload: { opportunityId: directMatterId, options: {} },
      }, 200);
      expect(directManifest.json().manifest.entities.people).toBe(1);
      const fullManifest = await expectStatus(context, actor.token, {
        method: 'POST', url: '/api/ai/context-manifest', payload: { opportunityId: fullMatterId, options: {} },
      }, 200);
      const fullManifestToken = fullManifest.json().manifestToken as string;
      await expectStatus(context, actor.token, {
        method: 'POST', url: '/api/ai/context-manifest', payload: { opportunityId: hiddenMatterId, options: {} },
      }, 404);
      expect(await buildServerAiContext({
        tenantId,
        principal: { tenantId, userId: actor.user.id, role: 'member' },
        opportunityId: directMatterId,
      })).toMatchObject({ manifest: { entities: { people: 1 } } });
      await expect(buildServerAiContext({
        tenantId,
        principal: { tenantId, userId: actor.user.id, role: 'member' },
        opportunityId: hiddenMatterId,
      })).rejects.toThrow('商机不存在');

      await expectStatus(context, actor.token, { url: `/api/pde/${directMatterId}/ev` }, 200);
      await expectStatus(context, actor.token, { url: `/api/pde/${hiddenMatterId}/ev` }, 404);
      await expect(computePde(tenantId, hiddenMatterId, context.prisma, {
        tenantId, userId: actor.user.id, role: 'member',
      })).resolves.toBeNull();

      const curatedDirect = await expectStatus(context, actor.token, {
        url: `/api/curated?entityKind=opportunity&entityId=${directMatterId}`,
      }, 200);
      expect(curatedDirect.body).toContain('CURATED_DIRECT_MATTER');
      await expectStatus(context, actor.token, {
        url: `/api/curated?entityKind=opportunity&entityId=${hiddenMatterId}`,
      }, 404);
      await expectStatus(context, actor.token, {
        url: `/api/curated?entityKind=account&entityId=${partialAccountId}`,
      }, 404);

      const inbox = await expectStatus(context, actor.token, { url: '/api/inbox' }, 200);
      const inboxJson = inbox.body;
      for (const visible of ['PENDING_FULL_PERSON_VISIBLE', 'PENDING_DIRECT_REL_VISIBLE', 'PROPOSAL_FULL_VISIBLE', 'PROPOSAL_DIRECT_VISIBLE', 'REMINDER_FULL_VISIBLE', 'REMINDER_DIRECT_VISIBLE', 'EVIDENCE_DIRECT_VISIBLE']) {
        expect(inboxJson).toContain(visible);
      }
      for (const secret of ['PENDING_PARTIAL_PERSON_SECRET', 'PENDING_HIDDEN_REL_SECRET', 'PROPOSAL_HIDDEN_SECRET', 'PROPOSAL_PARTIAL_ACCOUNT_SECRET', 'REMINDER_HIDDEN_SECRET', 'REMINDER_PARTIAL_ACCOUNT_SECRET', 'EVIDENCE_HIDDEN_SECRET']) {
        expect(inboxJson).not.toContain(secret);
      }

      const transcripts = await expectStatus(context, actor.token, { url: '/api/recording/transcripts' }, 200);
      expect(transcripts.body).toContain('TRANSCRIPT_FULL_VISIBLE');
      expect(transcripts.body).toContain('TRANSCRIPT_DIRECT_VISIBLE');
      expect(transcripts.body).not.toContain('TRANSCRIPT_HIDDEN_SECRET');
      expect(transcripts.body).not.toContain('TRANSCRIPT_PARTIAL_ACCOUNT_SECRET');

      const jobs = await expectStatus(context, actor.token, { url: '/api/enrich/jobs' }, 200);
      expect(jobs.body).toContain('JOB_FULL_VISIBLE');
      expect(jobs.body).toContain('JOB_DIRECT_VISIBLE');
      expect(jobs.body).not.toContain('JOB_HIDDEN_SECRET');
      expect(jobs.body).not.toContain('JOB_PARTIAL_ACCOUNT_SECRET');

      await expectStatus(context, actor.token, { url: `/api/repair/context/account/${fullAccountId}` }, 200);
      await expectStatus(context, actor.token, { url: `/api/repair/context/account/${partialAccountId}` }, 404);
      await expectStatus(context, actor.token, { url: `/api/repair/context/opportunity/${directMatterId}` }, 200);
      await expectStatus(context, actor.token, { url: `/api/repair/context/opportunity/${hiddenMatterId}` }, 404);

      const advisorDirect = await expectStatus(context, actor.token, {
        url: `/api/advisor/messages?opportunityId=${directMatterId}&personId=${directPersonId}`,
      }, 200);
      expect(advisorDirect.body).toContain('ADVISOR_DIRECT_VISIBLE');
      await expectStatus(context, actor.token, {
        url: `/api/advisor/messages?opportunityId=${hiddenMatterId}&personId=${hiddenPersonId}`,
      }, 404);
      await expectStatus(context, actor.token, {
        url: `/api/repair/person-merge/preview?targetPersonId=${fullPersonId}&sourcePersonId=${fullSecondPersonId}`,
      }, 200);
      await expectStatus(context, actor.token, {
        url: `/api/repair/person-merge/preview?targetPersonId=${directPersonId}&sourcePersonId=${hiddenPersonId}`,
      }, 404);

      // Ownership transfer takes effect on the next request without a new JWT.
      await context.prisma.opportunity.update({ where: { id: directMatterId }, data: { primaryOwnerUserId: other.user.id } });
      await context.prisma.opportunity.update({ where: { id: hiddenMatterId }, data: { primaryOwnerUserId: actor.user.id } });
      expect(await stateIds(context, actor.token)).toEqual({
        accountIds: [fullAccountId, partialAccountId],
        matterIds: [fullMatterId, hiddenMatterId],
      });
      expect(toolResult(await callTool(ctx, 7, 'get_win_tendency', { opportunityId: directMatterId }))).toMatchObject({ isError: true });
      expect(toolResult(await callTool(ctx, 8, 'get_win_tendency', { opportunityId: hiddenMatterId }))?.isError).not.toBe(true);
      await expectStatus(context, actor.token, {
        method: 'POST', url: '/api/ai/context-manifest', payload: { opportunityId: directMatterId, options: {} },
      }, 404);
      await expectStatus(context, actor.token, {
        method: 'POST', url: '/api/ai/context-manifest', payload: { opportunityId: hiddenMatterId, options: {} },
      }, 200);

      // Current database role also wins over the stale member role embedded in both JWT and MCP context.
      await context.prisma.user.update({ where: { id: actor.user.id }, data: { role: 'viewer' } });
      expect(await stateIds(context, actor.token)).toEqual({
        accountIds: [fullAccountId],
        matterIds: [fullMatterId],
      });
      const downgradedAccounts = toolJson<{ accounts: Array<{ id: string }> }>(await callTool(ctx, 9, 'list_accounts'));
      expect(downgradedAccounts.accounts.map((account) => account.id)).toEqual([fullAccountId]);
      expect(toolResult(await callTool(ctx, 10, 'get_win_tendency', { opportunityId: hiddenMatterId }))).toMatchObject({ isError: true });
      await expectStatus(context, actor.token, {
        method: 'POST', url: '/api/ai/context-manifest', payload: { opportunityId: hiddenMatterId, options: {} },
      }, 403);
      await expectStatus(context, actor.token, {
        method: 'POST',
        url: '/api/strategy/suggest',
        payload: { opportunityId: fullMatterId, mode: 'forward', options: {}, manifestToken: fullManifestToken },
      }, 403);
      await expectStatus(context, actor.token, {
        url: `/api/advisor/messages?opportunityId=${fullMatterId}&personId=${fullPersonId}`,
      }, 403);
      const downgradedCurated = await expectStatus(context, actor.token, {
        url: `/api/curated?entityKind=account&entityId=${fullAccountId}`,
      }, 200);
      expect(downgradedCurated.json()).toMatchObject({ status: 'restricted' });
    } finally {
      await context.cleanup();
    }
  }, 30_000);
});
