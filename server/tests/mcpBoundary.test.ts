import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { handleMcpBody } from '../src/mcpServer.js';
import { createPersonCandidate } from '../src/candidates/personRelation.js';
import { createTestContext } from './helpers/testApp.js';
import { internalProductPolicy } from './helpers/productPolicy.js';
import { setSensitiveResourceVisibility } from '../src/sensitiveAcl/service.js';

const ctx: CommandContext = {
  tenantId: 'tenant-mcp-boundary',
  actorId: 'actor-mcp-boundary',
  actorRole: 'member',
  channel: 'mcp',
  requestId: 'request-mcp-boundary',
  assertionMode: 'machine_proposed',
};

function liveMcpContext(context: Awaited<ReturnType<typeof createTestContext>>): CommandContext {
  return {
    tenantId: context.tenant.id,
    actorId: context.owner.id,
    actorRole: 'owner',
    channel: 'mcp',
    requestId: 'request-mcp-parentage',
    assertionMode: 'machine_proposed',
  };
}

async function callMcpTool(
  context: Awaited<ReturnType<typeof createTestContext>>,
  id: number,
  name: string,
  args: Record<string, unknown>,
) {
  return handleMcpBody(liveMcpContext(context), {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  }, internalProductPolicy);
}

async function callMcpToolAs(
  context: Awaited<ReturnType<typeof createTestContext>>,
  actor: { id: string; role: 'owner' | 'admin' | 'member' | 'viewer' },
  id: number,
  name: string,
  args: Record<string, unknown>,
) {
  return handleMcpBody({
    tenantId: context.tenant.id,
    actorId: actor.id,
    actorRole: actor.role,
    channel: 'mcp',
    requestId: `request-mcp-${id}`,
    assertionMode: 'machine_proposed',
  }, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  }, internalProductPolicy);
}

describe('MCP public JSON-RPC boundary', () => {
  it('uses only an explicit tenant-local stable owner ID for MCP/WorkBuddy upserts', async () => {
    const context = await createTestContext();
    try {
      const owner = await context.prisma.user.create({ data: { tenantId: context.tenant.id, email: 'stable-owner@test.invalid', passwordHash: 'x', name: '同名', role: 'viewer' } });
      await callMcpTool(context, 90, 'upsert_account', { externalRef: 'owner-ref', name: 'Owned', primaryOwner: '同名', primaryOwnerUserId: owner.id });
      const account = await context.prisma.account.findFirstOrThrow({ where: { tenantId: context.tenant.id, externalRef: 'owner-ref' } });
      expect(account.primaryOwnerUserId).toBe(owner.id);
      await callMcpTool(context, 92, 'upsert_account', { externalRef: 'legacy-name-only', name: 'Unowned', primaryOwner: '同名' });
      expect((await context.prisma.account.findFirstOrThrow({ where: { tenantId: context.tenant.id, externalRef: 'legacy-name-only' } })).primaryOwnerUserId).toBeNull();

      const foreignTenant = await context.prisma.tenant.create({ data: { id: 'foreign-owner-tenant', name: 'Foreign' } });
      const foreign = await context.prisma.user.create({ data: { tenantId: foreignTenant.id, email: 'foreign-owner@test.invalid', passwordHash: 'x', name: '同名', role: 'viewer' } });
      const response = await callMcpTool(context, 91, 'upsert_account', { externalRef: 'owner-ref', primaryOwner: '同名', primaryOwnerUserId: foreign.id });
      expect(JSON.stringify(response)).toContain('primary owner not found in tenant');
      expect((await context.prisma.account.findUniqueOrThrow({ where: { id: account.id } })).primaryOwnerUserId).toBe(owner.id);
    } finally { await context.cleanup(); }
  });

  it('rejects non-object tool arguments before dispatch', async () => {
    const response = await handleMcpBody(ctx, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'upsert_account', arguments: 'not-an-object' },
    }, internalProductPolicy);

    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: '无效的 tool params' },
    });
  });

  it('rejects malformed batch entries as invalid requests', async () => {
    const response = await handleMcpBody(ctx, [
      42,
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ], internalProductPolicy);

    expect(response).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('publishes profile and C3/C5 schemas aligned with the shared contract', async () => {
    const response = await handleMcpBody(ctx, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, internalProductPolicy);
    const tools = (response as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> } }).result.tools;
    const account = tools.find((tool) => tool.name === 'upsert_account');
    const opportunity = tools.find((tool) => tool.name === 'upsert_opportunity');

    expect(account?.inputSchema.properties.profile).toEqual({
      type: 'object',
      description: expect.any(String),
      properties: {
        business: { type: 'string' },
        group: { type: 'string' },
        bidding: { type: 'string' },
        risk: { type: 'string' },
        ourCooperation: { type: 'string' },
        salesNote: { type: 'string' },
        aiSuggestion: { type: 'string' },
      },
      additionalProperties: false,
    });
    expect(opportunity?.inputSchema.properties.c3Items).toMatchObject({ additionalProperties: { type: 'boolean' } });
    expect(opportunity?.inputSchema.properties.c5Items).toEqual({
      type: 'object',
      description: expect.any(String),
      properties: {
        '竞标方名单/家数': { type: 'boolean' },
        '招标参数': { type: 'boolean' },
        '评标规则': { type: 'boolean' },
        '甲方项目代表': { type: 'boolean' },
        '招标代理机构': { type: 'boolean' },
      },
      additionalProperties: false,
    });
  });

  it('upserts an account with a legacy profile through the real tools/call path', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'acc-mcp-legacy-profile';
      await context.prisma.account.create({
        data: {
          id: accountId,
          tenantId: context.tenant.id,
          name: 'Legacy Profile Account',
          customerType: 2,
          externalRef: 'legacy-profile-ref',
          profile: JSON.stringify({
            business: 'old business',
            group: 'kept group',
            salesNote: 'kept note',
            legacyCustom: 'must be preserved',
            _mcpOrigin: { source: 'client', at: 'forged', needsReview: false },
          }),
        },
      });
      const mcpCtx: CommandContext = {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        channel: 'mcp',
        requestId: 'request-mcp-legacy-profile',
        assertionMode: 'machine_proposed',
      };

      const response = await handleMcpBody(mcpCtx, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'upsert_account',
          arguments: {
            externalRef: 'legacy-profile-ref',
            profile: {
              business: 'new business',
              risk: 'new risk',
              injectedLegacy: 'must be removed',
              _mcpOrigin: { source: 'client', at: 'forged-again', needsReview: false },
            },
          },
        },
      }, internalProductPolicy);

      expect(response).toMatchObject({ jsonrpc: '2.0', id: 4, result: { content: [{ type: 'text' }] } });
      expect(response).not.toMatchObject({ result: { isError: true } });
      const updated = await context.prisma.account.findUniqueOrThrow({ where: { id: accountId } });
      const profile = JSON.parse(updated.profile) as Record<string, unknown>;
      expect(profile).toMatchObject({
        business: 'new business',
        group: 'kept group',
        salesNote: 'kept note',
        risk: 'new risk',
        _mcpOrigin: { source: 'mcp', needsReview: true, at: expect.any(String) },
      });
      expect(profile).toHaveProperty('legacyCustom', 'must be preserved');
      expect(profile).not.toHaveProperty('injectedLegacy');
      expect(profile._mcpOrigin).not.toMatchObject({ at: 'forged-again' });
    } finally {
      await context.cleanup();
    }
  });

  it('rejects propose_person when opportunityId is outside the candidate Account without creating or updating a row', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.createMany({
        data: [
          { id: 'mcp-person-acc-left', tenantId: context.tenant.id, name: 'Left', customerType: 1 },
          { id: 'mcp-person-acc-right', tenantId: context.tenant.id, name: 'Right', customerType: 1 },
        ],
      });
      await context.prisma.opportunity.createMany({
        data: [
          { id: 'mcp-person-opp-left', tenantId: context.tenant.id, accountId: 'mcp-person-acc-left', name: 'Left opp', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
          { id: 'mcp-person-opp-right', tenantId: context.tenant.id, accountId: 'mcp-person-acc-right', name: 'Right opp', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
        ],
      });
      await context.prisma.personSuggestion.create({
        data: {
          id: 'mcp-person-existing-candidate',
          tenantId: context.tenant.id,
          accountId: 'mcp-person-acc-left',
          opportunityId: 'mcp-person-opp-left',
          name: 'Existing candidate',
          evidence: 'original evidence',
          status: 'pending',
        },
      });

      const response = await callMcpTool(context, 5, 'propose_person', {
        accountId: 'mcp-person-acc-left',
        opportunityId: 'mcp-person-opp-right',
        name: 'Existing candidate',
        title: 'must not update',
        evidence: 'must not replace evidence',
      });

      expect(response).toMatchObject({ result: { isError: true } });
      await expect(context.prisma.personSuggestion.findMany({
        where: { tenantId: context.tenant.id, name: 'Existing candidate' },
      })).resolves.toEqual([
        expect.objectContaining({
          id: 'mcp-person-existing-candidate',
          opportunityId: 'mcp-person-opp-left',
          title: '',
          evidence: 'original evidence',
          status: 'pending',
        }),
      ]);
    } finally {
      await context.cleanup();
    }
  });

  it('creates the caller private Candidate without revealing another creator semantic match', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'mcp-private-dedupe-account';
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: 'Private dedupe', customerType: 1,
      } });
      const other = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: 'mcp-private-other@test.invalid',
        passwordHash: 'x',
        name: 'Other member',
        role: 'member',
      } });
      const privateCandidate = await createPersonCandidate(context.prisma, {
        id: 'mcp-private-dedupe-candidate',
        tenantId: context.tenant.id,
        accountId,
        name: '同名私有候选',
        source: 'mcp',
        sourceRef: 'mcp-private-dedupe-source',
        evidence: 'PRIVATE_EVIDENCE_MUST_NOT_LEAK',
        confidence: 0.61,
        createdByUserId: context.owner.id,
        dedupeKey: `person-pending-v1:${accountId}:同名私有候选`,
      });

      const response = await callMcpToolAs(context, { id: other.id, role: 'member' }, 51, 'propose_person', {
        accountId,
        name: '同名私有候选',
        title: 'must not take over',
        evidence: 'must not replace private evidence',
        confidence: 0.99,
      });
      const baseline = await callMcpToolAs(context, { id: other.id, role: 'member' }, 52, 'propose_person', {
        accountId,
        name: '无预存私有候选',
        title: 'baseline',
        evidence: 'baseline evidence',
        confidence: 0.7,
      });
      const text = JSON.stringify(response);
      const result = JSON.parse((response as any).result.content[0].text) as Record<string, unknown>;
      const baselineResult = JSON.parse((baseline as any).result.content[0].text) as Record<string, unknown>;

      expect(response).not.toMatchObject({ result: { isError: true } });
      expect(Object.keys(result).sort()).toEqual(Object.keys(baselineResult).sort());
      expect(result.note).toBe(baselineResult.note);
      expect(text).not.toContain(privateCandidate.row.id);
      expect(text).not.toContain('PRIVATE_EVIDENCE_MUST_NOT_LEAK');
      await expect(context.prisma.personSuggestion.findUniqueOrThrow({ where: { id: privateCandidate.row.id } }))
        .resolves.toMatchObject({
          title: '',
          evidence: 'PRIVATE_EVIDENCE_MUST_NOT_LEAK',
          confidence: 0.61,
        });
      await expect(context.prisma.candidate.findUniqueOrThrow({ where: { id: privateCandidate.candidateId } }))
        .resolves.toMatchObject({
          createdByUserId: context.owner.id,
          visibility: 'private',
          version: 0,
        });
      await expect(context.prisma.candidate.count({ where: {
        tenantId: context.tenant.id,
        kind: 'person_create',
        status: 'pending',
        createdByUserId: other.id,
      } })).resolves.toBe(2);
    } finally {
      await context.cleanup();
    }
  });

  it('filters MCP list_pending by Candidate creator ACL before returning legacy projection bodies', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'mcp-private-list-account';
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: 'Private list', customerType: 1,
      } });
      const member = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: 'mcp-private-list-member@test.invalid',
        passwordHash: 'x',
        name: 'Private list member',
        role: 'member',
      } });
      await createPersonCandidate(context.prisma, {
        id: 'mcp-private-list-own', tenantId: context.tenant.id, accountId,
        name: 'OWN_PRIVATE_VISIBLE', source: 'mcp', sourceRef: 'mcp-private-list-own-source',
        evidence: 'OWN_PRIVATE_EVIDENCE', confidence: 0.6, createdByUserId: member.id,
        dedupeKey: `person-pending-v1:${accountId}:own_private_visible`,
      });
      await createPersonCandidate(context.prisma, {
        id: 'mcp-private-list-other', tenantId: context.tenant.id, accountId,
        name: 'OTHER_PRIVATE_SECRET', source: 'mcp', sourceRef: 'mcp-private-list-other-source',
        evidence: 'OTHER_PRIVATE_EVIDENCE_SECRET', confidence: 0.6, createdByUserId: context.owner.id,
        dedupeKey: `person-pending-v1:${accountId}:other_private_secret`,
      });
      await createPersonCandidate(context.prisma, {
        id: 'mcp-private-list-system', tenantId: context.tenant.id, accountId,
        name: 'SYSTEM_QUARANTINE_SECRET', source: 'ai', sourceRef: 'mcp-private-list-system-source',
        evidence: 'SYSTEM_QUARANTINE_EVIDENCE_SECRET', confidence: 0.6, createdByUserId: null,
        dedupeKey: `person-pending-v1:${accountId}:system_quarantine_secret`,
      });

      const response = await callMcpToolAs(context, { id: member.id, role: 'member' }, 52, 'list_pending', { accountId });
      const text = (response as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
      const body = JSON.parse(text) as { pendingPersons: Array<{ id: string }> };

      expect(body.pendingPersons.map((row) => row.id)).toEqual(['mcp-private-list-own']);
      expect(text).not.toContain('OTHER_PRIVATE_SECRET');
      expect(text).not.toContain('OTHER_PRIVATE_EVIDENCE_SECRET');
      expect(text).not.toContain('SYSTEM_QUARANTINE_SECRET');
      expect(text).not.toContain('SYSTEM_QUARANTINE_EVIDENCE_SECRET');
    } finally {
      await context.cleanup();
    }
  });

  it('does not let 200 newer private Candidates starve an older readable shared Candidate', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'mcp-shared-starvation-account';
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: 'Shared starvation', customerType: 1,
      } });
      const matterId = 'mcp-shared-starvation-matter';
      await context.prisma.opportunity.create({ data: {
        id: matterId, tenantId: context.tenant.id, accountId,
        name: 'Shared starvation matter', customerType: 1,
        pipelineStage: 'lead', engageStage: 'discover',
      } });
      const reader = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: 'mcp-starvation-reader@test.invalid',
        passwordHash: 'x',
        name: 'Starvation reader',
        role: 'member',
      } });
      const older = await createPersonCandidate(context.prisma, {
        id: 'mcp-older-shared-candidate', tenantId: context.tenant.id, accountId, matterId,
        name: 'OLDER_SHARED_CANDIDATE', source: 'mcp', sourceRef: 'mcp:older-shared',
        evidence: 'older shared evidence', confidence: 0.7,
        createdByUserId: context.owner.id,
        dedupeKey: `person-pending-v1:${accountId}:older_shared_candidate`,
      });
      await context.prisma.$transaction([
        context.prisma.personSuggestion.update({
          where: { id: older.row.id }, data: { createdAt: new Date('2020-01-01') },
        }),
        context.prisma.candidate.update({
          where: { id: older.candidateId },
          data: { createdAt: new Date('2020-01-01') },
        }),
      ]);
      await setSensitiveResourceVisibility(context.prisma, {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'owner',
        kind: 'candidate',
        resourceId: older.candidateId,
        visibility: 'matter_shared',
        expectedAclVersion: 1,
      }, internalProductPolicy);
      await context.prisma.personSuggestion.createMany({ data: Array.from({ length: 200 }, (_, index) => ({
        id: `mcp-new-private-projection-${index}`,
        tenantId: context.tenant.id,
        accountId,
        opportunityId: matterId,
        name: `PRIVATE_STARVATION_${index}`,
        origin: 'mcp',
        evidence: `PRIVATE_STARVATION_EVIDENCE_${index}`,
        confidence: 0.5,
        status: 'pending',
        proposedBy: context.owner.id,
      })) });
      await context.prisma.candidate.createMany({ data: Array.from({ length: 200 }, (_, index) => ({
        id: `mcp-new-private-candidate-${index}`,
        tenantId: context.tenant.id,
        kind: 'person_create',
        status: 'pending',
        accountId,
        matterId,
        targetKind: 'person',
        source: 'mcp',
        sourceRef: `mcp:new-private:${index}`,
        evidence: `PRIVATE_STARVATION_EVIDENCE_${index}`,
        confidence: 0.5,
        createdByUserId: context.owner.id,
        visibility: 'private',
        aclVersion: 1,
        dedupeKey: `mcp-new-private-dedupe-${index}`,
        legacySourceKind: 'PersonSuggestion',
        legacySourceId: `mcp-new-private-projection-${index}`,
      })) });

      const response = await callMcpToolAs(context, { id: reader.id, role: 'member' }, 53, 'list_pending', {});
      const serialized = JSON.stringify(response);
      expect(serialized).toContain('OLDER_SHARED_CANDIDATE');
      expect(serialized).not.toContain('PRIVATE_STARVATION_EVIDENCE_');
    } finally {
      await context.cleanup();
    }
  });

  it('rejects a relationship proposal that references another creator private Candidate endpoint', async () => {
    const context = await createTestContext();
    try {
      const accountId = 'mcp-private-endpoint-account';
      const matterId = 'mcp-private-endpoint-matter';
      await context.prisma.account.create({ data: {
        id: accountId, tenantId: context.tenant.id, name: 'Private endpoint', customerType: 1,
      } });
      await context.prisma.opportunity.create({ data: {
        id: matterId, tenantId: context.tenant.id, accountId, name: 'Private endpoint matter', customerType: 1,
        pipelineStage: '线索', engageStage: '需求调研立项',
      } });
      await context.prisma.person.create({ data: {
        id: 'mcp-private-endpoint-formal', tenantId: context.tenant.id, accountId, name: 'Formal endpoint', title: '',
      } });
      const other = await context.prisma.user.create({ data: {
        tenantId: context.tenant.id,
        email: 'mcp-private-endpoint-other@test.invalid',
        passwordHash: 'x',
        name: 'Endpoint other',
        role: 'member',
      } });
      await createPersonCandidate(context.prisma, {
        id: 'mcp-private-endpoint-candidate', tenantId: context.tenant.id, accountId, matterId,
        name: 'PRIVATE_ENDPOINT_SECRET', source: 'mcp', sourceRef: 'mcp-private-endpoint-source',
        evidence: 'PRIVATE_ENDPOINT_EVIDENCE_SECRET', confidence: 0.64, createdByUserId: context.owner.id,
        dedupeKey: `person-pending-v1:${accountId}:private_endpoint_secret`,
      });

      const response = await callMcpToolAs(context, { id: other.id, role: 'member' }, 53, 'propose_relationship', {
        opportunityId: matterId,
        source: { kind: 'suggestion', id: 'mcp-private-endpoint-candidate' },
        target: { kind: 'person', id: 'mcp-private-endpoint-formal' },
        evidence: 'must not attach to private endpoint',
      });
      const text = JSON.stringify(response);

      expect(response).toMatchObject({ result: { isError: true } });
      expect(text).not.toContain('PRIVATE_ENDPOINT_SECRET');
      expect(text).not.toContain('PRIVATE_ENDPOINT_EVIDENCE_SECRET');
      await expect(context.prisma.relSuggestion.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(0);
      await expect(context.prisma.candidate.count({ where: {
        tenantId: context.tenant.id, kind: 'relation_create',
      } })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('rejects propose_relationship formal and suggestion endpoints outside the Opportunity Account without creating rows', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.createMany({
        data: [
          { id: 'mcp-rel-acc-left', tenantId: context.tenant.id, name: 'Left', customerType: 1 },
          { id: 'mcp-rel-acc-right', tenantId: context.tenant.id, name: 'Right', customerType: 1 },
        ],
      });
      await context.prisma.opportunity.create({
        data: { id: 'mcp-rel-opp-left', tenantId: context.tenant.id, accountId: 'mcp-rel-acc-left', name: 'Left opp', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
      });
      await context.prisma.person.createMany({
        data: [
          { id: 'mcp-rel-person-left', tenantId: context.tenant.id, accountId: 'mcp-rel-acc-left', name: 'Left person', title: '' },
          { id: 'mcp-rel-person-right', tenantId: context.tenant.id, accountId: 'mcp-rel-acc-right', name: 'Right person', title: '' },
        ],
      });
      await context.prisma.personSuggestion.create({
        data: { id: 'mcp-rel-suggestion-right', tenantId: context.tenant.id, accountId: 'mcp-rel-acc-right', name: 'Right candidate', status: 'pending' },
      });

      const formal = await callMcpTool(context, 6, 'propose_relationship', {
        opportunityId: 'mcp-rel-opp-left',
        source: { kind: 'person', id: 'mcp-rel-person-right' },
        target: { kind: 'person', id: 'mcp-rel-person-left' },
        layer: 'L2',
        label: 'wrong formal endpoint',
      });
      const suggestion = await callMcpTool(context, 7, 'propose_relationship', {
        opportunityId: 'mcp-rel-opp-left',
        source: { kind: 'suggestion', id: 'mcp-rel-suggestion-right' },
        target: { kind: 'person', id: 'mcp-rel-person-left' },
        layer: 'L3',
        label: 'wrong suggestion endpoint',
      });

      expect(formal).toMatchObject({ result: { isError: true } });
      expect(suggestion).toMatchObject({ result: { isError: true } });
      await expect(context.prisma.relSuggestion.count({ where: { tenantId: context.tenant.id } })).resolves.toBe(0);
    } finally {
      await context.cleanup();
    }
  });

  it('drops historical wrong-Account relationship endpoints from MCP list_pending', async () => {
    const context = await createTestContext();
    try {
      await context.prisma.account.createMany({
        data: [
          { id: 'mcp-read-acc-left', tenantId: context.tenant.id, name: 'Left', customerType: 1 },
          { id: 'mcp-read-acc-right', tenantId: context.tenant.id, name: 'Right', customerType: 1 },
        ],
      });
      await context.prisma.opportunity.create({
        data: { id: 'mcp-read-opp-left', tenantId: context.tenant.id, accountId: 'mcp-read-acc-left', name: 'Left opp', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
      });
      await context.prisma.person.createMany({
        data: [
          { id: 'mcp-read-person-left-a', tenantId: context.tenant.id, accountId: 'mcp-read-acc-left', name: 'Left A', title: '' },
          { id: 'mcp-read-person-left-b', tenantId: context.tenant.id, accountId: 'mcp-read-acc-left', name: 'Left B', title: '' },
          { id: 'mcp-read-person-right', tenantId: context.tenant.id, accountId: 'mcp-read-acc-right', name: 'Right', title: '' },
        ],
      });
      await context.prisma.personSuggestion.create({
        data: { id: 'mcp-read-suggestion-right', tenantId: context.tenant.id, accountId: 'mcp-read-acc-right', name: 'Right candidate', status: 'pending' },
      });
      await context.prisma.relSuggestion.createMany({
        data: [
          {
            id: 'mcp-read-valid', tenantId: context.tenant.id, opportunityId: 'mcp-read-opp-left',
            sourceKind: 'person', sourcePersonId: 'mcp-read-person-left-a', targetKind: 'person', targetPersonId: 'mcp-read-person-left-b',
            layer: 'L2', label: 'valid', status: 'pending',
          },
          {
            id: 'mcp-read-invalid-formal', tenantId: context.tenant.id, opportunityId: 'mcp-read-opp-left',
            sourceKind: 'person', sourcePersonId: 'mcp-read-person-right', targetKind: 'person', targetPersonId: 'mcp-read-person-left-b',
            layer: 'L2', label: 'invalid formal', evidence: 'secret formal evidence', status: 'pending',
          },
          {
            id: 'mcp-read-invalid-suggestion', tenantId: context.tenant.id, opportunityId: 'mcp-read-opp-left',
            sourceKind: 'suggestion', sourcePersonId: 'mcp-read-suggestion-right', targetKind: 'person', targetPersonId: 'mcp-read-person-left-b',
            layer: 'L3', label: 'invalid suggestion', evidence: 'secret suggestion evidence', status: 'pending',
          },
        ],
      });
      await context.prisma.candidate.createMany({ data: [
        ['mcp-read-valid', 'mcp-read-candidate-valid'],
        ['mcp-read-invalid-formal', 'mcp-read-candidate-invalid-formal'],
        ['mcp-read-invalid-suggestion', 'mcp-read-candidate-invalid-suggestion'],
      ].map(([legacySourceId, id]) => ({
        id,
        tenantId: context.tenant.id,
        kind: 'relation_create',
        accountId: 'mcp-read-acc-left',
        matterId: 'mcp-read-opp-left',
        targetKind: 'relation',
        source: 'legacy-test',
        sourceRef: `legacy-test:${legacySourceId}`,
        createdByUserId: context.owner.id,
        visibility: 'private',
        dedupeKey: `legacy-test:${legacySourceId}`,
        legacySourceKind: 'RelSuggestion',
        legacySourceId,
      })) });

      const response = await callMcpTool(context, 8, 'list_pending', { accountId: 'mcp-read-acc-left' });
      const text = (response as { result: { content: Array<{ text: string }> } }).result.content[0].text;
      const body = JSON.parse(text) as { pendingRelationships: Array<{ id: string }> };

      expect(body.pendingRelationships.map((row) => row.id)).toEqual(['mcp-read-valid']);
      expect(text).not.toContain('mcp-read-invalid-formal');
      expect(text).not.toContain('mcp-read-invalid-suggestion');
      expect(text).not.toContain('secret formal evidence');
      expect(text).not.toContain('secret suggestion evidence');
    } finally {
      await context.cleanup();
    }
  });
});
