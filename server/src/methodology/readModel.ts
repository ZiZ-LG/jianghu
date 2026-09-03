import {
  CommandContextSchema,
  G64111_BUILTIN_PACK_KEY,
  G64111_BUILTIN_SOURCE_TEMPLATE_REF,
  G64111MethodologyReadModelSchema,
  type CommandContext,
  type G64111MethodologyReadModel,
  type MethodologyActiveBindingSummary,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';

export class G64111MethodologyReadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 409,
    readonly scopedNotFound = false,
  ) {
    super(code);
    this.name = 'G64111MethodologyReadError';
  }
}

function conflict(): never {
  throw new G64111MethodologyReadError('methodology_read_conflict');
}

function notFound(): never {
  throw new G64111MethodologyReadError('methodology_read_not_found', 404, true);
}

export async function buildG64111MethodologyReadModel(
  db: DbClient,
  ctx: CommandContext,
  now = new Date(),
): Promise<G64111MethodologyReadModel> {
  CommandContextSchema.parse(ctx);
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid methodology observation time');

  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (!scope.valid) notFound();

  // Match either half of the built-in identity so a lookalike or partially-corrupt
  // installation fails closed instead of being treated as "not installed".
  const installationCandidates = await db.methodologyPack.findMany({
    where: {
      tenantId: ctx.tenantId,
      OR: [
        { key: G64111_BUILTIN_PACK_KEY },
        { sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF },
      ],
    },
    select: {
      id: true,
      key: true,
      name: true,
      sourceTemplateRef: true,
      currentPublishedVersionId: true,
      archivedAt: true,
    },
  });
  if (installationCandidates.length > 1) conflict();

  let installation: G64111MethodologyReadModel['installation'] = null;
  const installedPack = installationCandidates[0];
  if (installedPack) {
    if (installedPack.archivedAt
      || installedPack.key !== G64111_BUILTIN_PACK_KEY
      || installedPack.sourceTemplateRef !== G64111_BUILTIN_SOURCE_TEMPLATE_REF
      || !installedPack.currentPublishedVersionId) conflict();
    const currentVersion = await db.methodologyPackVersion.findFirst({
      where: {
        id: installedPack.currentPublishedVersionId,
        tenantId: ctx.tenantId,
        packId: installedPack.id,
      },
      select: {
        id: true,
        packId: true,
        versionKey: true,
        status: true,
        engineRef: true,
        sourceTemplateRef: true,
      },
    });
    if (!currentVersion
      || currentVersion.packId !== installedPack.id
      || currentVersion.status !== 'published'
      || currentVersion.sourceTemplateRef !== G64111_BUILTIN_SOURCE_TEMPLATE_REF) conflict();
    installation = {
      packId: installedPack.id,
      versionId: currentVersion.id,
      packKey: G64111_BUILTIN_PACK_KEY,
      packName: installedPack.name,
      sourceTemplateRef: G64111_BUILTIN_SOURCE_TEMPLATE_REF,
      versionKey: currentVersion.versionKey,
      engineRef: currentVersion.engineRef,
    };
  }

  const visibleMatterIds = [...scope.matterIds];
  const matterRows = visibleMatterIds.length === 0 ? [] : await db.opportunity.findMany({
    where: {
      tenantId: ctx.tenantId,
      id: { in: visibleMatterIds },
      lifecycleStatus: 'active',
      archivedAt: null,
      account: { tenantId: ctx.tenantId, archivedAt: null },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      accountId: true,
      name: true,
      kind: true,
      version: true,
      activeMethodologyBindingId: true,
      account: { select: { id: true, name: true } },
    },
  });

  const activeBindingIds = [...new Set(matterRows.flatMap((matter) => (
    matter.activeMethodologyBindingId ? [matter.activeMethodologyBindingId] : []
  )))];
  const bindingRows = activeBindingIds.length === 0 ? [] : await db.methodologyBinding.findMany({
    where: {
      tenantId: ctx.tenantId,
      id: { in: activeBindingIds },
      opportunityId: { in: matterRows.map((matter) => matter.id) },
    },
    select: {
      id: true,
      opportunityId: true,
      packId: true,
      versionId: true,
      methodologyVersion: {
        select: {
          id: true,
          packId: true,
          versionKey: true,
          status: true,
          engineRef: true,
          sourceTemplateRef: true,
          pack: {
            select: {
              id: true,
              key: true,
              name: true,
              sourceTemplateRef: true,
              archivedAt: true,
            },
          },
        },
      },
    },
  });
  const bindingById = new Map(bindingRows.map((binding) => [binding.id, binding]));

  const matters = matterRows.map((matter) => {
    let activeBinding: MethodologyActiveBindingSummary | null = null;
    if (matter.activeMethodologyBindingId) {
      const binding = bindingById.get(matter.activeMethodologyBindingId);
      const version = binding?.methodologyVersion;
      const pack = version?.pack;
      if (!binding || !version || !pack
        || binding.opportunityId !== matter.id
        || binding.packId !== version.packId
        || binding.versionId !== version.id
        || pack.id !== binding.packId
        || pack.archivedAt
        || !['published', 'deprecated'].includes(version.status)) conflict();

      const resemblesG64111 = pack.key === G64111_BUILTIN_PACK_KEY
        || pack.sourceTemplateRef === G64111_BUILTIN_SOURCE_TEMPLATE_REF
        || version.sourceTemplateRef === G64111_BUILTIN_SOURCE_TEMPLATE_REF;
      if (resemblesG64111 && (
        pack.key !== G64111_BUILTIN_PACK_KEY
        || pack.sourceTemplateRef !== G64111_BUILTIN_SOURCE_TEMPLATE_REF
        || version.sourceTemplateRef !== G64111_BUILTIN_SOURCE_TEMPLATE_REF
        || installation?.packId !== pack.id
      )) conflict();

      activeBinding = {
        bindingId: binding.id,
        customerId: matter.accountId,
        matterId: matter.id,
        packId: binding.packId,
        versionId: binding.versionId,
        packKey: pack.key,
        packName: pack.name,
        sourceTemplateRef: version.sourceTemplateRef,
        versionKey: version.versionKey,
        engineRef: version.engineRef,
      };
    }
    return {
      customerId: matter.accountId,
      customerName: matter.account.name,
      matterId: matter.id,
      matterTitle: matter.name,
      matterKind: matter.kind,
      matterVersion: matter.version,
      activeBinding,
    };
  });

  const parsed = G64111MethodologyReadModelSchema.safeParse({
    generatedAtUtc: now.toISOString(),
    commandsEnabled: process.env.METHODOLOGY_COMMANDS_ENABLED === '1',
    canManage: scope.actorRole === 'owner' || scope.actorRole === 'admin',
    installation,
    matters,
  });
  if (!parsed.success) conflict();
  return parsed.data;
}
