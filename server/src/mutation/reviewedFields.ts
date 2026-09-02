import { randomUUID } from 'node:crypto';
import {
  CrmCommandSchema,
  capabilityPolicyAllows,
  type CapabilityPolicy,
  type CommandContext,
  type CrmCommand,
} from '@jianghu/domain-contracts';
import type { ChangeProposal, Prisma } from '@prisma/client';
import { requireCandidateReviewAccess } from '../sensitiveAccess.js';

type ReviewedCommand = Extract<CrmCommand, { type: 'UPDATE_CUSTOMER' | 'UPDATE_MATTER' }>;

export interface ReviewedFieldPreparation {
  proposal: ChangeProposal;
  command: ReviewedCommand;
  encodedValue: string;
}

function decode(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function supported(entityKind: string, field: string): boolean {
  return entityKind === 'customer'
    ? ['name', 'categoryKey'].includes(field)
    : entityKind === 'matter'
      ? ['title', 'kind', 'priority', 'targetDate'].includes(field)
      : false;
}

/** Preflight the narrow universal field allowlist through the shared CrmCommand schema. */
export async function prepareReviewedFieldUpdate(
  tx: Prisma.TransactionClient,
  ctx: CommandContext,
  policy: CapabilityPolicy,
  proposalId: string,
  overrideEncodedValue?: string,
): Promise<ReviewedFieldPreparation> {
  if (!capabilityPolicyAllows(policy, { entitlement: 'crm.core' })) {
    throw new Error('reviewed_field_capability_denied');
  }
  await requireCandidateReviewAccess(tx, ctx.tenantId, 'ChangeProposal', proposalId, {
    actorId: ctx.actorId,
    actorRole: ctx.actorRole,
    capabilityPolicy: policy,
  });
  const proposal = await tx.changeProposal.findFirst({ where: {
    id: proposalId,
    tenantId: ctx.tenantId,
    status: 'pending',
  } });
  if (!proposal || !supported(proposal.entityKind, proposal.field)) {
    throw new Error('reviewed_field_candidate_invalid');
  }

  const encodedValue = overrideEncodedValue ?? proposal.newValue;
  const value = decode(encodedValue);
  let current: string;
  let rawCommand: unknown;
  if (proposal.entityKind === 'customer') {
    if (proposal.entityId !== proposal.accountId) throw new Error('reviewed_field_candidate_invalid');
    const customer = await tx.account.findFirst({
      where: { id: proposal.accountId, tenantId: ctx.tenantId, archivedAt: null },
      select: { id: true, name: true, categoryKey: true, version: true },
    });
    if (!customer) throw new Error('reviewed_field_target_missing');
    current = encode(customer[proposal.field as 'name' | 'categoryKey']);
    rawCommand = {
      type: 'UPDATE_CUSTOMER',
      customerId: customer.id,
      baseVersion: customer.version,
      patch: { [proposal.field]: value },
    };
  } else {
    if (!proposal.opportunityId || proposal.entityId !== proposal.opportunityId) {
      throw new Error('reviewed_field_candidate_invalid');
    }
    const matter = await tx.opportunity.findFirst({
      where: {
        id: proposal.entityId,
        tenantId: ctx.tenantId,
        accountId: proposal.accountId,
        archivedAt: null,
        account: { tenantId: ctx.tenantId, archivedAt: null },
      },
      select: { id: true, accountId: true, name: true, kind: true, priority: true, targetDate: true, version: true },
    });
    if (!matter) throw new Error('reviewed_field_target_missing');
    current = encode(proposal.field === 'title'
      ? matter.name
      : matter[proposal.field as 'kind' | 'priority' | 'targetDate']);
    rawCommand = {
      type: 'UPDATE_MATTER',
      customerId: matter.accountId,
      matterId: matter.id,
      baseVersion: matter.version,
      patch: { [proposal.field]: value },
    };
  }
  if (current !== proposal.oldValue) throw new Error('正式字段已被人工更新，请刷新后重新审阅提案');
  const command = CrmCommandSchema.safeParse(rawCommand);
  if (!command.success || (command.data.type !== 'UPDATE_CUSTOMER' && command.data.type !== 'UPDATE_MATTER')) {
    throw new Error('reviewed_field_value_invalid');
  }
  return { proposal, command: command.data, encodedValue };
}

/** Apply one already-preflighted command with tenant/version CAS and body-free audit. */
export async function applyReviewedFieldUpdate(
  tx: Prisma.TransactionClient,
  ctx: CommandContext,
  prepared: ReviewedFieldPreparation,
): Promise<{ formalKind: 'customer' | 'matter'; formalId: string }> {
  const { proposal, command } = prepared;
  if (command.type === 'UPDATE_CUSTOMER') {
    const patch = command.patch;
    const changed = await tx.account.updateMany({
      where: {
        id: command.customerId,
        tenantId: ctx.tenantId,
        archivedAt: null,
        version: command.baseVersion,
      },
      data: { ...patch, version: { increment: 1 } },
    });
    if (changed.count !== 1) throw new Error('正式字段已被人工更新，请刷新后重新审阅提案');
  } else {
    const patch = command.patch;
    const data = {
      ...(patch.title !== undefined ? { name: patch.title } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.targetDate !== undefined ? { targetDate: patch.targetDate } : {}),
      version: { increment: 1 as const },
    };
    const changed = await tx.opportunity.updateMany({
      where: {
        id: command.matterId,
        tenantId: ctx.tenantId,
        accountId: command.customerId,
        archivedAt: null,
        version: command.baseVersion,
      },
      data,
    });
    if (changed.count !== 1) throw new Error('正式字段已被人工更新，请刷新后重新审阅提案');
  }
  await tx.auditEvent.create({ data: {
    id: `audit_${randomUUID()}`,
    tenantId: ctx.tenantId,
    actorId: ctx.actorId,
    channel: ctx.channel,
    action: 'reviewed_crm_field_updated',
    entityKind: proposal.entityKind,
    entityId: proposal.entityId,
    requestId: ctx.requestId,
    sourceRef: `candidate:${proposal.id}`,
    changedFields: JSON.stringify([proposal.field, 'version']),
    metadata: JSON.stringify({ field: proposal.field }),
  } });
  return {
    formalKind: proposal.entityKind as 'customer' | 'matter',
    formalId: proposal.entityId,
  };
}
