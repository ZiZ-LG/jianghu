import type { PrismaClient } from '@prisma/client';

// 口径依 ADR-INT-502（2026-07-21）：受控运行 336h→48h，样本门槛 100→20；
// 不足样本且零失败时由项目所有者按 ADR 人工判定。
export const RELEASE_OBSERVATION_HOURS = 48;
export const RELEASE_MIN_LOGICAL_COMMANDS = 20;

export type ReleaseMetricInput = {
  tenantId: string;
  start: Date;
  end: Date;
};

export async function collectInternalReleaseMetrics(db: PrismaClient, input: ReleaseMetricInput) {
  const window = { gte: input.start, lt: input.end };
  const staleBefore = new Date(input.end.getTime() - 5 * 60_000);
  const [completed, failed, running, staleSyncRuns, expiredCommandLeases, formalPeople, duplicateFormalPeople, repairAudits] = await Promise.all([
    db.syncRun.count({ where: { tenantId: input.tenantId, createdAt: window, status: 'completed' } }),
    db.syncRun.count({ where: { tenantId: input.tenantId, createdAt: window, status: 'failed' } }),
    db.syncRun.count({ where: { tenantId: input.tenantId, createdAt: window, status: 'running' } }),
    db.syncRun.count({ where: { tenantId: input.tenantId, status: 'running', updatedAt: { lt: staleBefore } } }),
    db.commandRun.count({ where: {
      tenantId: input.tenantId, status: 'running', leaseExpiresAt: { lt: input.end },
    } }),
    db.person.count({ where: { tenantId: input.tenantId, createdAt: window } }),
    db.person.count({ where: { tenantId: input.tenantId, createdAt: window, mergedIntoPersonId: { not: null } } }),
    db.auditEvent.groupBy({
      by: ['action'],
      where: {
        tenantId: input.tenantId,
        createdAt: window,
        action: { in: ['rebind', 'person_merge', 'action_feedback', 'archive', 'restore'] },
      },
      _count: { _all: true },
    }),
  ]);
  const terminal = completed + failed;
  const successRatePct = terminal === 0 ? null : completed * 100 / terminal;
  const duplicateRatePct = formalPeople === 0 ? null : duplicateFormalPeople * 100 / formalPeople;
  const hours = (input.end.getTime() - input.start.getTime()) / 3_600_000;
  const thresholds = {
    observedRequiredHours: hours >= RELEASE_OBSERVATION_HOURS,
    minimumSample: terminal >= RELEASE_MIN_LOGICAL_COMMANDS,
    successRate: successRatePct !== null && successRatePct >= 99,
    duplicateRate: duplicateRatePct !== null && duplicateRatePct < 1,
    noRunningOrStaleRuns: running === 0 && staleSyncRuns === 0 && expiredCommandLeases === 0,
  };
  return {
    format: 'jianghu-internal-release-metrics-v1',
    tenantId: input.tenantId,
    window: { start: input.start.toISOString(), end: input.end.toISOString(), hours },
    workbuddyLogicalCommands: { completed, failed, running, terminal, successRatePct },
    recoverySignals: { staleSyncRuns, expiredCommandLeases },
    formalPeople: { created: formalPeople, mergedAsDuplicate: duplicateFormalPeople, duplicateRatePct },
    auditCounts: Object.fromEntries(repairAudits.map((row) => [row.action, row._count._all])),
    thresholds,
    automaticPass: Object.values(thresholds).every(Boolean),
    manualRequirements: ['incident ledger confirms no serious data-integrity incident', 'every failed SyncRun has an assigned recovery outcome'],
  };
}
