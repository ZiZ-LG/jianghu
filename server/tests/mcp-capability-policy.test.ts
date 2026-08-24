import { afterEach, describe, expect, it } from 'vitest';
import { assembleProductAccess, type CommandContext } from '@jianghu/domain-contracts';
import { executeMcpTool } from '../src/mcpServer.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  while (contexts.length > 0) await contexts.pop()!.cleanup();
});

async function testContext() {
  const context = await createTestContext();
  contexts.push(context);
  return context;
}

function mcpContext(context: TestContext, label: string): CommandContext {
  return {
    tenantId: context.tenant.id,
    actorId: context.owner.id,
    actorRole: 'owner',
    channel: 'mcp',
    requestId: `mcp-policy-${label}`,
    assertionMode: 'machine_proposed',
    scopes: ['read', 'sync_business'],
  };
}

describe('legacy MCP tool capability policy', () => {
  it.each([
    ['internal', assembleProductAccess({ edition: 'internal' }).policy],
    ['commercial sales-enabled', assembleProductAccess({ edition: 'commercial', enabledEntitlements: ['sales.workspace'] }).policy],
  ])('forwards %s policy through account, opportunity, and visit writes', async (label, policy) => {
    const context = await testContext();
    const ctx = mcpContext(context, label);
    const ref = label.replaceAll(' ', '-');

    await expect(executeMcpTool(ctx, 'upsert_account', {
      externalRef: `${ref}-account`, name: `${label} account`, customerType: 2,
    }, policy)).resolves.toMatchObject({ origin: 'mcp' });
    await expect(executeMcpTool(ctx, 'upsert_opportunity', {
      accountExternalRef: `${ref}-account`, externalRef: `${ref}-opportunity`, name: `${label} opportunity`,
    }, policy)).resolves.toMatchObject({ origin: 'mcp' });
    await expect(executeMcpTool(ctx, 'append_visit_note', {
      accountExternalRef: `${ref}-account`, opportunityExternalRef: `${ref}-opportunity`,
      externalRef: `${ref}-visit`, date: '2026-08-23', summary: 'Policy forwarding smoke',
    }, policy)).resolves.toMatchObject({ origin: 'mcp' });

    expect(await context.prisma.account.count({ where: { tenantId: context.tenant.id } })).toBe(1);
    expect(await context.prisma.opportunity.count({ where: { tenantId: context.tenant.id } })).toBe(1);
    expect(await context.prisma.visitNote.count({ where: { tenantId: context.tenant.id } })).toBe(1);
  });

  it.each([
    ['commercial Free', assembleProductAccess({ edition: 'commercial' }).policy],
    ['missing', undefined],
    ['malformed', { entitlements: ['sales.workspace'] }],
  ])('fails closed for %s policy before all three legacy tool writes', async (_label, policy) => {
    const context = await testContext();
    const ctx = mcpContext(context, 'denied');
    for (const [name, args] of [
      ['upsert_account', { externalRef: 'denied-account', name: 'Denied', customerType: 2 }],
      ['upsert_opportunity', { accountExternalRef: 'denied-account', externalRef: 'denied-opportunity', name: 'Denied' }],
      ['append_visit_note', { accountExternalRef: 'denied-account', externalRef: 'denied-visit', date: '2026-08-23', summary: 'Denied' }],
    ] as const) {
      await expect(executeMcpTool(ctx, name, args, policy)).rejects.toThrow('能力未启用');
    }
    expect(await context.prisma.account.count({ where: { tenantId: context.tenant.id } })).toBe(0);
    expect(await context.prisma.opportunity.count({ where: { tenantId: context.tenant.id } })).toBe(0);
    expect(await context.prisma.visitNote.count({ where: { tenantId: context.tenant.id } })).toBe(0);
  });
});
