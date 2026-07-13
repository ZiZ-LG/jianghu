import { prisma } from '../prisma.js';

export type EvidenceAlpha = [number, number, number];

export interface ApprovedEvidenceAggregate {
  ids: string[];
  alphaByStakeholder: Record<string, EvidenceAlpha>;
}

const isTier = (value: string): value is 'weak' | 'mid' | 'strong' =>
  value === 'weak' || value === 'mid' || value === 'strong';

/**
 * Aggregate only approved Evidence that belongs to the tenant/opportunity and targets an assembled stakeholder.
 * SignalCatalog is the tenant-scoped allowlist; numeric magnitudes come from the versioned industry-pack seed.
 */
export async function aggregateApprovedEvidence(
  tenantId: string,
  opportunityId: string,
  stakeholderIds: readonly string[],
  deltaAlphaMap: Record<'weak' | 'mid' | 'strong', number>,
): Promise<ApprovedEvidenceAggregate> {
  if (!stakeholderIds.length) return { ids: [], alphaByStakeholder: {} };
  const evidence = await prisma.evidenceEvent.findMany({
    where: {
      tenantId,
      opportunityId,
      status: 'approved',
      personId: { in: [...stakeholderIds] },
    },
    orderBy: { id: 'asc' },
  });
  if (!evidence.length) return { ids: [], alphaByStakeholder: {} };

  const catalog = await prisma.signalCatalog.findMany({
    where: { tenantId, signalKey: { in: [...new Set(evidence.map((item) => item.signalKey))] } },
    select: { signalKey: true },
  });
  const allowedSignals = new Set(catalog.map((item) => item.signalKey));
  const aggregate: ApprovedEvidenceAggregate = { ids: [], alphaByStakeholder: {} };
  for (const item of evidence) {
    if (!allowedSignals.has(item.signalKey) || !isTier(item.tier)) continue;
    const magnitude = deltaAlphaMap[item.tier];
    if (!Number.isFinite(magnitude) || magnitude < 0) continue;
    const alpha = aggregate.alphaByStakeholder[item.personId] ?? [0, 0, 0];
    if (item.direction > 0) alpha[0] += magnitude;
    else if (item.direction < 0) alpha[2] += magnitude;
    aggregate.alphaByStakeholder[item.personId] = alpha;
    aggregate.ids.push(item.id);
  }
  return aggregate;
}
