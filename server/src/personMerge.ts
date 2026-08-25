import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ActorRoleSchema, type CommandContext } from '@jianghu/domain-contracts';
import { prisma } from './prisma.js';
import { runCommand } from './mutation/commandRunner.js';
import { activePersonWhere } from './activePerson.js';
import { resolveScopedRelSuggestions } from './suggestionScope.js';
import { resolveEffectiveResourceScope } from './resourceScope.js';
import { redirectCandidatePersonReferences } from './candidates/personRelation.js';

const roleDecisionSchema = z.enum(['keep_target', 'keep_source']);
export const PersonMergeDecisionSchema = z.object({
  targetPersonId: z.string().trim().min(1),
  sourcePersonId: z.string().trim().min(1),
  roleConflictByOpportunity: z.record(z.string().min(1), roleDecisionSchema),
}).strict();

export interface PersonMergeDecision {
  targetPersonId: string;
  sourcePersonId: string;
  roleConflictByOpportunity: Record<string, 'keep_target' | 'keep_source'>;
}

type Tx = Prisma.TransactionClient;
type RedirectCounts = Record<string, number>;

export interface PersonMergeReceipt {
  sourcePersonId: string;
  targetPersonId: string;
  redirected: RedirectCounts;
  deleted: { oppRoles: number; opportunityMembers: number; matterParticipants: number; edgeSelfLoops: number; edgeDuplicates: number; reminders: number };
  roleConflictByOpportunity: PersonMergeDecision['roleConflictByOpportunity'];
}

export interface PersonMergePreview {
  accountId: string;
  targetPerson: { id: string; name: string; title: string };
  sourcePerson: { id: string; name: string; title: string };
  conflicts: Array<{
    opportunityId: string;
    opportunityName: string;
    archived: boolean;
    targetRole: { role: string; sentiment: string; confidence: string };
    sourceRole: { role: string; sentiment: string; confidence: string };
  }>;
}

class MergeInputError extends Error {
  readonly statusCode = 400;
}
class MergeNotFoundError extends Error {
  readonly statusCode = 404;
}
class MergeVersionConflictError extends Error {
  readonly statusCode = 409;
  constructor() { super('人物已被其他操作修改，请刷新后重试'); }
}

interface PersonMergeTestHooks {
  beforeTargetCas?: () => Promise<unknown>;
  beforeArchiveCas?: () => Promise<unknown>;
  afterReferenceWrites?: () => Promise<unknown>;
}

const parseObject = (raw: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed as Record<string, unknown>;
  } catch { throw new MergeInputError('人物 FORM 数据格式异常，无法安全合并'); }
};

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && !Array.isArray(value) && typeof value === 'object';
const isMissingFormValue = (value: unknown) => value === undefined || value === null || value === '';

const mergeMissingFormValues = (source: unknown, target: unknown): unknown => {
  if (isMissingFormValue(target)) return source;
  if (!isRecord(source) || !isRecord(target)) return target;
  const result: Record<string, unknown> = {};
  for (const key of [...new Set([...Object.keys(source), ...Object.keys(target)])]) {
    result[key] = mergeMissingFormValues(source[key], target[key]);
  }
  return result;
};

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
};

const parseLogs = (raw: string): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new MergeInputError('人物日志数据格式异常，无法安全合并'); }
};

const mergedLogs = (targetRaw: string, sourceRaw: string): unknown[] => {
  const result: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of [...parseLogs(targetRaw), ...parseLogs(sourceRaw)]) {
    const key = JSON.stringify(canonical(entry));
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
};

const edgeKey = (edge: {
  opportunityId: string | null; source: string; target: string; layer: string; label: string;
  kind: string;
  color: string | null; style: string | null; width: number | null; directed: boolean;
  origin: string; shape: string | null; bend: number | null;
}) => JSON.stringify([
  edge.opportunityId, edge.source, edge.target, edge.kind, edge.layer, edge.label, edge.color, edge.style,
  edge.width, edge.directed, edge.origin, edge.shape, edge.bend,
]);

const requireAccountOpportunity = (
  accountId: string,
  opportunityId: string | null | undefined,
  opportunityAccounts: Map<string, string>,
) => {
  if (opportunityId && opportunityAccounts.get(opportunityId) !== accountId) throw new MergeNotFoundError('引用父树异常');
};

async function requireFullMergeAccount(
  ctx: CommandContext,
  ids: { targetPersonId: string; sourcePersonId: string },
  db: Tx | typeof prisma,
): Promise<string> {
  const scope = await resolveEffectiveResourceScope(db, {
    tenantId: ctx.tenantId,
    userId: ctx.actorId,
    role: ctx.actorRole,
  });
  if (scope.actorRole === 'viewer') throw new MergeNotFoundError('人物不存在或无权限');
  const parents = await db.person.findMany({
    where: { tenantId: ctx.tenantId, id: { in: [ids.targetPersonId, ids.sourcePersonId] }, archivedAt: null },
    select: { id: true, accountId: true },
  });
  const target = parents.find((person) => person.id === ids.targetPersonId);
  const source = parents.find((person) => person.id === ids.sourcePersonId);
  if (!target || !source || target.accountId !== source.accountId || !scope.canReadAccountData(target.accountId)) {
    throw new MergeNotFoundError('人物不存在或不属于可管理客户');
  }
  return target.accountId;
}

export async function previewPersonMerge(
  ctx: CommandContext,
  ids: Pick<PersonMergeDecision, 'targetPersonId' | 'sourcePersonId'>,
  db: Tx | typeof prisma = prisma,
): Promise<PersonMergePreview> {
  if (ids.sourcePersonId === ids.targetPersonId) throw new MergeInputError('源人物和目标人物必须不同');
  const accountId = await requireFullMergeAccount(ctx, ids, db);
  const persons = await db.person.findMany({
    where: { tenantId: ctx.tenantId, accountId, id: { in: [ids.targetPersonId, ids.sourcePersonId] }, archivedAt: null },
    select: { id: true, accountId: true, name: true, title: true },
  });
  const targetPerson = persons.find((person) => person.id === ids.targetPersonId);
  const sourcePerson = persons.find((person) => person.id === ids.sourcePersonId);
  if (!targetPerson || !sourcePerson || targetPerson.accountId !== sourcePerson.accountId) throw new MergeNotFoundError('人物不存在或不属于同一客户');
  const account = await db.account.findFirst({ where: { id: targetPerson.accountId, tenantId: ctx.tenantId, archivedAt: null }, select: { id: true } });
  if (!account) throw new MergeNotFoundError('客户不存在');
  const opportunities = await db.opportunity.findMany({
    where: { tenantId: ctx.tenantId, accountId: account.id },
    select: { id: true, accountId: true, name: true, archivedAt: true },
  });
  const opportunityById = new Map(opportunities.map((opportunity) => [opportunity.id, opportunity]));
  const roles = await db.oppRole.findMany({
    where: { tenantId: ctx.tenantId, personId: { in: [targetPerson.id, sourcePerson.id] } },
    select: { opportunityId: true, personId: true, role: true, sentiment: true, confidence: true },
  });
  for (const role of roles) {
    if (opportunityById.get(role.opportunityId)?.accountId !== account.id) throw new MergeNotFoundError('引用父树异常');
  }
  const targetRoles = new Map(roles.filter((role) => role.personId === targetPerson.id).map((role) => [role.opportunityId, role]));
  const sourceRoles = new Map(roles.filter((role) => role.personId === sourcePerson.id).map((role) => [role.opportunityId, role]));
  const conflicts = [...sourceRoles.keys()].filter((opportunityId) => targetRoles.has(opportunityId)).sort().map((opportunityId) => {
    const opportunity = opportunityById.get(opportunityId)!;
    const targetRole = targetRoles.get(opportunityId)!;
    const sourceRole = sourceRoles.get(opportunityId)!;
    return {
      opportunityId,
      opportunityName: opportunity.name,
      archived: opportunity.archivedAt !== null,
      targetRole: { role: targetRole.role, sentiment: targetRole.sentiment, confidence: targetRole.confidence },
      sourceRole: { role: sourceRole.role, sentiment: sourceRole.sentiment, confidence: sourceRole.confidence },
    };
  });
  return {
    accountId: account.id,
    targetPerson: { id: targetPerson.id, name: targetPerson.name, title: targetPerson.title },
    sourcePerson: { id: sourcePerson.id, name: sourcePerson.name, title: sourcePerson.title },
    conflicts,
  };
}

export async function executePersonMerge(
  ctx: CommandContext,
  input: PersonMergeDecision,
  tx: Tx,
  hooks: PersonMergeTestHooks = {},
): Promise<PersonMergeReceipt> {
  if (input.sourcePersonId === input.targetPersonId) throw new MergeInputError('源人物和目标人物必须不同');
  const accountId = await requireFullMergeAccount(ctx, input, tx);
  const persons = await tx.person.findMany({
    where: { tenantId: ctx.tenantId, accountId, id: { in: [input.targetPersonId, input.sourcePersonId] }, archivedAt: null },
  });
  const target = persons.find((person) => person.id === input.targetPersonId);
  const source = persons.find((person) => person.id === input.sourcePersonId);
  if (!target || !source || target.accountId !== source.accountId) throw new MergeNotFoundError('人物不存在或不属于同一客户');
  const account = await tx.account.findFirst({ where: { id: target.accountId, tenantId: ctx.tenantId, archivedAt: null }, select: { id: true } });
  if (!account) throw new MergeNotFoundError('客户不存在');

  const opportunities = await tx.opportunity.findMany({
    where: { tenantId: ctx.tenantId, accountId: account.id }, select: { id: true, accountId: true },
  });
  const opportunityAccounts = new Map(opportunities.map((item) => [item.id, item.accountId]));
  const roles = await tx.oppRole.findMany({
    where: { tenantId: ctx.tenantId, personId: { in: [target.id, source.id] } }, orderBy: { id: 'asc' },
  });
  for (const role of roles) requireAccountOpportunity(account.id, role.opportunityId, opportunityAccounts);
  const targetRoles = new Map(roles.filter((role) => role.personId === target.id).map((role) => [role.opportunityId, role]));
  const sourceRoles = new Map(roles.filter((role) => role.personId === source.id).map((role) => [role.opportunityId, role]));
  const conflicts = [...sourceRoles.keys()].filter((opportunityId) => targetRoles.has(opportunityId)).sort();
  const decisionKeys = Object.keys(input.roleConflictByOpportunity).sort();
  if (JSON.stringify(conflicts) !== JSON.stringify(decisionKeys)) {
    throw new MergeInputError('每个实际角色冲突都必须提供且仅提供一个明确决策');
  }

  const [members, participants, edges, burningIssues, evidenceEvents, notes, planActions, strategyCards, transcripts, advisorMsgs,
    relSuggestions, personSuggestions, changeProposals, reminders] = await Promise.all([
    tx.opportunityMember.findMany({ where: { tenantId: ctx.tenantId, personId: { in: [target.id, source.id] } }, orderBy: { id: 'asc' } }),
    tx.matterParticipant.findMany({ where: { tenantId: ctx.tenantId, personId: { in: [target.id, source.id] } }, orderBy: { id: 'asc' } }),
    tx.edge.findMany({ where: { tenantId: ctx.tenantId, OR: [
      { accountId: account.id }, { source: source.id }, { target: source.id },
    ] }, orderBy: { id: 'asc' } }),
    tx.burningIssue.findMany({ where: { tenantId: ctx.tenantId, personId: source.id }, select: { id: true, opportunityId: true } }),
    tx.evidenceEvent.findMany({ where: { tenantId: ctx.tenantId, personId: source.id }, select: { id: true, accountId: true, opportunityId: true } }),
    tx.note.findMany({ where: { tenantId: ctx.tenantId, personId: source.id }, select: { id: true, accountId: true, opportunityId: true } }),
    tx.planAction.findMany({ where: { tenantId: ctx.tenantId, personId: source.id }, select: { id: true, accountId: true, opportunityId: true } }),
    tx.strategyCard.findMany({ where: { tenantId: ctx.tenantId, personId: source.id }, select: { id: true, accountId: true, opportunityId: true } }),
    tx.transcript.findMany({ where: { tenantId: ctx.tenantId, personId: source.id }, select: { id: true, accountId: true, opportunityId: true } }),
    tx.advisorMsg.findMany({ where: { tenantId: ctx.tenantId, personId: source.id }, select: { id: true, accountId: true, opportunityId: true } }),
    tx.relSuggestion.findMany({ where: { tenantId: ctx.tenantId, OR: [
      { sourceKind: 'person', sourcePersonId: source.id }, { targetKind: 'person', targetPersonId: source.id },
    ] } }),
    tx.personSuggestion.findMany({ where: { tenantId: ctx.tenantId, resolvedPersonId: source.id }, select: { id: true, accountId: true, opportunityId: true } }),
    tx.changeProposal.findMany({ where: {
      tenantId: ctx.tenantId, entityKind: { in: ['person', 'personLog', 'oppRole'] }, entityId: { in: [target.id, source.id] },
    }, select: {
      id: true, accountId: true, opportunityId: true, entityKind: true, entityId: true, field: true, status: true, dedupeKey: true,
    }, orderBy: { id: 'asc' } }),
    tx.reminder.findMany({ where: {
      tenantId: ctx.tenantId, kind: { in: ['sentiment_recheck', 'form_empty'] }, entityId: { in: [target.id, source.id] },
    }, select: { id: true, accountId: true, opportunityId: true, entityId: true, kind: true } }),
  ]);

  for (const member of members) requireAccountOpportunity(account.id, member.opportunityId, opportunityAccounts);
  for (const participant of participants) {
    if (participant.accountId !== account.id) throw new MergeNotFoundError('引用客户异常');
    requireAccountOpportunity(account.id, participant.opportunityId, opportunityAccounts);
  }
  for (const edge of edges) {
    if (edge.accountId !== account.id) throw new MergeNotFoundError('引用客户异常');
    requireAccountOpportunity(account.id, edge.opportunityId, opportunityAccounts);
  }
  const edgeEndpointIds = [...new Set(edges.flatMap((edge) => [edge.source, edge.target]))];
  const edgeEndpointPersons = edgeEndpointIds.length ? await tx.person.findMany({
    where: { tenantId: ctx.tenantId, id: { in: edgeEndpointIds }, ...activePersonWhere },
    select: { id: true, accountId: true },
  }) : [];
  const validEdgeEndpoints = new Set(edgeEndpointPersons
    .filter((person) => person.accountId === account.id)
    .map((person) => person.id));
  if (edges.some((edge) => !validEdgeEndpoints.has(edge.source) || !validEdgeEndpoints.has(edge.target))) {
    throw new MergeNotFoundError('关系端点父树异常');
  }
  for (const row of burningIssues) requireAccountOpportunity(account.id, row.opportunityId, opportunityAccounts);
  for (const row of [...evidenceEvents, ...planActions, ...strategyCards, ...advisorMsgs]) {
    if (row.accountId !== account.id) throw new MergeNotFoundError('引用客户异常');
    requireAccountOpportunity(account.id, row.opportunityId, opportunityAccounts);
  }
  for (const row of [...notes, ...transcripts, ...personSuggestions]) {
    if (row.accountId !== account.id) throw new MergeNotFoundError('引用客户异常');
    requireAccountOpportunity(account.id, row.opportunityId, opportunityAccounts);
  }
  for (const row of relSuggestions) requireAccountOpportunity(account.id, row.opportunityId, opportunityAccounts);
  const scopedRelSuggestions = await resolveScopedRelSuggestions(tx, ctx.tenantId, relSuggestions);
  if (scopedRelSuggestions.length !== relSuggestions.length) throw new MergeNotFoundError('关系候选端点父树异常');
  for (const row of changeProposals) {
    if (row.accountId !== account.id) throw new MergeNotFoundError('引用客户异常');
    if (row.entityKind === 'oppRole' && !row.opportunityId) throw new MergeNotFoundError('引用父树异常');
    requireAccountOpportunity(account.id, row.opportunityId, opportunityAccounts);
  }
  for (const row of reminders) {
    if (row.accountId !== account.id || !row.opportunityId) throw new MergeNotFoundError('引用父树异常');
    requireAccountOpportunity(account.id, row.opportunityId, opportunityAccounts);
  }

  await hooks.beforeTargetCas?.();
  const targetCas = await tx.person.updateMany({ where: {
    id: target.id, tenantId: ctx.tenantId, accountId: account.id, archivedAt: null, version: target.version,
  }, data: {
    form: JSON.stringify(mergeMissingFormValues(parseObject(source.form), parseObject(target.form))),
    logs: JSON.stringify(mergedLogs(target.logs, source.logs)),
    version: { increment: 1 },
  } });
  if (targetCas.count !== 1) throw new MergeVersionConflictError();

  let deletedOppRoles = 0;
  let redirectedOppRoles = 0;
  for (const [opportunityId, sourceRole] of sourceRoles) {
    const targetRole = targetRoles.get(opportunityId);
    if (!targetRole) {
      await tx.oppRole.update({ where: { id: sourceRole.id }, data: { personId: target.id } });
      redirectedOppRoles += 1;
    } else if (input.roleConflictByOpportunity[opportunityId] === 'keep_target') {
      await tx.oppRole.delete({ where: { id: sourceRole.id } });
      deletedOppRoles += 1;
    } else {
      await tx.oppRole.delete({ where: { id: targetRole.id } });
      await tx.oppRole.update({ where: { id: sourceRole.id }, data: { personId: target.id } });
      deletedOppRoles += 1;
      redirectedOppRoles += 1;
    }
  }

  const primaryDOpportunities = await tx.opportunity.findMany({
    where: {
      tenantId: ctx.tenantId,
      accountId: account.id,
      primaryDPersonId: { in: [source.id, target.id] },
    },
    select: { id: true },
  });
  if (primaryDOpportunities.length) {
    const opportunityIds = primaryDOpportunities.map((opportunity) => opportunity.id);
    const finalTargetDRoles = await tx.oppRole.findMany({
      where: { tenantId: ctx.tenantId, opportunityId: { in: opportunityIds }, personId: target.id, role: 'D' },
      select: { opportunityId: true },
    });
    const targetIsD = new Set(finalTargetDRoles.map((role) => role.opportunityId));
    for (const opportunity of primaryDOpportunities) {
      await tx.opportunity.updateMany({
        where: { id: opportunity.id, tenantId: ctx.tenantId, accountId: account.id, primaryDPersonId: { in: [source.id, target.id] } },
        data: { primaryDPersonId: targetIsD.has(opportunity.id) ? target.id : null },
      });
    }
  }

  let deletedMembers = 0;
  let redirectedMembers = 0;
  const targetMemberOpps = new Set(members.filter((row) => row.personId === target.id).map((row) => row.opportunityId));
  for (const member of members.filter((row) => row.personId === source.id)) {
    if (targetMemberOpps.has(member.opportunityId)) {
      await tx.opportunityMember.delete({ where: { id: member.id } });
      deletedMembers += 1;
    } else {
      await tx.opportunityMember.update({ where: { id: member.id }, data: { personId: target.id } });
      redirectedMembers += 1;
    }
  }

  let deletedParticipants = 0;
  let redirectedParticipants = 0;
  const targetParticipantOpps = new Set(participants
    .filter((row) => row.personId === target.id)
    .map((row) => row.opportunityId));
  for (const participant of participants.filter((row) => row.personId === source.id)) {
    if (targetParticipantOpps.has(participant.opportunityId)) {
      await tx.matterParticipant.delete({ where: { id: participant.id } });
      deletedParticipants += 1;
    } else {
      await tx.matterParticipant.update({ where: { id: participant.id }, data: { personId: target.id } });
      redirectedParticipants += 1;
    }
  }

  const projectedEdges = edges.map((edge) => ({
    ...edge,
    redirectedFromSource: edge.source === source.id || edge.target === source.id,
    source: edge.source === source.id ? target.id : edge.source,
    target: edge.target === source.id ? target.id : edge.target,
  })).sort((left, right) => Number(left.redirectedFromSource) - Number(right.redirectedFromSource) || left.id.localeCompare(right.id));
  const deleteEdgeIds = new Set(projectedEdges
    .filter((edge) => edge.redirectedFromSource && edge.source === edge.target)
    .map((edge) => edge.id));
  const seenEdges = new Map<string, string>();
  for (const edge of projectedEdges) {
    if (deleteEdgeIds.has(edge.id)) continue;
    const key = edgeKey(edge);
    const kept = seenEdges.get(key);
    if (kept && edge.redirectedFromSource) deleteEdgeIds.add(edge.id);
    else seenEdges.set(key, edge.id);
  }
  const selfLoopCount = projectedEdges.filter((edge) => edge.redirectedFromSource && edge.source === edge.target).length;
  const duplicateCount = deleteEdgeIds.size - selfLoopCount;
  if (deleteEdgeIds.size) await tx.edge.deleteMany({ where: { tenantId: ctx.tenantId, id: { in: [...deleteEdgeIds] } } });
  const edgeRedirect = await tx.edge.updateMany({
    where: { tenantId: ctx.tenantId, accountId: account.id, id: { notIn: [...deleteEdgeIds] }, source: source.id },
    data: { source: target.id, version: { increment: 1 } },
  });
  const edgeTargetRedirect = await tx.edge.updateMany({
    where: { tenantId: ctx.tenantId, accountId: account.id, id: { notIn: [...deleteEdgeIds] }, target: source.id },
    data: { target: target.id, version: { increment: 1 } },
  });

  const updateMany = async (model: { updateMany: (args: any) => Promise<{ count: number }> }, where: object, data: object) =>
    (await model.updateMany({ where, data })).count;
  let deletedReminders = 0;
  let redirectedReminders = 0;
  const targetReminderKeys = new Set(reminders.filter((row) => row.entityId === target.id)
    .map((row) => `${row.opportunityId ?? ''}\u0000${row.kind}`));
  for (const reminder of reminders.filter((row) => row.entityId === source.id)) {
    const key = `${reminder.opportunityId ?? ''}\u0000${reminder.kind}`;
    if (targetReminderKeys.has(key)) {
      await tx.reminder.delete({ where: { id: reminder.id } });
      deletedReminders += 1;
      continue;
    }
    await tx.reminder.update({ where: { id: reminder.id }, data: {
      entityId: target.id,
      dedupeKey: `${reminder.opportunityId ?? ''}:${reminder.kind}:${target.id}`,
    } });
    redirectedReminders += 1;
  }
  let redirectedChangeProposals = 0;
  let rejectedStaleRoleProposals = 0;
  const claimedProposalKeys = new Set<string>();
  const proposalKey = (proposal: { entityKind: string; field: string }) =>
    JSON.stringify([ctx.tenantId, account.id, proposal.entityKind, target.id, proposal.field]);
  const proposalWins = (proposal: typeof changeProposals[number]): boolean => {
    if (proposal.entityKind !== 'oppRole' || !proposal.opportunityId) return true;
    const hasTarget = targetRoles.has(proposal.opportunityId);
    const hasSource = sourceRoles.has(proposal.opportunityId);
    if (hasTarget && hasSource) {
      const winner = input.roleConflictByOpportunity[proposal.opportunityId] === 'keep_source' ? source.id : target.id;
      return proposal.entityId === winner;
    }
    if (hasSource) return proposal.entityId === source.id;
    return proposal.entityId === target.id;
  };
  const orderedProposals = [...changeProposals].sort((left, right) => {
    const leftWinner = proposalWins(left);
    const rightWinner = proposalWins(right);
    if (leftWinner !== rightWinner) return leftWinner ? -1 : 1;
    const leftTarget = left.entityId === target.id;
    const rightTarget = right.entityId === target.id;
    if (leftTarget !== rightTarget) return leftTarget ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
  if (orderedProposals.length) {
    await tx.changeProposal.updateMany({ where: { id: { in: orderedProposals.map((proposal) => proposal.id) } }, data: { dedupeKey: null } });
  }
  for (const proposal of orderedProposals) {
    const sourceBacked = proposal.entityId === source.id;
    if (sourceBacked) redirectedChangeProposals += 1;
    if (proposal.status !== 'pending') {
      await tx.changeProposal.update({ where: { id: proposal.id }, data: { entityId: target.id, dedupeKey: null } });
      continue;
    }
    if (!proposalWins(proposal)) {
      await tx.changeProposal.update({ where: { id: proposal.id }, data: { entityId: target.id, status: 'rejected', dedupeKey: null } });
      rejectedStaleRoleProposals += 1;
      continue;
    }
    const key = proposalKey(proposal);
    const dedupeKey = claimedProposalKeys.has(key) ? null : key;
    claimedProposalKeys.add(key);
    await tx.changeProposal.update({ where: { id: proposal.id }, data: { entityId: target.id, dedupeKey } });
  }
  const candidateRedirects = await redirectCandidatePersonReferences(tx, {
    tenantId: ctx.tenantId,
    accountId: account.id,
    from: { kind: 'person', id: source.id },
    toPersonId: target.id,
  });
  const redirected: RedirectCounts = {
    oppRoles: redirectedOppRoles,
    opportunityMembers: redirectedMembers,
    matterParticipants: redirectedParticipants,
    edges: edgeRedirect.count + edgeTargetRedirect.count,
    burningIssues: await updateMany(tx.burningIssue, { tenantId: ctx.tenantId, personId: source.id }, { personId: target.id }),
    evidenceEvents: await updateMany(tx.evidenceEvent, { tenantId: ctx.tenantId, personId: source.id }, { personId: target.id }),
    notes: await updateMany(tx.note, { tenantId: ctx.tenantId, personId: source.id }, { personId: target.id }),
    planActions: await updateMany(tx.planAction, { tenantId: ctx.tenantId, personId: source.id }, {
      personId: target.id,
      version: { increment: 1 },
    }),
    strategyCards: await updateMany(tx.strategyCard, { tenantId: ctx.tenantId, personId: source.id }, { personId: target.id }),
    transcripts: await updateMany(tx.transcript, { tenantId: ctx.tenantId, personId: source.id }, { personId: target.id }),
    advisorMsgs: await updateMany(tx.advisorMsg, { tenantId: ctx.tenantId, personId: source.id }, { personId: target.id }),
    relSuggestionSources: candidateRedirects.relationSources,
    relSuggestionTargets: candidateRedirects.relationTargets,
    personSuggestions: candidateRedirects.resolvedPersons,
    changeProposals: redirectedChangeProposals,
    staleRoleProposalsRejected: rejectedStaleRoleProposals,
    reminders: redirectedReminders,
  };

  const archivedAt = new Date();
  await hooks.afterReferenceWrites?.();
  await hooks.beforeArchiveCas?.();
  const archived = await tx.person.updateMany({
    where: { id: source.id, tenantId: ctx.tenantId, accountId: account.id, archivedAt: null, version: source.version },
    data: { archivedAt, archivedBy: ctx.actorId, archiveReason: 'merged_duplicate', mergedIntoPersonId: target.id, version: { increment: 1 } },
  });
  if (archived.count !== 1) throw new MergeVersionConflictError();
  const receipt: PersonMergeReceipt = {
    sourcePersonId: source.id,
    targetPersonId: target.id,
    redirected,
    deleted: {
      oppRoles: deletedOppRoles,
      opportunityMembers: deletedMembers,
      matterParticipants: deletedParticipants,
      edgeSelfLoops: selfLoopCount,
      edgeDuplicates: duplicateCount,
      reminders: deletedReminders,
    },
    roleConflictByOpportunity: input.roleConflictByOpportunity,
  };
  await tx.auditEvent.create({ data: {
    id: randomUUID(), tenantId: ctx.tenantId, actorId: ctx.actorId, channel: ctx.channel,
    action: 'person_merge', entityKind: 'person', entityId: target.id, sourceRef: source.id,
    changedFields: JSON.stringify(['form', 'logs', 'references', 'archivedAt']),
    metadata: JSON.stringify(receipt),
  } });
  return receipt;
}

const commandContext = (req: any): CommandContext => ({
  tenantId: req.user.tenantId,
  actorId: req.user.userId,
  actorRole: ActorRoleSchema.parse(req.user.role),
  channel: 'web',
  requestId: req.id,
  assertionMode: 'user_asserted',
});

export function personMergeHttpError(error: unknown, fallback: string): {
  statusCode: number;
  body: { error: string; code?: string };
  unexpected: boolean;
} {
  const value = error && typeof error === 'object' ? error as { statusCode?: unknown; code?: unknown; message?: unknown } : {};
  if (typeof value.statusCode !== 'number') return { statusCode: 500, body: { error: fallback }, unexpected: true };
  return {
    statusCode: value.statusCode,
    body: {
      error: typeof value.message === 'string' ? value.message : fallback,
      ...(typeof value.code === 'string' ? { code: value.code } : {}),
    },
    unexpected: false,
  };
}

export function personMergeRoutes(app: FastifyInstance): void {
  app.get('/api/repair/person-merge/preview', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!['owner', 'admin', 'member'].includes(req.user.role)) return reply.code(403).send({ error: '权限不足' });
    const query = z.object({ targetPersonId: z.string().min(1), sourcePersonId: z.string().min(1) }).strict().safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: '人物合并预览参数无效' });
    try { return await previewPersonMerge(commandContext(req), query.data, prisma); }
    catch (error) {
      const mapped = personMergeHttpError(error, '人物合并预览失败');
      if (mapped.unexpected) req.log.warn(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });

  app.post('/api/repair/person-merge', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    if (!['owner', 'admin', 'member'].includes(req.user.role)) return reply.code(403).send({ error: '权限不足' });
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) return reply.code(400).send({ error: '缺少有效的 Idempotency-Key' });
    const parsed = PersonMergeDecisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '人物合并参数无效' });
    try {
      const command = await runCommand<PersonMergeReceipt>(
        commandContext(req),
        { kind: 'person-merge', idempotencyKey: key, payload: parsed.data },
        (tx) => executePersonMerge(commandContext(req), parsed.data, tx),
        prisma,
      );
      return command.result;
    } catch (error) {
      const mapped = personMergeHttpError(error, '人物合并失败');
      if (mapped.unexpected || mapped.statusCode >= 500) req.log.warn(error);
      return reply.code(mapped.statusCode).send(mapped.body);
    }
  });
}
