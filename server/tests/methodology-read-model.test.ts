import { randomUUID } from 'node:crypto';
import {
  G64111_BUILTIN_PACK_KEY,
  G64111_BUILTIN_SOURCE_TEMPLATE_REF,
  G64111MethodologyReadModelSchema,
  isG64111Active,
  type CommandContext,
} from '@jianghu/domain-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildG64111MethodologyReadModel } from '../src/methodology/readModel.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const originalCommandGate = process.env.METHODOLOGY_COMMANDS_ENABLED;

beforeEach(() => { process.env.METHODOLOGY_COMMANDS_ENABLED = '1'; });
afterEach(() => {
  if (originalCommandGate === undefined) delete process.env.METHODOLOGY_COMMANDS_ENABLED;
  else process.env.METHODOLOGY_COMMANDS_ENABLED = originalCommandGate;
});

async function addUser(context: TestContext, role: 'member' | 'viewer') {
  const user = await context.prisma.user.create({ data: {
    tenantId: context.tenant.id,
    email: `${role}-${randomUUID()}@example.test`,
    passwordHash: 'unused',
    name: `${role} user`,
    role,
  } });
  return {
    user,
    token: context.app.jwt.sign({
      tenantId: context.tenant.id,
      userId: user.id,
      role: 'owner',
    }),
  };
}

async function seedMatter(
  context: TestContext,
  suffix: string,
  ownerUserId = context.owner.id,
) {
  const customerId = `methodology-read-customer-${suffix}`;
  const matterId = `methodology-read-matter-${suffix}`;
  await context.prisma.account.create({ data: {
    id: customerId,
    tenantId: context.tenant.id,
    name: `Customer ${suffix}`,
    primaryOwnerUserId: ownerUserId,
  } });
  await context.prisma.opportunity.create({ data: {
    id: matterId,
    tenantId: context.tenant.id,
    accountId: customerId,
    name: `Matter ${suffix}`,
    kind: 'general',
    customerType: 1,
    pipelineStage: `POISON_PIPELINE_${suffix}`,
    engageStage: `POISON_ENGAGE_${suffix}`,
    c3Items: JSON.stringify({ poison: suffix }),
    c5Items: JSON.stringify({ poison: suffix }),
    winProbability: 91,
    primaryOwnerUserId: ownerUserId,
  } });
  return { customerId, matterId };
}

async function installPack(
  context: TestContext,
  input: {
    packId: string;
    versionId: string;
    key: string;
    name: string;
    sourceTemplateRef: string;
    engineRef: string;
  },
) {
  await context.prisma.methodologyPack.create({ data: {
    id: input.packId,
    tenantId: context.tenant.id,
    key: input.key,
    name: input.name,
    sourceTemplateRef: input.sourceTemplateRef,
    currentPublishedVersionId: input.versionId,
    createdByUserId: context.owner.id,
  } });
  await context.prisma.methodologyPackVersion.create({ data: {
    id: input.versionId,
    tenantId: context.tenant.id,
    packId: input.packId,
    versionKey: '1.0.0',
    status: 'published',
    engineRef: input.engineRef,
    contentHash: 'a'.repeat(64),
    sourceTemplateRef: input.sourceTemplateRef,
    createdByUserId: context.owner.id,
    publishedByUserId: context.owner.id,
    publishedAt: new Date('2026-09-03T12:00:00.000Z'),
  } });
}

async function bind(
  context: TestContext,
  matter: { matterId: string },
  input: { bindingId: string; packId: string; versionId: string },
) {
  await context.prisma.methodologyBinding.create({ data: {
    id: input.bindingId,
    tenantId: context.tenant.id,
    opportunityId: matter.matterId,
    packId: input.packId,
    versionId: input.versionId,
    createdByUserId: context.owner.id,
  } });
  await context.prisma.opportunity.update({
    where: { id: matter.matterId },
    data: { activeMethodologyBindingId: input.bindingId },
  });
}

describe('SAAS-210 G64111 methodology read boundary', () => {
  it('requires auth and methodology entitlement and returns a strict no-store empty fixture', async () => {
    const enabled = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['methodology.g64111'] },
    });
    try {
      expect((await enabled.app.inject({ method: 'GET', url: '/api/methodology/g64111' })).statusCode).toBe(401);
      const response = await enabled.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(enabled.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(G64111MethodologyReadModelSchema.parse(response.json())).toMatchObject({
        commandsEnabled: true,
        canManage: true,
        installation: null,
        matters: [],
      });
    } finally {
      await enabled.cleanup();
    }

    const free = await createTestContext({ productAccess: { edition: 'commercial' } });
    try {
      const denied = await free.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(free.token),
      });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.json()).toEqual({ error: '能力未启用', code: 'capability_denied' });
    } finally {
      await free.cleanup();
    }
  });

  it('returns neutral Matters without consuming poisoned legacy G64111 fields', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['methodology.g64111'] },
    });
    try {
      const matter = await seedMatter(context, 'neutral');
      const opportunityReads = vi.spyOn(context.prisma.opportunity, 'findMany');
      const model = await buildG64111MethodologyReadModel(context.prisma, {
        tenantId: context.tenant.id,
        actorId: context.owner.id,
        actorRole: 'viewer',
        channel: 'web',
        requestId: 'methodology-neutral-read',
        assertionMode: 'user_asserted',
      } satisfies CommandContext, new Date('2026-09-03T12:00:00.000Z'));

      expect(model.matters).toEqual([{
        customerId: matter.customerId,
        customerName: 'Customer neutral',
        matterId: matter.matterId,
        matterTitle: 'Matter neutral',
        matterKind: 'general',
        matterVersion: 0,
        activeBinding: null,
      }]);
      expect(JSON.stringify(model)).not.toMatch(/POISON_|c3Items|c5Items|winProbability|pipelineStage|engageStage/);
      const projectionRead = opportunityReads.mock.calls.find(([args]) => (
        typeof args === 'object' && args !== null && 'select' in args
        && (args as any).select?.name === true
      ));
      expect(projectionRead?.[0]).toMatchObject({
        where: { tenantId: context.tenant.id },
        select: {
          id: true, accountId: true, name: true, kind: true, version: true,
          activeMethodologyBindingId: true,
        },
      });
      expect((projectionRead?.[0] as any).select).not.toHaveProperty('pipelineStage');
      opportunityReads.mockRestore();
    } finally {
      await context.cleanup();
    }
  });

  it('marks only an exact installed G64111 active binding and leaves other methodologies neutral', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['methodology.g64111'] },
    });
    try {
      const gMatter = await seedMatter(context, 'g64111');
      const otherMatter = await seedMatter(context, 'other');
      await installPack(context, {
        packId: 'pack-g64111', versionId: 'version-g64111',
        key: G64111_BUILTIN_PACK_KEY, name: 'G64111 趋赢力',
        sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF, engineRef: 'g64111:0.1.0',
      });
      await installPack(context, {
        packId: 'pack-other', versionId: 'version-other',
        key: 'tenant.other', name: 'Other methodology',
        sourceTemplateRef: 'tenant:other:1', engineRef: 'declarative:1',
      });
      await bind(context, gMatter, {
        bindingId: 'binding-g64111', packId: 'pack-g64111', versionId: 'version-g64111',
      });
      await bind(context, otherMatter, {
        bindingId: 'binding-other', packId: 'pack-other', versionId: 'version-other',
      });
      const foreignTenantId = `foreign-tenant-${randomUUID()}`;
      const foreignUserId = `foreign-user-${randomUUID()}`;
      await context.prisma.tenant.create({ data: { id: foreignTenantId, name: 'Foreign tenant' } });
      await context.prisma.user.create({ data: {
        id: foreignUserId, tenantId: foreignTenantId, email: `foreign-${randomUUID()}@example.test`,
        passwordHash: 'unused', name: 'Foreign owner', role: 'owner',
      } });
      await context.prisma.account.create({ data: {
        id: `foreign-customer-${randomUUID()}`, tenantId: foreignTenantId,
        name: 'FOREIGN_CUSTOMER_MUST_NOT_LEAK', primaryOwnerUserId: foreignUserId,
      } });

      const response = await context.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(context.token),
      });
      expect(response.statusCode, response.body).toBe(200);
      const model = G64111MethodologyReadModelSchema.parse(response.json());
      expect(model.installation).toMatchObject({
        packId: 'pack-g64111', versionId: 'version-g64111',
        packKey: G64111_BUILTIN_PACK_KEY,
        sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
      });
      const byId = new Map(model.matters.map((matter) => [matter.matterId, matter]));
      expect(isG64111Active(byId.get(gMatter.matterId)!.activeBinding)).toBe(true);
      expect(isG64111Active(byId.get(otherMatter.matterId)!.activeBinding)).toBe(false);
      expect(byId.get(otherMatter.matterId)!.activeBinding).toMatchObject({ packKey: 'tenant.other' });
      expect(response.body).not.toContain('FOREIGN_CUSTOMER_MUST_NOT_LEAK');
    } finally {
      await context.cleanup();
    }
  });

  it('revalidates viewer ownership and current database role under scoped policy', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['methodology.g64111'] },
    });
    try {
      const viewer = await addUser(context, 'viewer');
      const member = await addUser(context, 'member');
      await context.prisma.tenant.update({
        where: { id: context.tenant.id }, data: { dataScopePolicy: 'scoped' },
      });
      const visible = await seedMatter(context, 'viewer-visible', viewer.user.id);
      const memberVisible = await seedMatter(context, 'member-visible', member.user.id);
      const hidden = await seedMatter(context, 'viewer-hidden', context.owner.id);

      const memberResponse = await context.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(member.token),
      });
      expect(memberResponse.statusCode, memberResponse.body).toBe(200);
      expect(G64111MethodologyReadModelSchema.parse(memberResponse.json())).toMatchObject({
        canManage: false,
        matters: [{ matterId: memberVisible.matterId }],
      });
      expect(memberResponse.body).not.toContain(visible.matterId);
      expect(memberResponse.body).not.toContain(hidden.matterId);

      const viewerResponse = await context.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(viewer.token),
      });
      expect(viewerResponse.statusCode, viewerResponse.body).toBe(200);
      expect(G64111MethodologyReadModelSchema.parse(viewerResponse.json())).toMatchObject({
        canManage: false,
        matters: [{ matterId: visible.matterId }],
      });
      expect(viewerResponse.body).not.toContain(hidden.matterId);

      await context.prisma.user.update({ where: { id: viewer.user.id }, data: { role: 'admin' } });
      const promoted = await context.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(viewer.token),
      });
      const promotedModel = G64111MethodologyReadModelSchema.parse(promoted.json());
      expect(promotedModel.canManage).toBe(true);
      expect(promotedModel.matters.map((matter) => matter.matterId).sort()).toEqual([
        hidden.matterId, memberVisible.matterId, visible.matterId,
      ].sort());
    } finally {
      await context.cleanup();
    }
  });

  it('fails closed for dangling active pointers and malformed G64111 installations', async () => {
    const context = await createTestContext({
      productAccess: { edition: 'commercial', enabledEntitlements: ['methodology.g64111'] },
    });
    try {
      const matter = await seedMatter(context, 'corrupt');
      await context.prisma.opportunity.update({
        where: { id: matter.matterId }, data: { activeMethodologyBindingId: 'missing-binding' },
      });
      const dangling = await context.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(context.token),
      });
      expect(dangling.statusCode).toBe(409);
      expect(dangling.json()).toMatchObject({ code: 'methodology_read_conflict' });

      await context.prisma.opportunity.update({
        where: { id: matter.matterId }, data: { activeMethodologyBindingId: null },
      });
      await context.prisma.methodologyPack.create({ data: {
        id: 'malformed-g64111-pack',
        tenantId: context.tenant.id,
        key: G64111_BUILTIN_PACK_KEY,
        name: 'Lookalike',
        sourceTemplateRef: 'builtin:not-g64111:1',
        currentPublishedVersionId: 'missing-version',
        createdByUserId: context.owner.id,
      } });
      const malformed = await context.app.inject({
        method: 'GET', url: '/api/methodology/g64111', headers: auth(context.token),
      });
      expect(malformed.statusCode).toBe(409);
      expect(malformed.json()).toMatchObject({ code: 'methodology_read_conflict' });
    } finally {
      await context.cleanup();
    }
  });
});
