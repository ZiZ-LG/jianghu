import { randomUUID } from 'node:crypto';
import {
  CommandContextSchema, PersonalWorkbenchCommandSchema, PersonalWorkbenchDetailSchema, PersonalWorkbenchListSchema,
  capabilityPolicyAllows, IntelligenceItemCreateInputSchema, SalesHypothesisListQuerySchema, StakeholderFocusListQuerySchema,
  type CapabilityPolicy, type CommandContext, type PersonalWorkbenchCommand, type PersonalWorkbenchReceipt,
} from '@jianghu/domain-contracts';
import type { DbClient } from '../mutation/scopeGuards.js';
import { buildCrmContextSnapshot } from '../crmContext.js';
import { resolveEffectiveResourceScope } from '../resourceScope.js';
import { relationshipWorkspace } from '../relationshipWorkspace/service.js';
import { executeIntelligenceItemCommand, intelligenceItemDetail, listStakeholderFocuses } from '../intelligenceFocus/service.js';
import { listSalesHypotheses } from '../hypotheses/service.js';
import { commitmentFromPlanAction } from '../commitment/view.js';
import { mapLegacyOpportunityStatus } from '../matter/lifecycle.js';
import { createPdeDecisionContext } from '../pde/context.js';

export class PersonalWorkbenchError extends Error {
  constructor(readonly code: string, readonly statusCode = 409) { super(code); }
}
function missing(): never { throw new PersonalWorkbenchError('personal_workbench_not_found', 404); }
function conflict(): never { throw new PersonalWorkbenchError('personal_workbench_version_conflict'); }
const principal = (ctx: CommandContext) => ({ tenantId: ctx.tenantId, userId: ctx.actorId, role: ctx.actorRole });

async function scopeFor(db: DbClient, ctx: CommandContext, policy: CapabilityPolicy, write = false) {
  CommandContextSchema.parse(ctx);
  if (!capabilityPolicyAllows(policy, { entitlement: 'crm.core' })) throw new PersonalWorkbenchError('capability_denied', 403);
  const scope = await resolveEffectiveResourceScope(db, principal(ctx));
  if (!scope.valid) missing();
  if (write) {
    if (scope.actorRole === 'viewer' || ctx.channel !== 'web' || ctx.assertionMode !== 'user_asserted') {
      throw new PersonalWorkbenchError('human_write_required', 403);
    }
    // Lock both current role and current policy in the transaction that performs the write/replay.
    const actor = await db.user.updateMany({ where: { id: ctx.actorId, tenantId: ctx.tenantId, role: scope.actorRole }, data: { role: scope.actorRole } });
    const tenant = await db.tenant.updateMany({ where: { id: ctx.tenantId, dataScopePolicy: scope.policy }, data: { dataScopePolicy: scope.policy } });
    if (actor.count !== 1 || tenant.count !== 1) missing();
  }
  return scope;
}

async function participant(db: DbClient, ctx: CommandContext, input: { customerId: string; matterId: string; personId: string }) {
  const row = await db.matterParticipant.findFirst({ where: {
    tenantId: ctx.tenantId, accountId: input.customerId, opportunityId: input.matterId, personId: input.personId,
    person: { tenantId: ctx.tenantId, accountId: input.customerId, archivedAt: null, mergedIntoPersonId: null },
  } });
  if (!row) missing();
  return row;
}

async function readableBasis(db: DbClient, ctx: CommandContext, policy: CapabilityPolicy,
  input: { customerId: string; matterId: string; personId: string }, basis: { id: string; version: number }) {
  const detail = await intelligenceItemDetail(db, ctx, policy, basis.id);
  const item = detail?.item;
  return item && item.customerId === input.customerId && item.matterId === input.matterId
    && item.status === 'active' && item.version === basis.version
    && item.targets.some(target => target.kind === 'person' && target.id === input.personId) ? item : null;
}

export async function assertPersonalCommandAccess(db: DbClient, ctx: CommandContext, policy: CapabilityPolicy, input: PersonalWorkbenchCommand) {
  const scope = await scopeFor(db, ctx, policy, true);
  if (input.type === 'CREATE_PERSONAL_MATTER' ? !scope.canReadAccountData(input.customerId) : !scope.canReadMatter(input.matterId)) missing();
  const account = await db.account.findFirst({ where: { id: input.customerId, tenantId: ctx.tenantId, archivedAt: null } });
  if (!account) missing();
  const locked = await db.account.updateMany({ where: {
    id: account.id, tenantId: ctx.tenantId, archivedAt: null, primaryOwnerUserId: account.primaryOwnerUserId, version: account.version,
  }, data: { version: { increment: 0 } } });
  if (locked.count !== 1) missing();
  if (input.type !== 'CREATE_PERSONAL_MATTER') {
    const row = await db.opportunity.findFirst({ where: { id: input.matterId, tenantId: ctx.tenantId, accountId: input.customerId, archivedAt: null } });
    if (!row) missing();
    const matterLock = await db.opportunity.updateMany({ where: {
      id: row.id, tenantId: ctx.tenantId, accountId: account.id, archivedAt: null, primaryOwnerUserId: row.primaryOwnerUserId, version: row.version,
    }, data: { version: { increment: 0 } } });
    if (matterLock.count !== 1) missing();
  }
  if (input.type === 'JOIN_MATTER_PERSON') {
    const person = await db.person.findFirst({ where: {
      id: input.personId, tenantId: ctx.tenantId, accountId: input.customerId, archivedAt: null, mergedIntoPersonId: null,
      ...(scope.canReadAccountData(input.customerId) ? {} : { matterParticipants: { some: {
        tenantId: ctx.tenantId, accountId: input.customerId, opportunityId: { in: [...scope.matterIds] },
      } } }),
    }, select: { id: true } });
    if (!person) missing();
  }
  if (input.type === 'SET_PERSON_DECISION_ROLE') {
    await participant(db, ctx, input);
    if (input.basis && !await readableBasis(db, ctx, policy, input, input.basis)) {
      throw new PersonalWorkbenchError('role_basis_needs_review');
    }
  }
  if (input.type === 'CREATE_PERSONAL_RELATION') {
    if (input.sourcePersonId === input.targetPersonId) throw new PersonalWorkbenchError('relation_endpoints_invalid', 400);
    await participant(db, ctx, { ...input, personId: input.sourcePersonId });
    await participant(db, ctx, { ...input, personId: input.targetPersonId });
    if (input.basis.assertionType === 'observed' && input.basis.occurredAt === null) {
      throw new PersonalWorkbenchError('observed_time_required', 400);
    }
    if (input.basis.occurredAt && new Date(input.basis.occurredAt) > new Date()) throw new PersonalWorkbenchError('source_time_invalid', 400);
  }
}

export async function executePersonalCommand(db: DbClient, ctx: CommandContext, policy: CapabilityPolicy, raw: PersonalWorkbenchCommand): Promise<Omit<PersonalWorkbenchReceipt, 'replayed'>> {
  const input = PersonalWorkbenchCommandSchema.parse(raw);
  await assertPersonalCommandAccess(db, ctx, policy, input);
  let entityId: string = input.matterId;
  let entityVersion = 0;
  let changedFields: string[] = [];
  if (input.type === 'CREATE_PERSONAL_MATTER') {
    const account = await db.account.findFirstOrThrow({ where: { id: input.customerId, tenantId: ctx.tenantId } });
    await db.opportunity.create({ data: {
      id: input.matterId, tenantId: ctx.tenantId, accountId: account.id,
      name: input.title, customerBusinessGoal: input.customerBusinessGoal, salesProgress: input.salesProgress, priority: input.priority,
      primaryOwnerUserId: ctx.actorId, kind: 'sales_opportunity', customerType: account.customerType ?? 0,
      pipelineStage: '线索', engageStage: '需求调研立项', memberScoped: true,
    } });
    // Existing initialization requires one context per Opportunity. This neutral
    // compatibility row does not install a methodology, run a score, or own salesProgress.
    await createPdeDecisionContext(db, { tenantId: ctx.tenantId, opportunityId: input.matterId });
    changedFields = ['name', 'customerBusinessGoal', 'salesProgress', 'priority', 'primaryOwnerUserId'];
  } else if (input.type === 'UPDATE_PERSONAL_MATTER') {
    const { title, lifecycle, ...fields } = input.patch;
    const update = await db.opportunity.updateMany({ where: {
      id: input.matterId, tenantId: ctx.tenantId, accountId: input.customerId, archivedAt: null, version: input.baseVersion,
    }, data: { ...fields, ...(title !== undefined ? { name: title } : {}),
      ...(lifecycle ? { status: lifecycle, ...mapLegacyOpportunityStatus(lifecycle) } : {}), version: { increment: 1 },
    } });
    if (update.count !== 1) conflict();
    entityVersion = input.baseVersion + 1;
    changedFields = Object.keys(input.patch);
  } else if (input.type === 'CREATE_MATTER_PERSON') {
    await db.person.create({ data: { id: input.personId, tenantId: ctx.tenantId, accountId: input.customerId, name: input.name, title: input.title } });
    await db.matterParticipant.create({ data: {
      tenantId: ctx.tenantId, accountId: input.customerId, opportunityId: input.matterId, personId: input.personId, decisionRole: input.decisionRole,
    } });
    entityId = input.personId;
    changedFields = ['name', 'title', 'participating', 'decisionRole'];
  } else if (input.type === 'JOIN_MATTER_PERSON') {
    const existing = await db.matterParticipant.findFirst({ where: {
      tenantId: ctx.tenantId, accountId: input.customerId, opportunityId: input.matterId, personId: input.personId,
    } });
    if (!existing) await db.matterParticipant.create({ data: { tenantId: ctx.tenantId, accountId: input.customerId, opportunityId: input.matterId, personId: input.personId } });
    entityId = input.personId;
    entityVersion = existing?.version ?? 0;
    changedFields = existing ? [] : ['participating'];
  } else if (input.type === 'SET_PERSON_DECISION_ROLE') {
    const updated = await db.matterParticipant.updateMany({ where: {
      tenantId: ctx.tenantId, accountId: input.customerId, opportunityId: input.matterId, personId: input.personId, version: input.baseVersion,
    }, data: { decisionRole: input.decisionRole, roleBasisId: input.basis?.id ?? null,
      roleBasisVersion: input.basis?.version ?? null, version: { increment: 1 },
    } });
    if (updated.count !== 1) conflict();
    entityId = input.personId;
    entityVersion = input.baseVersion + 1;
    changedFields = ['decisionRole', 'roleBasisId', 'roleBasisVersion'];
  } else {
    await db.edge.create({ data: { id: input.relationId, tenantId: ctx.tenantId, accountId: input.customerId, opportunityId: input.matterId,
      source: input.sourcePersonId, target: input.targetPersonId, label: input.label, directed: input.directed, kind: 'related', layer: 'L3', origin: 'manual',
    } });
    await executeIntelligenceItemCommand(db, ctx, policy, { type: 'CREATE_INTELLIGENCE_ITEM', item: IntelligenceItemCreateInputSchema.parse({
      id: `intel_${randomUUID()}`, customerId: input.customerId, matterId: input.matterId,
      assertionType: input.basis.assertionType, statement: input.basis.statement,
      source: { kind: 'manual', description: input.basis.sourceDescription, refId: null, refVersion: null },
      occurredAt: input.basis.occurredAt, learnedAt: new Date().toISOString(), confidence: 0.5,
      targets: [{ kind: 'relation', id: input.relationId }, { kind: 'person', id: input.sourcePersonId }, { kind: 'person', id: input.targetPersonId }],
    }) });
    entityId = input.relationId;
    changedFields = ['source', 'target', 'label', 'basis'];
  }
  if (changedFields.length > 0) await db.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`, tenantId: ctx.tenantId, actorId: ctx.actorId, channel: ctx.channel,
    action: input.type.toLowerCase(), entityKind: 'personal_workbench', entityId, requestId: ctx.requestId,
    sourceRef: null, changedFields: JSON.stringify(changedFields),
    metadata: JSON.stringify({ customerId: input.customerId, matterId: input.matterId, version: entityVersion }),
  } });
  return { type: input.type, customerId: input.customerId, matterId: input.matterId, entityId, version: entityVersion };
}

async function actions(db: DbClient, ctx: CommandContext, customerId: string, matterId: string, hypothesisIds: Set<string>) {
  const rows = await db.planAction.findMany({ where: {
    tenantId: ctx.tenantId, accountId: customerId, opportunityId: matterId, archivedAt: null, ownerUserId: ctx.actorId,
  }, orderBy: [{ scheduledAtUtc: 'asc' }, { id: 'asc' }] });
  return rows.filter(row => !row.hypothesisId || hypothesisIds.has(row.hypothesisId))
    .flatMap(row => { const value = commitmentFromPlanAction(row); return value ? [value] : []; });
}

export async function personalWorkbenchList(db: DbClient, ctx: CommandContext, policy: CapabilityPolicy) {
  const scope = await scopeFor(db, ctx, policy);
  const snapshot = await buildCrmContextSnapshot(principal(ctx), new Date(), db);
  const rows = await db.opportunity.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...scope.matterIds] }, archivedAt: null },
    select: { id: true, customerBusinessGoal: true, salesProgress: true } });
  const byId = new Map(rows.map(row => [row.id, row]));
  const entries = [];
  for (const matter of snapshot.matters) {
    const row = byId.get(matter.id);
    if (!row) missing();
    const query = { customerId: matter.customerId, matterId: matter.id };
    const [focus, hypotheses] = await Promise.all([
      listStakeholderFocuses(db, ctx, policy, StakeholderFocusListQuerySchema.parse({ ...query, includeRetired: false, limit: 2, cursor: null })),
      listSalesHypotheses(db, ctx, policy, SalesHypothesisListQuerySchema.parse({ ...query, includeRetired: false, limit: 50, cursor: null })),
    ]);
    const commitments = await actions(db, ctx, matter.customerId, matter.id, new Set(hypotheses.items.map(item => item.id)));
    entries.push({ matter, customerName: snapshot.customers.find(customer => customer.id === matter.customerId)?.name ?? '',
      customerBusinessGoal: row.customerBusinessGoal, salesProgress: row.salesProgress,
      keyGap: focus.items.find(item => item.status === 'active')?.evidenceGap ?? null,
      nextCommitment: commitments.find(action => action.executionStatus === 'planned') ?? null,
    });
  }
  return PersonalWorkbenchListSchema.parse({ generatedAtUtc: new Date().toISOString(), customers: snapshot.customers, entries });
}

export async function personalWorkbenchDetail(db: DbClient, ctx: CommandContext, policy: CapabilityPolicy, matterId: string) {
  const scope = await scopeFor(db, ctx, policy);
  if (!scope.canReadMatter(matterId)) missing();
  const row = await db.opportunity.findFirst({ where: { id: matterId, tenantId: ctx.tenantId, archivedAt: null } });
  if (!row) missing();
  const workspace = await relationshipWorkspace(db, ctx, policy, { customerId: row.accountId, matterId });
  const snapshot = await buildCrmContextSnapshot(principal(ctx), new Date(), db);
  const rows = await db.matterParticipant.findMany({ where: { tenantId: ctx.tenantId, accountId: row.accountId, opportunityId: matterId } });
  const participants = [];
  for (const person of rows) {
    const hasBasis = person.roleBasisId !== null || person.roleBasisVersion !== null;
    const basis = person.roleBasisId !== null && person.roleBasisVersion !== null ? { id: person.roleBasisId, version: person.roleBasisVersion } : null;
    const current = basis ? await readableBasis(db, ctx, policy, { customerId: row.accountId, matterId, personId: person.personId }, basis) : null;
    participants.push({ personId: person.personId, version: person.version, decisionRole: hasBasis && !current ? null : person.decisionRole,
      basis: current ? basis : null, basisState: hasBasis ? (current ? 'current' : 'needs_review') : 'unverified' });
  }
  return PersonalWorkbenchDetailSchema.parse({
    opportunity: { matter: workspace.matter, customerBusinessGoal: row.customerBusinessGoal, salesProgress: row.salesProgress }, workspace, participants,
    availablePeople: snapshot.people.filter(person => person.customerId === row.accountId),
    commitments: await actions(db, ctx, row.accountId, matterId, new Set(workspace.hypotheses.map(item => item.hypothesis.id))),
  });
}
