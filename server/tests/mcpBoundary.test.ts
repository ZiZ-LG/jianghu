import { describe, expect, it } from 'vitest';
import type { CommandContext } from '@jianghu/domain-contracts';
import { handleMcpBody } from '../src/mcpServer.js';
import { createTestContext } from './helpers/testApp.js';

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
  });
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
    });

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
    ]);

    expect(response).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } },
      { jsonrpc: '2.0', id: 2, result: {} },
    ]);
  });

  it('publishes profile and C3/C5 schemas aligned with the shared contract', async () => {
    const response = await handleMcpBody(ctx, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
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
    expect(opportunity?.inputSchema.properties.c5Items).toMatchObject({ additionalProperties: { type: 'boolean' } });
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
      });

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
