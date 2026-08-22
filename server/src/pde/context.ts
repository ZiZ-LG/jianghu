import { randomUUID } from 'node:crypto';
import type { Stage } from 'pde-kernel';
import type { DbClient } from '../mutation/scopeGuards.js';

export const PDE_STAGE_KEYS = [
  'initiation',
  'feasibility',
  'budget_approval',
  'tender_design',
  'tender_execution',
] as const satisfies readonly Stage[];

const stageKeys = new Set<string>(PDE_STAGE_KEYS);
const contextSources = new Set(['legacy_shadow', 'manual', 'system_default']);

export interface PdeDecisionContextAuthority {
  id: string;
  tenantId: string;
  opportunityId: string;
  stageKey: Stage;
  decisionProfileRef: string | null;
  source: string;
  version: number;
}

export class PdeContextUninitializedError extends Error {
  readonly statusCode = 409;
  readonly code = 'pde_context_uninitialized';

  constructor() {
    super('PDE 决策上下文尚未初始化');
    this.name = 'PdeContextUninitializedError';
  }
}

export class PdeContextInvalidError extends Error {
  readonly statusCode = 409;
  readonly code = 'pde_context_invalid';

  constructor() {
    super('PDE 决策上下文无效，请先修复');
    this.name = 'PdeContextInvalidError';
  }
}

export class PdeContextVersionConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'pde_context_version_conflict';

  constructor() {
    super('PDE 决策上下文已变化，请刷新后重试');
    this.name = 'PdeContextVersionConflictError';
  }
}

export class PdeContextWriteForbiddenError extends Error {
  readonly statusCode = 403;
  readonly code = 'pde_context_write_forbidden';

  constructor() {
    super('无权修改 PDE 决策上下文');
    this.name = 'PdeContextWriteForbiddenError';
  }
}

export function parsePdeStageKey(value: string): Stage {
  if (!stageKeys.has(value)) throw new PdeContextInvalidError();
  return value as Stage;
}

export async function readPdeDecisionContext(
  db: DbClient,
  tenantId: string,
  opportunityId: string,
): Promise<PdeDecisionContextAuthority | null> {
  const row = await db.pdeDecisionContext.findFirst({
    where: { tenantId, opportunityId },
    select: {
      id: true,
      tenantId: true,
      opportunityId: true,
      stageKey: true,
      decisionProfileRef: true,
      source: true,
      version: true,
    },
  });
  if (!row) return null;
  if (!contextSources.has(row.source) || !Number.isSafeInteger(row.version) || row.version < 0) {
    throw new PdeContextInvalidError();
  }
  return { ...row, stageKey: parsePdeStageKey(row.stageKey) };
}

export async function createPdeDecisionContext(
  db: DbClient,
  input: {
    tenantId: string;
    opportunityId: string;
    stageKey?: Stage;
    decisionProfileRef?: string | null;
    source?: 'legacy_shadow' | 'manual' | 'system_default';
  },
): Promise<PdeDecisionContextAuthority> {
  const row = await db.pdeDecisionContext.create({ data: {
    id: `pdc_${randomUUID().replaceAll('-', '')}`,
    tenantId: input.tenantId,
    opportunityId: input.opportunityId,
    stageKey: input.stageKey ?? 'initiation',
    decisionProfileRef: input.decisionProfileRef ?? null,
    source: input.source ?? 'system_default',
  } });
  return { ...row, stageKey: parsePdeStageKey(row.stageKey) };
}
