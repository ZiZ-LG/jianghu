import type { PlanAction } from '@prisma/client';
import { CommitmentV2Schema, type CommitmentV2 } from '@jianghu/domain-contracts';

export type CommitmentPlanActionRow = Pick<PlanAction,
  | 'id'
  | 'accountId'
  | 'opportunityId'
  | 'personId'
  | 'title'
  | 'kind'
  | 'ownerUserId'
  | 'executionStatus'
  | 'confirmationStatus'
  | 'scheduledAtUtc'
  | 'dueAtUtc'
  | 'timeZone'
  | 'isAllDay'
  | 'localDate'
  | 'confirmationDueAtUtc'
  | 'confirmedAtUtc'
  | 'confirmedByUserId'
  | 'scheduleVersion'
  | 'nextCommitmentId'
  | 'source'
  | 'sourceRef'
  | 'archivedAt'
  | 'version'
>;

/** The only PlanAction-row adapter used by generic Commitment read models. */
export function commitmentFromPlanAction(row: CommitmentPlanActionRow): CommitmentV2 | null {
  const parsed = CommitmentV2Schema.safeParse({
    id: row.id,
    customerId: row.accountId,
    matterId: row.opportunityId,
    personId: row.personId,
    title: row.title,
    kind: row.kind,
    ownerUserId: row.ownerUserId,
    executionStatus: row.executionStatus,
    confirmationStatus: row.confirmationStatus,
    scheduledAtUtc: row.scheduledAtUtc?.toISOString() ?? null,
    dueAtUtc: row.dueAtUtc?.toISOString() ?? null,
    timeZone: row.timeZone,
    isAllDay: row.isAllDay,
    localDate: row.localDate,
    confirmationDueAtUtc: row.confirmationDueAtUtc?.toISOString() ?? null,
    confirmedAtUtc: row.confirmedAtUtc?.toISOString() ?? null,
    confirmedByUserId: row.confirmedByUserId,
    scheduleVersion: row.scheduleVersion,
    nextCommitmentId: row.nextCommitmentId,
    source: row.source,
    sourceRef: row.sourceRef,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    version: row.version,
  });
  return parsed.success ? parsed.data : null;
}
