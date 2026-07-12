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

describe('MCP public JSON-RPC boundary', () => {
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
});
