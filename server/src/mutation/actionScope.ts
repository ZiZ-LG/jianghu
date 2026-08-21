import type { Action } from '@jianghu/domain-contracts';
import {
  ScopedNotFoundError,
  requireAccount,
  requireEdgeEndpoints,
  requireOpportunity,
  requirePerson,
  requireScopedRow,
  type DbClient,
} from './scopeGuards.js';

function parseIdReferences(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) throw new ScopedNotFoundError();
    return parsed;
  } catch (error) {
    if (error instanceof ScopedNotFoundError) throw error;
    throw new ScopedNotFoundError();
  }
}

async function requirePlanActionReferences(
  db: DbClient,
  tenantId: string,
  accountId: string,
  opportunityId: string,
  actionIds: readonly string[],
): Promise<void> {
  const expected = new Set(actionIds);
  if (expected.size === 0) return;
  const rows = await db.planAction.findMany({
    where: { tenantId, accountId, opportunityId, id: { in: [...expected] } },
    select: { id: true },
  });
  if (rows.length !== expected.size) throw new ScopedNotFoundError();
}

async function requireBurningIssue(
  db: DbClient,
  tenantId: string,
  accountId: string,
  opportunityId: string,
  biId: string,
) {
  const row = await requireScopedRow(db.burningIssue.findFirst({
    where: { id: biId, tenantId, opportunityId },
    select: { id: true, personId: true },
  }));
  await requirePerson(db, tenantId, accountId, row.personId);
  return row;
}

async function requireUcv(
  db: DbClient,
  tenantId: string,
  accountId: string,
  opportunityId: string,
  ucvId: string,
) {
  const row = await requireScopedRow(db.uCV.findFirst({
    where: { id: ucvId, tenantId, opportunityId },
    select: { id: true, targetBiId: true },
  }));
  await requireBurningIssue(db, tenantId, accountId, opportunityId, row.targetBiId);
  return row;
}

async function requireVisit(
  db: DbClient,
  tenantId: string,
  accountId: string,
  visitId: string,
) {
  const row = await requireScopedRow(db.visitNote.findFirst({
    where: { id: visitId, tenantId, accountId },
    select: { id: true, opportunityId: true },
  }));
  if (row.opportunityId) await requireOpportunity(db, tenantId, accountId, row.opportunityId);
  return row;
}

async function requireNote(
  db: DbClient,
  tenantId: string,
  accountId: string,
  noteId: string,
) {
  const row = await requireScopedRow(db.note.findFirst({
    where: { id: noteId, tenantId, accountId },
    select: { id: true, opportunityId: true, personId: true },
  }));
  if (row.opportunityId) await requireOpportunity(db, tenantId, accountId, row.opportunityId);
  if (row.personId) await requirePerson(db, tenantId, accountId, row.personId);
  return row;
}

async function requirePlanAction(
  db: DbClient,
  tenantId: string,
  accountId: string,
  actionId: string,
) {
  const row = await requireScopedRow(db.planAction.findFirst({
    where: { id: actionId, tenantId, accountId },
    select: { id: true, opportunityId: true, personId: true },
  }));
  // Customer-level Commitments are not legacy PlanActions. Every legacy
  // update/delete/toggle path fails closed before it can touch the same row.
  if (!row.opportunityId) throw new ScopedNotFoundError();
  await requireOpportunity(db, tenantId, accountId, row.opportunityId);
  if (row.personId) await requirePerson(db, tenantId, accountId, row.personId);
  return row;
}

async function requireStrategyCard(
  db: DbClient,
  tenantId: string,
  accountId: string,
  cardId: string,
) {
  const row = await requireScopedRow(db.strategyCard.findFirst({
    where: { id: cardId, tenantId, accountId },
    select: { id: true, opportunityId: true, personId: true, dispatchedActionIds: true },
  }));
  await requireOpportunity(db, tenantId, accountId, row.opportunityId);
  if (row.personId) await requirePerson(db, tenantId, accountId, row.personId);
  await requirePlanActionReferences(
    db,
    tenantId,
    accountId,
    row.opportunityId,
    parseIdReferences(row.dispatchedActionIds),
  );
  return row;
}

async function requireNoForeignOpportunityChildren(
  db: DbClient,
  tenantId: string,
  opportunityIds: readonly string[],
): Promise<void> {
  if (opportunityIds.length === 0) return;
  const opportunityId = { in: [...opportunityIds] };
  const foreignTenant = { not: tenantId };
  const rows = await Promise.all([
    db.relSuggestion.findFirst({ where: { opportunityId, tenantId: foreignTenant }, select: { id: true } }),
    db.oppRole.findFirst({ where: { opportunityId, tenantId: foreignTenant }, select: { id: true } }),
    db.opportunityMember.findFirst({ where: { opportunityId, tenantId: foreignTenant }, select: { id: true } }),
    db.matterParticipant.findFirst({ where: { opportunityId, tenantId: foreignTenant }, select: { id: true } }),
    db.edge.findFirst({ where: { opportunityId, tenantId: foreignTenant }, select: { id: true } }),
    db.burningIssue.findFirst({ where: { opportunityId, tenantId: foreignTenant }, select: { id: true } }),
    db.uCV.findFirst({ where: { opportunityId, tenantId: foreignTenant }, select: { id: true } }),
  ]);
  if (rows.some(Boolean)) throw new ScopedNotFoundError();
}

async function requireSafeAccountDelete(db: DbClient, tenantId: string, accountId: string): Promise<void> {
  const [foreignPerson, foreignOpportunity, foreignEdge, opportunities] = await Promise.all([
    db.person.findFirst({ where: { accountId, tenantId: { not: tenantId } }, select: { id: true } }),
    db.opportunity.findFirst({ where: { accountId, tenantId: { not: tenantId } }, select: { id: true } }),
    db.edge.findFirst({ where: { accountId, tenantId: { not: tenantId } }, select: { id: true } }),
    db.opportunity.findMany({ where: { accountId, tenantId }, select: { id: true } }),
  ]);
  if (foreignPerson || foreignOpportunity || foreignEdge) throw new ScopedNotFoundError();
  await requireNoForeignOpportunityChildren(db, tenantId, opportunities.map((opportunity) => opportunity.id));
}

export async function requireActionScope(db: DbClient, tenantId: string, action: Action): Promise<void> {
  if (action.type === 'ADD_ACCOUNT') return;
  await requireAccount(db, tenantId, action.accId);

  switch (action.type) {
    case 'UPDATE_ACCOUNT':
    case 'ADD_OPP':
    case 'ADD_PERSON':
      return;

    case 'DELETE_ACCOUNT':
      await requireSafeAccountDelete(db, tenantId, action.accId);
      return;

    case 'UPDATE_OPP':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      return;

    case 'DELETE_OPP':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requireNoForeignOpportunityChildren(db, tenantId, [action.oppId]);
      return;

    case 'UPDATE_PERSON':
    case 'MOVE_PERSON':
    case 'DELETE_PERSON':
    case 'ADD_LOG':
      await requirePerson(db, tenantId, action.accId, action.personId);
      return;

    case 'SET_ROLE':
    case 'ADD_OPP_MEMBER': {
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requirePerson(db, tenantId, action.accId, action.personId);
      return;
    }

    case 'REMOVE_ROLE':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requirePerson(db, tenantId, action.accId, action.personId);
      await requireScopedRow(db.oppRole.findFirst({
        where: { tenantId, opportunityId: action.oppId, personId: action.personId },
        select: { id: true },
      }));
      return;

    case 'REMOVE_OPP_MEMBER':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requirePerson(db, tenantId, action.accId, action.personId);
      await requireScopedRow(db.opportunityMember.findFirst({
        where: { tenantId, opportunityId: action.oppId, personId: action.personId },
        select: { id: true },
      }));
      return;

    case 'ADD_EDGE':
      if (action.oppId) await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requireEdgeEndpoints(db, tenantId, action.accId, action.edge.source, action.edge.target);
      return;

    case 'UPDATE_EDGE': {
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      const edge = await requireScopedRow(db.edge.findFirst({
        where: {
          id: action.edgeId,
          tenantId,
          accountId: action.accId,
          OR: [{ opportunityId: action.oppId }, { opportunityId: null }],
        },
        select: { source: true, target: true },
      }));
      await requireEdgeEndpoints(
        db,
        tenantId,
        action.accId,
        action.patch.source ?? edge.source,
        action.patch.target ?? edge.target,
      );
      return;
    }

    case 'DELETE_EDGE': {
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      const edge = await requireScopedRow(db.edge.findFirst({
        where: {
          id: action.edgeId,
          tenantId,
          accountId: action.accId,
          OR: [{ opportunityId: action.oppId }, { opportunityId: null }],
        },
        select: { source: true, target: true },
      }));
      await requireEdgeEndpoints(db, tenantId, action.accId, edge.source, edge.target);
      return;
    }

    case 'ADD_BI':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requirePerson(db, tenantId, action.accId, action.bi.personId);
      return;

    case 'UPDATE_BI':
    case 'DELETE_BI':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requireBurningIssue(db, tenantId, action.accId, action.oppId, action.biId);
      return;

    case 'ADD_UCV':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requireBurningIssue(db, tenantId, action.accId, action.oppId, action.ucv.targetBiId);
      return;

    case 'UPDATE_UCV': {
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      const current = await requireUcv(db, tenantId, action.accId, action.oppId, action.ucvId);
      await requireBurningIssue(
        db,
        tenantId,
        action.accId,
        action.oppId,
        action.patch.targetBiId ?? current.targetBiId,
      );
      return;
    }

    case 'DELETE_UCV':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requireUcv(db, tenantId, action.accId, action.oppId, action.ucvId);
      return;

    case 'ADD_VISIT':
      if (action.visit.opportunityId) {
        await requireOpportunity(db, tenantId, action.accId, action.visit.opportunityId);
      }
      return;

    case 'UPDATE_VISIT': {
      const current = await requireVisit(db, tenantId, action.accId, action.visitId);
      const opportunityId = action.patch.opportunityId ?? current.opportunityId;
      if (opportunityId) await requireOpportunity(db, tenantId, action.accId, opportunityId);
      return;
    }

    case 'DELETE_VISIT':
      await requireVisit(db, tenantId, action.accId, action.visitId);
      return;

    case 'ADD_NOTE':
      if (action.note.opportunityId) {
        await requireOpportunity(db, tenantId, action.accId, action.note.opportunityId);
      }
      if (action.note.personId) await requirePerson(db, tenantId, action.accId, action.note.personId);
      return;

    case 'UPDATE_NOTE': {
      const current = await requireNote(db, tenantId, action.accId, action.noteId);
      const opportunityId = action.patch.opportunityId ?? current.opportunityId;
      const personId = action.patch.personId ?? current.personId;
      if (opportunityId) await requireOpportunity(db, tenantId, action.accId, opportunityId);
      if (personId) await requirePerson(db, tenantId, action.accId, personId);
      return;
    }

    case 'DELETE_NOTE':
      await requireNote(db, tenantId, action.accId, action.noteId);
      return;

    case 'ADD_PLAN_ACTION':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      if (action.planAction.personId) {
        await requirePerson(db, tenantId, action.accId, action.planAction.personId);
      }
      return;

    case 'UPDATE_PLAN_ACTION':
      await requirePlanAction(db, tenantId, action.accId, action.actionId);
      if (action.patch.personId) await requirePerson(db, tenantId, action.accId, action.patch.personId);
      return;

    case 'DELETE_PLAN_ACTION':
    case 'TOGGLE_PLAN_ACTION':
      await requirePlanAction(db, tenantId, action.accId, action.actionId);
      return;

    case 'ADD_MILESTONE':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      return;

    case 'UPDATE_MILESTONE':
    case 'DELETE_MILESTONE': {
      const row = await requireScopedRow(db.oppMilestone.findFirst({
        where: { id: action.milestoneId, tenantId, accountId: action.accId },
        select: { opportunityId: true },
      }));
      await requireOpportunity(db, tenantId, action.accId, row.opportunityId);
      return;
    }

    case 'ADD_OPP_STAGE':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      return;

    case 'UPDATE_OPP_STAGE':
    case 'DELETE_OPP_STAGE': {
      const row = await requireScopedRow(db.oppStage.findFirst({
        where: { id: action.stageId, tenantId, accountId: action.accId },
        select: { opportunityId: true },
      }));
      await requireOpportunity(db, tenantId, action.accId, row.opportunityId);
      return;
    }

    case 'ADD_STRATEGY_CARD':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      if (action.card.personId) await requirePerson(db, tenantId, action.accId, action.card.personId);
      await requirePlanActionReferences(
        db,
        tenantId,
        action.accId,
        action.oppId,
        action.card.dispatchedActionIds ?? [],
      );
      return;

    case 'UPDATE_STRATEGY_CARD': {
      const current = await requireStrategyCard(db, tenantId, action.accId, action.cardId);
      if (action.patch.personId) await requirePerson(db, tenantId, action.accId, action.patch.personId);
      if (action.patch.dispatchedActionIds) {
        await requirePlanActionReferences(
          db,
          tenantId,
          action.accId,
          current.opportunityId,
          action.patch.dispatchedActionIds,
        );
      }
      return;
    }

    case 'DELETE_STRATEGY_CARD':
      await requireStrategyCard(db, tenantId, action.accId, action.cardId);
      return;

    case 'ADD_STRATEGY_RISK':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      return;

    case 'UPDATE_STRATEGY_RISK':
    case 'DELETE_STRATEGY_RISK': {
      const row = await requireScopedRow(db.strategyRisk.findFirst({
        where: { id: action.riskId, tenantId, accountId: action.accId },
        select: { opportunityId: true },
      }));
      await requireOpportunity(db, tenantId, action.accId, row.opportunityId);
      return;
    }

    case 'ADD_STRATEGY_RESOURCE':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      return;

    case 'UPDATE_STRATEGY_RESOURCE':
    case 'DELETE_STRATEGY_RESOURCE': {
      const row = await requireScopedRow(db.strategyResource.findFirst({
        where: { id: action.resourceId, tenantId, accountId: action.accId },
        select: { opportunityId: true },
      }));
      await requireOpportunity(db, tenantId, action.accId, row.opportunityId);
      return;
    }

    case 'ADD_EVIDENCE':
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      await requirePerson(db, tenantId, action.accId, action.evidence.personId);
      return;

    case 'DELETE_EVIDENCE': {
      await requireOpportunity(db, tenantId, action.accId, action.oppId);
      const row = await requireScopedRow(db.evidenceEvent.findFirst({
        where: {
          id: action.evidenceId,
          tenantId,
          accountId: action.accId,
          opportunityId: action.oppId,
        },
        select: { personId: true },
      }));
      await requirePerson(db, tenantId, action.accId, row.personId);
      return;
    }

    default: {
      const exhaustive: never = action;
      throw new Error(`unknown action: ${String(exhaustive)}`);
    }
  }
}
