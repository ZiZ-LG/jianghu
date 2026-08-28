import { z } from 'zod';
import {
  IntelligenceItemViewSchema,
  IntelligenceTargetRefSchema,
  StakeholderFocusBasisRefSchema,
  StakeholderFocusViewSchema,
  type IntelligenceItemView,
  type IntelligenceTargetRef,
  type StakeholderFocusBasisRef,
  type StakeholderFocusView,
} from '@jianghu/domain-contracts';

const targetsSchema = z.array(IntelligenceTargetRefSchema).min(1).max(12).superRefine((values, ctx) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = `${value.kind}\u0000${value.id}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'duplicate target' });
    seen.add(key);
  });
});

const basisSchema = z.array(StakeholderFocusBasisRefSchema).max(8).superRefine((values, ctx) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = `${value.kind}\u0000${value.id}`;
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index], message: 'duplicate basis' });
    seen.add(key);
  });
});

function canonicalJson<T>(schema: z.ZodType<T>, value: unknown, code: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return JSON.stringify(parsed.data);
}

function parseCanonicalJson<T>(schema: z.ZodType<T>, raw: string, code: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(code);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success || JSON.stringify(parsed.data) !== raw) throw new Error(code);
  return parsed.data;
}

export function canonicalIntelligenceTargets(values: readonly IntelligenceTargetRef[]): string {
  return canonicalJson(targetsSchema, values, 'intelligence_target_refs_invalid');
}

export function parseStoredIntelligenceTargets(raw: string): IntelligenceTargetRef[] {
  return parseCanonicalJson(targetsSchema, raw, 'intelligence_target_refs_corrupt');
}

export function canonicalFocusBasisRefs(values: readonly StakeholderFocusBasisRef[]): string {
  return canonicalJson(basisSchema, values, 'stakeholder_focus_basis_refs_invalid');
}

export function parseStoredFocusBasisRefs(raw: string): StakeholderFocusBasisRef[] {
  return parseCanonicalJson(basisSchema, raw, 'stakeholder_focus_basis_refs_corrupt');
}

export interface IntelligenceItemProjectionRow {
  id: string;
  customerId: string;
  matterId: string;
  assertionType: string;
  statement: string;
  sourceKind: string;
  sourceDescription: string;
  sourceRefId: string | null;
  sourceRefVersion: number | null;
  occurredAt: Date | null;
  learnedAt: Date;
  confidence: number;
  targetRefs: string;
  createdByUserId: string;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function projectIntelligenceItem(row: IntelligenceItemProjectionRow): IntelligenceItemView {
  const parsed = IntelligenceItemViewSchema.safeParse({
    id: row.id,
    customerId: row.customerId,
    matterId: row.matterId,
    assertionType: row.assertionType,
    statement: row.statement,
    source: {
      kind: row.sourceKind,
      description: row.sourceDescription,
      refId: row.sourceRefId,
      refVersion: row.sourceRefVersion,
    },
    occurredAt: row.occurredAt?.toISOString() ?? null,
    learnedAt: row.learnedAt.toISOString(),
    confidence: row.confidence,
    targets: parseStoredIntelligenceTargets(row.targetRefs),
    status: row.archivedAt ? 'archived' : 'active',
    createdByUserId: row.createdByUserId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) throw new Error('intelligence_item_storage_corrupt');
  return parsed.data;
}

export interface StakeholderFocusProjectionRow {
  id: string;
  customerId: string;
  matterId: string;
  personId: string;
  desiredChange: string;
  rationale: string;
  evidenceGap: string | null;
  basisRefs: string;
  validUntil: Date;
  activeMatterKey: string | null;
  confirmedByUserId: string;
  confirmedAt: Date;
  retiredByUserId: string | null;
  retiredAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export function projectStakeholderFocus(
  row: StakeholderFocusProjectionRow,
  now = new Date(),
): StakeholderFocusView {
  const isRetired = row.retiredAt !== null;
  if ((isRetired && row.activeMatterKey !== null)
    || (!isRetired && row.activeMatterKey !== row.matterId)) {
    throw new Error('stakeholder_focus_storage_corrupt');
  }
  const status = isRetired ? 'retired' : row.validUntil.getTime() <= now.getTime() ? 'expired' : 'active';
  const parsed = StakeholderFocusViewSchema.safeParse({
    id: row.id,
    customerId: row.customerId,
    matterId: row.matterId,
    personId: row.personId,
    desiredChange: row.desiredChange,
    rationale: row.rationale,
    evidenceGap: row.evidenceGap,
    basisRefs: parseStoredFocusBasisRefs(row.basisRefs),
    validUntil: row.validUntil.toISOString(),
    status,
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: row.confirmedAt.toISOString(),
    retiredByUserId: row.retiredByUserId,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) throw new Error('stakeholder_focus_storage_corrupt');
  return parsed.data;
}
