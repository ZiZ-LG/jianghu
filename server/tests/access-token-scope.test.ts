import { describe, expect, it } from 'vitest';
import { createPersonCandidate, personCandidateDedupeKey } from '../src/candidates/personRelation.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

type TokenPreset = 'workbuddy_sync' | 'readonly_analysis' | 'research_proposal';

const jwtHeaders = (token: string) => ({ authorization: `Bearer ${token}` });
const mcpHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

async function createToken(context: TestContext, preset: TokenPreset) {
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/access-tokens',
    headers: jwtHeaders(context.token),
    payload: { name: `scope-${preset}`, preset },
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string; preset: TokenPreset; scopes: string[]; tokenVersion: number }>();
}

async function listedTokenId(context: TestContext): Promise<string> {
  const response = await context.app.inject({ method: 'GET', url: '/api/access-tokens', headers: jwtHeaders(context.token) });
  const body = response.json<{ tokens: Array<{ id: string }> }>();
  return body.tokens[0]!.id;
}

async function callTool(context: TestContext, token: string, name: string, args: Record<string, unknown>) {
  return context.app.inject({
    method: 'POST',
    url: '/api/mcp',
    headers: mcpHeaders(token),
    payload: { jsonrpc: '2.0', id: 303, method: 'tools/call', params: { name, arguments: args } },
  });
}

async function expectNoWriteSideEffects(context: TestContext, expected = {
  accounts: 0, candidates: 0, syncRuns: 0, commandRuns: 0, auditLogs: 0,
}) {
  const [accounts, candidates, syncRuns, commandRuns, auditLogs] = await Promise.all([
    context.prisma.account.count({ where: { tenantId: context.tenant.id } }),
    context.prisma.personSuggestion.count({ where: { tenantId: context.tenant.id } }),
    context.prisma.syncRun.count({ where: { tenantId: context.tenant.id } }),
    context.prisma.commandRun.count({ where: { tenantId: context.tenant.id } }),
    context.prisma.auditEvent.count({ where: { tenantId: context.tenant.id } }),
  ]);
  expect({ accounts, candidates, syncRuns, commandRuns, auditLogs }).toEqual(expected);
}

function toolResult(response: Awaited<ReturnType<typeof callTool>>) {
  return response.json<{ result: { content: Array<{ type: string; text: string }>; isError?: boolean } }>().result;
}

function toolJson<T>(response: Awaited<ReturnType<typeof callTool>>): T {
  return JSON.parse(toolResult(response).content[0]!.text) as T;
}

async function seedViewerProjection(context: TestContext) {
  const other = await context.prisma.user.create({
    data: {
      tenantId: context.tenant.id, email: 'other-owner@example.test', passwordHash: 'x',
      name: 'Other Owner', role: 'member',
    },
  });
  await context.prisma.account.createMany({ data: [
    { id: 'viewer-owned-account', tenantId: context.tenant.id, name: 'Owned account', customerType: 1, primaryOwnerUserId: context.owner.id },
    { id: 'viewer-unowned-account', tenantId: context.tenant.id, name: 'Unowned account', customerType: 1, primaryOwnerUserId: other.id },
  ] });
  await context.prisma.opportunity.createMany({ data: [
    { id: 'viewer-owned-opp', tenantId: context.tenant.id, accountId: 'viewer-owned-account', name: 'Owned opportunity', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
    { id: 'viewer-unowned-opp', tenantId: context.tenant.id, accountId: 'viewer-unowned-account', name: 'Unowned opportunity', customerType: 1, pipelineStage: '线索', engageStage: '需求调研立项' },
  ] });
  await createPersonCandidate(context.prisma, {
    id: 'viewer-owned-candidate', tenantId: context.tenant.id, accountId: 'viewer-owned-account',
    matterId: 'viewer-owned-opp', name: 'Owned candidate', source: 'test',
    sourceRef: 'viewer-owned-candidate', evidence: 'viewer-owned-candidate', confidence: 0.5,
    createdByUserId: context.owner.id,
    dedupeKey: personCandidateDedupeKey('viewer-owned-account', 'Owned candidate'),
  });
  await createPersonCandidate(context.prisma, {
    id: 'viewer-unowned-candidate', tenantId: context.tenant.id, accountId: 'viewer-unowned-account',
    matterId: 'viewer-unowned-opp', name: 'Unowned candidate', source: 'test',
    sourceRef: 'viewer-unowned-candidate', evidence: 'viewer-unowned-candidate', confidence: 0.5,
    createdByUserId: other.id,
    dedupeKey: personCandidateDedupeKey('viewer-unowned-account', 'Unowned candidate'),
  });
  await context.prisma.person.create({
    data: { id: 'viewer-owned-person', tenantId: context.tenant.id, accountId: 'viewer-owned-account', name: 'Private BI holder', title: 'Decision maker' },
  });
  await context.prisma.oppRole.create({
    data: { tenantId: context.tenant.id, opportunityId: 'viewer-owned-opp', personId: 'viewer-owned-person', role: 'D', sentiment: 'plus', confidence: '明确' },
  });
  await context.prisma.burningIssue.create({
    data: {
      id: 'viewer-private-bi', tenantId: context.tenant.id, opportunityId: 'viewer-owned-opp', personId: 'viewer-owned-person',
      description: 'Must remain private', category: 'private', isPrivate: true, confidence: '明确',
    },
  });
  await context.prisma.uCV.create({
    data: {
      id: 'viewer-private-ucv', tenantId: context.tenant.id, opportunityId: 'viewer-owned-opp', targetBiId: 'viewer-private-bi',
      description: 'Private solution', competitorCannot: 'Private advantage', status: '已解决',
    },
  });
}

async function expectViewerProjection(context: TestContext, credential: string): Promise<number> {
  const accounts = toolJson<{ accounts: Array<{ id: string }> }>(await callTool(context, credential, 'list_accounts', {}));
  expect(accounts.accounts.map((account) => account.id)).toEqual(['viewer-owned-account']);

  expect(toolResult(await callTool(context, credential, 'get_account_detail', { accountId: 'viewer-owned-account' })).isError).not.toBe(true);
  expect(toolResult(await callTool(context, credential, 'get_account_detail', { accountId: 'viewer-unowned-account' }))).toMatchObject({ isError: true });
  const visibleScore = toolJson<{ total: number }>(await callTool(context, credential, 'get_win_tendency', { opportunityId: 'viewer-owned-opp' }));
  expect(toolResult(await callTool(context, credential, 'get_win_tendency', { opportunityId: 'viewer-unowned-opp' }))).toMatchObject({ isError: true });

  const pending = toolJson<{ pendingPersons: Array<{ id: string }> }>(await callTool(context, credential, 'list_pending', {}));
  expect(pending.pendingPersons.map((candidate) => candidate.id)).toEqual(['viewer-owned-candidate']);
  expect(toolResult(await callTool(context, credential, 'list_pending', { accountId: 'viewer-unowned-account' }))).toMatchObject({ isError: true });
  return visibleScore.total;
}

describe('INT-303 MCP access-token scopes', () => {
  it('denies a readonly token before a business mutation and hides write tools', async () => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'readonly_analysis');
      expect(created).toMatchObject({ preset: 'readonly_analysis', scopes: ['read'], tokenVersion: 1 });

      const listed = await context.app.inject({
        method: 'POST', url: '/api/mcp', headers: mcpHeaders(created.token),
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      });
      const names = listed.json<{ result: { tools: Array<{ name: string }> } }>().result.tools.map((tool) => tool.name);
      expect(names).toContain('list_accounts');
      expect(names).not.toContain('upsert_account');
      expect(names).not.toContain('set_opportunity_roles');

      const denied = await callTool(context, created.token, 'upsert_account', {
        externalRef: 'readonly-must-not-write', name: 'Denied account',
      });
      expect(denied.statusCode).toBe(200);
      expect(denied.json()).toMatchObject({
        result: { isError: true, content: [{ type: 'text', text: '权限不足：该令牌无权调用此工具' }] },
      });
      await expectNoWriteSideEffects(context);
    } finally { await context.cleanup(); }
  });

  it('denies formal business writes for a research proposal token', async () => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'research_proposal');
      expect(created.scopes).toEqual(['read', 'propose_people', 'propose_relations', 'submit_evidence']);
      const denied = await callTool(context, created.token, 'upsert_account', {
        externalRef: 'research-must-not-write', name: 'Denied account',
      });
      expect(denied.json()).toMatchObject({ result: { isError: true } });
      await expectNoWriteSideEffects(context);
    } finally { await context.cleanup(); }
  });

  it('applies token revocation on the next MCP request', async () => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'readonly_analysis');
      const tokenId = await listedTokenId(context);
      expect((await context.app.inject({ method: 'DELETE', url: `/api/access-tokens/${tokenId}`, headers: jwtHeaders(context.token) })).statusCode).toBe(200);
      const denied = await callTool(context, created.token, 'list_accounts', {});
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: 'unauthorized' });
    } finally { await context.cleanup(); }
  });

  it('invalidates a token immediately when its current same-tenant user is removed', async () => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'workbuddy_sync');
      await context.prisma.user.delete({ where: { id: context.owner.id } });
      const denied = await callTool(context, created.token, 'list_accounts', {});
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: 'unauthorized' });
    } finally { await context.cleanup(); }
  });

  it('intersects stored scopes with a current viewer downgrade on every request', async () => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'workbuddy_sync');
      await seedViewerProjection(context);
      const memberScore = toolJson<{ total: number }>(await callTool(context, created.token, 'get_win_tendency', { opportunityId: 'viewer-owned-opp' }));
      await context.prisma.user.update({ where: { id: context.owner.id }, data: { role: 'viewer' } });

      const viewerTotal = await expectViewerProjection(context, created.token);
      expect(memberScore.total - viewerTotal).toBe(10);

      const denied = await callTool(context, created.token, 'upsert_account', {
        externalRef: 'downgrade-must-not-write', name: 'Denied account',
      });
      expect(denied.json()).toMatchObject({ result: { isError: true } });
      await expectNoWriteSideEffects(context, { accounts: 2, candidates: 2, syncRuns: 0, commandRuns: 0, auditLogs: 0 });
    } finally { await context.cleanup(); }
  });

  it('rejects caller-supplied raw scopes and never exposes token hashes', async () => {
    const context = await createTestContext();
    try {
      const forged = await context.app.inject({
        method: 'POST', url: '/api/access-tokens', headers: jwtHeaders(context.token),
        payload: { name: 'forged', preset: 'readonly_analysis', scopes: ['human_command'] },
      });
      expect(forged.statusCode).toBe(400);

      await createToken(context, 'readonly_analysis');
      const listed = await context.app.inject({ method: 'GET', url: '/api/access-tokens', headers: jwtHeaders(context.token) });
      expect(listed.statusCode).toBe(200);
      expect(listed.body).not.toContain('tokenHash');
      expect(listed.json()).toMatchObject({
        tokens: [{ preset: 'readonly_analysis', scopes: ['read'], tokenVersion: 1 }],
      });
    } finally { await context.cleanup(); }
  });

  it.each([
    { scopes: 'not-json', tokenVersion: 1 },
    { scopes: '["read","unknown_scope"]', tokenVersion: 1 },
    { scopes: '["read"]', tokenVersion: 999 },
  ])('fails closed for malformed scopes or unsupported token versions: $scopes / $tokenVersion', async ({ scopes, tokenVersion }) => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'readonly_analysis');
      await context.prisma.accessToken.update({ where: { id: await listedTokenId(context) }, data: { scopes, tokenVersion } });
      const denied = await callTool(context, created.token, 'list_accounts', {});
      expect(denied.statusCode).toBe(401);
      expect(denied.json()).toEqual({ error: 'unauthorized' });
    } finally { await context.cleanup(); }
  });

  it('keeps migrated version-0 tokens read-only and visibly unassigned to a preset', async () => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'workbuddy_sync');
      await context.prisma.accessToken.update({
        where: { id: await listedTokenId(context) },
        data: { scopes: '["read"]', tokenVersion: 0 },
      });
      const list = await context.app.inject({ method: 'GET', url: '/api/access-tokens', headers: jwtHeaders(context.token) });
      expect(list.json()).toMatchObject({ tokens: [{ preset: null, scopes: ['read'], tokenVersion: 0 }] });
      expect((await callTool(context, created.token, 'list_accounts', {})).statusCode).toBe(200);
      expect((await callTool(context, created.token, 'upsert_account', {
        externalRef: 'legacy-v0-denied', name: 'Denied account',
      })).json()).toMatchObject({ result: { isError: true } });
      await expectNoWriteSideEffects(context);
    } finally { await context.cleanup(); }
  });

  it('checks every dynamic sync_intel_bundle scope before creating a SyncRun', async () => {
    const context = await createTestContext();
    try {
      const created = await createToken(context, 'workbuddy_sync');
      await context.prisma.accessToken.update({
        where: { id: await listedTokenId(context) },
        data: { scopes: JSON.stringify(['sync_business']) },
      });
      const denied = await callTool(context, created.token, 'sync_intel_bundle', {
        idempotencyKey: 'dynamic-scope-denied-303',
        bundle: {
          account: { name: 'Denied dynamic account' },
          people: [{ ref: 'person-1', name: 'Candidate' }],
        },
      });
      expect(denied.json()).toMatchObject({
        result: { isError: true, content: [{ text: '权限不足：该令牌无权调用此工具' }] },
      });
      await expectNoWriteSideEffects(context);
    } finally { await context.cleanup(); }
  });

  it('maps a stale JWT to the current viewer role and read-only scopes', async () => {
      const context = await createTestContext();
    try {
      await seedViewerProjection(context);
      const memberScore = toolJson<{ total: number }>(await callTool(context, context.token, 'get_win_tendency', { opportunityId: 'viewer-owned-opp' }));
      await context.prisma.user.update({ where: { id: context.owner.id }, data: { role: 'viewer' } });
      const viewerTotal = await expectViewerProjection(context, context.token);
      expect(memberScore.total - viewerTotal).toBe(10);
      const denied = await callTool(context, context.token, 'upsert_account', {
        externalRef: 'jwt-viewer-denied', name: 'Denied account',
      });
      expect(denied.json()).toMatchObject({ result: { isError: true } });
      await expectNoWriteSideEffects(context, { accounts: 2, candidates: 2, syncRuns: 0, commandRuns: 0, auditLogs: 0 });
    } finally { await context.cleanup(); }
  });
});
