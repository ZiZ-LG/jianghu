export const LEGACY_COMMITMENT_TIME_ZONE = 'Asia/Shanghai';

export interface LegacyPlanActionMappingInput {
  startDate: string;
  endDate: string;
  done: boolean;
  origin: string;
}

export interface LegacyCommitmentFields {
  kind: string;
  ownerUserId: string | null;
  executionStatus: 'planned' | 'completed';
  confirmationStatus: 'not_required';
  scheduledAtUtc: null;
  dueAtUtc: null;
  timeZone: typeof LEGACY_COMMITMENT_TIME_ZONE;
  isAllDay: true;
  localDate: string;
  confirmationDueAtUtc: null;
  confirmedAtUtc: null;
  confirmedByUserId: null;
  scheduleVersion: 0;
  nextCommitmentId: null;
  source: string;
  sourceRef: null;
  archivedAt: null;
  version: 0;
}

export function isRealLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}

function commitmentLocalDate(input: Pick<LegacyPlanActionMappingInput, 'startDate' | 'endDate'>): string {
  if (input.startDate && !isRealLocalDate(input.startDate)) {
    throw new Error(`invalid legacy PlanAction startDate: ${input.startDate}`);
  }
  if (input.endDate && !isRealLocalDate(input.endDate)) {
    throw new Error(`invalid legacy PlanAction endDate: ${input.endDate}`);
  }
  const localDate = input.endDate || input.startDate;
  if (!localDate) throw new Error('legacy PlanAction requires a business date');
  return localDate;
}

/**
 * Deterministic expand-phase mapping from the legacy fields on a PlanAction row.
 * `half` is deliberately ignored: am/pm/eve is not an exact instant, so old rows
 * become all-day local-date commitments instead of fabricating UTC timestamps.
 */
export function mapLegacyPlanActionToCommitmentFields(
  input: LegacyPlanActionMappingInput,
  ownerUserId: string | null,
): LegacyCommitmentFields {
  return {
    kind: 'task',
    ownerUserId,
    executionStatus: input.done ? 'completed' : 'planned',
    confirmationStatus: 'not_required',
    scheduledAtUtc: null,
    dueAtUtc: null,
    timeZone: LEGACY_COMMITMENT_TIME_ZONE,
    isAllDay: true,
    localDate: commitmentLocalDate(input),
    confirmationDueAtUtc: null,
    confirmedAtUtc: null,
    confirmedByUserId: null,
    scheduleVersion: 0,
    nextCommitmentId: null,
    source: input.origin.trim() || 'manual',
    sourceRef: null,
    archivedAt: null,
    version: 0,
  };
}
