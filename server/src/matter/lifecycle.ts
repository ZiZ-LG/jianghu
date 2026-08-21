export const LEGACY_OPPORTUNITY_STATUSES = ['active', 'paused', 'won', 'lost'] as const;

export type LegacyOpportunityStatus = (typeof LEGACY_OPPORTUNITY_STATUSES)[number];
export type MatterLifecycleStatus = 'active' | 'paused' | 'completed' | 'canceled';

export interface MatterLifecycleProjection {
  lifecycleStatus: MatterLifecycleStatus;
  outcomeKey: string | null;
}

const LEGACY_STATUS_MAPPING: Record<LegacyOpportunityStatus, MatterLifecycleProjection> = {
  active: { lifecycleStatus: 'active', outcomeKey: null },
  paused: { lifecycleStatus: 'paused', outcomeKey: null },
  won: { lifecycleStatus: 'completed', outcomeKey: 'won' },
  lost: { lifecycleStatus: 'completed', outcomeKey: 'lost' },
};

export function isLegacyOpportunityStatus(status: string): status is LegacyOpportunityStatus {
  return (LEGACY_OPPORTUNITY_STATUSES as readonly string[]).includes(status);
}

export function mapLegacyOpportunityStatus(status: string): MatterLifecycleProjection {
  if (!isLegacyOpportunityStatus(status)) {
    throw new Error(`unsupported legacy Opportunity status: ${status}`);
  }
  return { ...LEGACY_STATUS_MAPPING[status] };
}
