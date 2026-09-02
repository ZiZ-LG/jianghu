import type { PrismaClient } from '@prisma/client';
import {
  projectCandidateMigrationForTenant,
  type LegacyCandidateSourceKind,
} from '../../src/candidates/migration.js';

export interface LegacyCandidateAuthorityRef {
  sourceKind: LegacyCandidateSourceKind;
  sourceId: string;
}

/**
 * Test fixtures created before CORE-203 often insert only a compatibility row.
 * Materialize the exact deterministic CORE-203 projection so review tests exercise
 * the Candidate-only authority contract instead of a runtime fallback.
 */
export async function seedLegacyCandidateAuthorities(
  db: PrismaClient,
  tenantId: string,
  refs: readonly LegacyCandidateAuthorityRef[],
): Promise<void> {
  if (refs.length === 0) return;
  const projected = await projectCandidateMigrationForTenant(db, tenantId);
  const byRef = new Map(projected.projections.map((row) => [
    `${row.legacySourceKind}\u0000${row.legacySourceId}`,
    row,
  ]));
  const invalid = new Map(projected.invalidRows.map((row) => [
    `${row.sourceKind}\u0000${row.sourceId}`,
    row.reason,
  ]));
  for (const ref of refs) {
    const key = `${ref.sourceKind}\u0000${ref.sourceId}`;
    const projection = byRef.get(key);
    if (!projection) {
      throw new Error(
        `missing CORE-203 test projection for ${ref.sourceKind}:${ref.sourceId}`
        + (invalid.has(key) ? ` (${invalid.get(key)})` : ''),
      );
    }
    await db.candidate.create({ data: projection });
  }
}

export async function seedLegacyCandidateAuthority(
  db: PrismaClient,
  tenantId: string,
  sourceKind: LegacyCandidateSourceKind,
  sourceId: string,
): Promise<void> {
  await seedLegacyCandidateAuthorities(db, tenantId, [{ sourceKind, sourceId }]);
}
