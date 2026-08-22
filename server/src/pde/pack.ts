// 行业包装载（M2）：pde-kernel/fixtures/seeds → IndustryPack（版本化容器）+ 展开 ActionCatalog / SignalCatalog。
// 惰性 + 幂等：PDE API 首次触达某租户时 ensure 一次；重复调用零副作用。全程 tenantId 隔离（铁律①）。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../prisma.js';
import type { DbClient } from '../mutation/scopeGuards.js';

const require_ = createRequire(import.meta.url);

export interface SeedBundle {
  params: any; scoringSchema: any; roleTemplates: any; signalCatalog: any; actionLibrary: any;
}

export interface ResolvedIndustryPack {
  packId: string;
  packKey: string;
  packSchemaVersion: string;
  signalCatalogSchemaVersion: string;
  seeds: SeedBundle;
}

export class PdeDecisionProfileUnavailableError extends Error {
  readonly statusCode = 409;
  readonly code = 'pde_decision_profile_unavailable';

  constructor() {
    super('PDE 决策参数包不存在、已停用或内容无效');
    this.name = 'PdeDecisionProfileUnavailableError';
  }
}

let seedsCache: SeedBundle | null = null;

/** 读包内种子（node_modules/pde-kernel/fixtures/seeds，file: symlink 与 Docker COPY 两种布局都可达）。 */
export function loadSeeds(): SeedBundle {
  if (seedsCache) return seedsCache;
  const pkgRoot = path.dirname(require_.resolve('pde-kernel/package.json'));
  const read = (f: string) => JSON.parse(readFileSync(path.join(pkgRoot, 'fixtures/seeds', f), 'utf8'));
  seedsCache = {
    params: read('params.json'),
    scoringSchema: read('scoring-schema.json'),
    roleTemplates: read('role-templates.json'),
    signalCatalog: read('signal-catalog.json'),
    actionLibrary: read('action-library.json'),
  };
  return seedsCache;
}

export const PACK_KEY = 'digital-energy';

function parseSeedBundle(payload: string): SeedBundle {
  try {
    const parsed = JSON.parse(payload) as Partial<SeedBundle>;
    if (
      !parsed || typeof parsed !== 'object'
      || !parsed.params || typeof parsed.params !== 'object'
      || !parsed.scoringSchema || typeof parsed.scoringSchema !== 'object'
      || !parsed.signalCatalog || typeof parsed.signalCatalog !== 'object'
      || !Array.isArray((parsed.signalCatalog as any).signals)
      || !parsed.actionLibrary || typeof parsed.actionLibrary !== 'object'
      || !Array.isArray((parsed.actionLibrary as any).actions)
    ) {
      throw new PdeDecisionProfileUnavailableError();
    }
    return parsed as SeedBundle;
  } catch (error) {
    if (error instanceof PdeDecisionProfileUnavailableError) throw error;
    throw new PdeDecisionProfileUnavailableError();
  }
}

async function expandPackCatalogs(
  db: DbClient,
  tenantId: string,
  packId: string,
  seeds: SeedBundle,
): Promise<void> {
  // 展开动作库（幂等 upsert by unique；costWan 按 costTierWan 换算，租户后续可单独调）
  const tierWan: Record<string, number> = seeds.params.costTierWan ?? { low: 0.3, mid: 1.5, high: 5.0 };
  for (const a of seeds.actionLibrary.actions as any[]) {
    await db.actionCatalog.upsert({
      where: { tenantId_packId_actionKey: { tenantId, packId, actionKey: a.id } },
      create: {
        id: 'ac_' + randomUUID().replaceAll('-', ''), tenantId, packId, actionKey: a.id,
        category: a.category, title: a.title ?? '', effectJson: JSON.stringify(a.effect ?? {}),
        costTier: a.costTier ?? 'mid', costWan: tierWan[a.costTier] ?? tierWan.mid ?? 1.5,
        stageWindow: a.stageWindow ?? 'any', targetSlots: JSON.stringify(a.targetSlots ?? []),
        gist: a.gist ?? '', scriptRef: a.source ?? '',
      },
      update: {}, // 已展开的不覆盖（租户可能已调 costWan）
    });
  }
  // 展开信号库
  for (const s of seeds.signalCatalog.signals as any[]) {
    await db.signalCatalog.upsert({
      where: { tenantId_packId_signalKey: { tenantId, packId, signalKey: s.key } },
      create: {
        id: 'sig_' + randomUUID().replaceAll('-', ''), tenantId, packId, signalKey: s.key,
        label: s.label ?? '', groupKey: s.group ?? '', direction: Number(s.direction ?? 1),
        tier: s.tier ?? 'mid', behavioral: !!s.behavioral,
      },
      update: {},
    });
  }
}

/** 确保租户已装载行业包（IndustryPack + 展开目录表）。返回 pack 行与种子内容。 */
export async function ensureIndustryPack(
  tenantId: string,
  db: DbClient = prisma,
): Promise<ResolvedIndustryPack> {
  const seeds = loadSeeds();
  const schemaVersion = String(seeds.scoringSchema.schemaVersion ?? '1.1');
  let pack = await db.industryPack.findUnique({ where: { tenantId_packKey_schemaVersion: { tenantId, packKey: PACK_KEY, schemaVersion } } });
  if (!pack) {
    pack = await db.industryPack.create({
      data: {
        id: 'pack_' + randomUUID().replaceAll('-', ''), tenantId, packKey: PACK_KEY, schemaVersion,
        payload: JSON.stringify(seeds),
      },
    });
  } else if (!pack.active) {
    await db.industryPack.updateMany({
      where: { id: pack.id, tenantId, active: false },
      data: { active: true },
    });
    pack = await db.industryPack.findFirst({ where: { id: pack.id, tenantId, active: true } });
    if (!pack) throw new Error('Industry pack activation failed');
  }
  await expandPackCatalogs(db, tenantId, pack.id, seeds);
  return {
    packId: pack.id,
    packKey: pack.packKey,
    packSchemaVersion: pack.schemaVersion,
    signalCatalogSchemaVersion: String(seeds.signalCatalog.schemaVersion ?? ''),
    seeds,
  };
}

/** Resolve the explicit context profile. A null reference has one documented meaning: use the built-in tenant pack. */
export async function resolveIndustryPack(
  tenantId: string,
  decisionProfileRef: string | null,
  db: DbClient = prisma,
): Promise<ResolvedIndustryPack> {
  if (!decisionProfileRef) return ensureIndustryPack(tenantId, db);
  const pack = await db.industryPack.findFirst({
    where: { id: decisionProfileRef, tenantId, active: true },
    select: { id: true, packKey: true, schemaVersion: true, payload: true },
  });
  if (!pack) throw new PdeDecisionProfileUnavailableError();
  const seeds = parseSeedBundle(pack.payload);
  await expandPackCatalogs(db, tenantId, pack.id, seeds);
  return {
    packId: pack.id,
    packKey: pack.packKey,
    packSchemaVersion: pack.schemaVersion,
    signalCatalogSchemaVersion: String(seeds.signalCatalog.schemaVersion ?? ''),
    seeds,
  };
}
