import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveResourceScope,
} from '../src/resourceScope.js';
import { viewerCanReadOpp } from '../src/scope.js';
import { createTestContext, type TestContext } from './helpers/testApp.js';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

async function addUser(context: TestContext, role: Role, label: string) {
  return context.prisma.user.create({
    data: {
      tenantId: context.tenant.id,
      email: `${label}-${randomUUID()}@example.test`,
      passwordHash: 'unused',
      name: label,
      role,
    },
  });
}

function principal(tenantId: string, userId: string, role: Role) {
  return { tenantId, userId, role };
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort();
}

describe('CORE-109 effective resource scope', () => {
  it('resolves scoped members from stable Customer and Matter ownership without exposing siblings', async () => {
    const context = await createTestContext();
    try {
      const actor = await addUser(context, 'member', 'Scoped actor');
      const other = await addUser(context, 'member', 'Other member');
      const foreignTenant = await context.prisma.tenant.create({
        data: { id: `foreign-${randomUUID()}`, name: 'Foreign tenant', dataScopePolicy: 'scoped' },
      });
      const foreignUser = await context.prisma.user.create({
        data: {
          tenantId: foreignTenant.id,
          email: `${randomUUID()}@foreign.test`,
          passwordHash: 'unused',
          name: 'Foreign user',
          role: 'member',
        },
      });
      await context.prisma.tenant.update({
        where: { id: context.tenant.id },
        data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.account.createMany({ data: [
        {
          id: 'owned-customer', tenantId: context.tenant.id, name: 'Owned customer',
          customerType: 1, primaryOwnerUserId: actor.id,
        },
        {
          id: 'parent-of-owned-matter', tenantId: context.tenant.id, name: 'Matter parent',
          customerType: 1, primaryOwnerUserId: other.id,
        },
        {
          id: 'hidden-customer', tenantId: context.tenant.id, name: 'Hidden customer',
          customerType: 1, primaryOwnerUserId: other.id,
        },
        {
          id: 'foreign-owner-customer', tenantId: context.tenant.id, name: 'Foreign owner',
          customerType: 1, primaryOwnerUserId: foreignUser.id,
        },
        {
          id: 'departed-owner-customer', tenantId: context.tenant.id, name: 'Departed owner',
          customerType: 1, primaryOwnerUserId: 'deleted-user-id',
        },
      ] });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: 'matter-under-owned-customer', tenantId: context.tenant.id,
          accountId: 'owned-customer', name: 'Inherited matter', customerType: 1,
          pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: other.id,
        },
        {
          id: 'owned-matter', tenantId: context.tenant.id,
          accountId: 'parent-of-owned-matter', name: 'Owned matter', customerType: 1,
          pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: actor.id,
        },
        {
          id: 'sibling-matter', tenantId: context.tenant.id,
          accountId: 'parent-of-owned-matter', name: 'Sibling matter', customerType: 1,
          pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: other.id,
        },
        {
          id: 'hidden-matter', tenantId: context.tenant.id,
          accountId: 'hidden-customer', name: 'Hidden matter', customerType: 1,
          pipelineStage: 'lead', engageStage: 'discover', primaryOwnerUserId: other.id,
        },
      ] });
      await context.prisma.account.create({
        data: {
          id: 'foreign-customer', tenantId: foreignTenant.id, name: 'Foreign customer',
          customerType: 1, primaryOwnerUserId: actor.id,
        },
      });
      await context.prisma.opportunity.create({
        data: {
          id: 'foreign-matter', tenantId: foreignTenant.id, accountId: 'foreign-customer',
          name: 'Foreign matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
          primaryOwnerUserId: actor.id,
        },
      });

      const scope = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, actor.id, 'member'),
      );

      expect(scope.actorRole).toBe('member');
      expect(scope.policy).toBe('scoped');
      expect(sorted(scope.fullAccountIds)).toEqual(['owned-customer']);
      expect(sorted(scope.matterIds)).toEqual(['matter-under-owned-customer', 'owned-matter']);
      expect(sorted(scope.accountIds)).toEqual(['owned-customer', 'parent-of-owned-matter']);
      expect(scope.canReadAccountData('owned-customer')).toBe(true);
      expect(scope.canReadAccountData('parent-of-owned-matter')).toBe(false);
      expect(scope.canReadAccountContainer('parent-of-owned-matter')).toBe(true);
      expect(scope.canReadMatter('owned-matter')).toBe(true);
      expect(scope.canReadMatter('sibling-matter')).toBe(false);
      expect(scope.canReadAccountContainer('foreign-customer')).toBe(false);
      expect(scope.canReadMatter('foreign-matter')).toBe(false);

      const sent: unknown[] = [];
      const reply = {
        code(value: number) { sent.push(value); return this; },
        send(value: unknown) { sent.push(value); return this; },
      };
      await expect(viewerCanReadOpp({
        user: { tenantId: context.tenant.id, userId: actor.id, role: 'member' },
      }, reply, 'sibling-matter')).resolves.toBe(false);
      expect(sent[0]).toBe(404);
    } finally {
      await context.cleanup();
    }
  });

  it('preserves legacy and elevated-role visibility while revalidating role and policy every call', async () => {
    const context = await createTestContext();
    try {
      const actor = await addUser(context, 'member', 'Mutable actor');
      const admin = await addUser(context, 'admin', 'Admin');
      const viewer = await addUser(context, 'viewer', 'Viewer');
      await context.prisma.account.createMany({ data: [
        {
          id: 'actor-account', tenantId: context.tenant.id, name: 'Actor account',
          customerType: 1, primaryOwnerUserId: actor.id,
        },
        {
          id: 'viewer-account', tenantId: context.tenant.id, name: 'Viewer account',
          customerType: 1, primaryOwnerUserId: viewer.id,
        },
        {
          id: 'unowned-account', tenantId: context.tenant.id, name: 'Unowned account',
          customerType: 1,
        },
      ] });
      await context.prisma.opportunity.createMany({ data: [
        {
          id: 'actor-account-matter', tenantId: context.tenant.id, accountId: 'actor-account',
          name: 'Actor account matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
        },
        {
          id: 'viewer-account-matter', tenantId: context.tenant.id, accountId: 'viewer-account',
          name: 'Viewer account matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
        },
        {
          id: 'viewer-direct-matter', tenantId: context.tenant.id, accountId: 'unowned-account',
          name: 'Viewer direct matter', customerType: 1, pipelineStage: 'lead', engageStage: 'discover',
          primaryOwnerUserId: viewer.id,
        },
      ] });

      const legacy = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, actor.id, 'member'),
      );
      expect(legacy.policy).toBe('legacy_tenant_shared');
      expect(sorted(legacy.fullAccountIds)).toEqual([
        'actor-account', 'unowned-account', 'viewer-account',
      ]);
      expect(sorted(legacy.matterIds)).toEqual([
        'actor-account-matter', 'viewer-account-matter', 'viewer-direct-matter',
      ]);

      await context.prisma.tenant.update({
        where: { id: context.tenant.id }, data: { dataScopePolicy: 'scoped' },
      });
      const elevated = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, admin.id, 'viewer'),
      );
      expect(elevated.actorRole).toBe('admin');
      expect(sorted(elevated.fullAccountIds)).toEqual([
        'actor-account', 'unowned-account', 'viewer-account',
      ]);
      const ownerScope = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, context.owner.id, 'viewer'),
      );
      expect(ownerScope.actorRole).toBe('owner');
      expect(sorted(ownerScope.fullAccountIds)).toEqual([
        'actor-account', 'unowned-account', 'viewer-account',
      ]);

      const viewerScope = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, viewer.id, 'owner'),
      );
      expect(viewerScope.actorRole).toBe('viewer');
      expect(sorted(viewerScope.fullAccountIds)).toEqual(['viewer-account']);
      expect(sorted(viewerScope.matterIds)).toEqual(['viewer-account-matter']);
      expect(viewerScope.canReadMatter('viewer-direct-matter')).toBe(false);

      await context.prisma.user.update({ where: { id: actor.id }, data: { role: 'viewer' } });
      const downgraded = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, actor.id, 'member'),
      );
      expect(downgraded.actorRole).toBe('viewer');
      expect(sorted(downgraded.fullAccountIds)).toEqual(['actor-account']);
      expect(sorted(downgraded.matterIds)).toEqual(['actor-account-matter']);

      await context.prisma.tenant.update({
        where: { id: context.tenant.id }, data: { dataScopePolicy: 'unknown-policy' },
      });
      const unknown = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, admin.id, 'admin'),
      );
      expect(sorted(unknown.accountIds)).toEqual([]);
      expect(sorted(unknown.fullAccountIds)).toEqual([]);
      expect(sorted(unknown.matterIds)).toEqual([]);

      await context.prisma.tenant.update({
        where: { id: context.tenant.id }, data: { dataScopePolicy: 'scoped' },
      });
      await context.prisma.user.update({ where: { id: admin.id }, data: { role: 'root' } });
      const invalidRole = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, admin.id, 'admin'),
      );
      expect(sorted(invalidRole.accountIds)).toEqual([]);
      expect(sorted(invalidRole.matterIds)).toEqual([]);

      await context.prisma.user.delete({ where: { id: actor.id } });
      const deleted = await resolveEffectiveResourceScope(
        context.prisma,
        principal(context.tenant.id, actor.id, 'owner'),
      );
      expect(sorted(deleted.accountIds)).toEqual([]);
      expect(sorted(deleted.matterIds)).toEqual([]);
    } finally {
      await context.cleanup();
    }
  });
});
