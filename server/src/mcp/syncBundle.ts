import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { CommandContext } from '@jianghu/domain-contracts';
import { prisma } from '../prisma.js';
import { C5_ITEMS } from '../g64111.js';
import type { DbClient } from '../mutate.js';
import { createFieldProposal } from '../proposals.js';
import { enqueueEnrichJob, enqueueProfileJob, enqueueSuggestJob } from '../jobs.js';
import { replayReceipt, type StoredSyncReceipt, type SyncReceipt } from './syncReceipt.js';
import { activePersonWhere } from '../activePerson.js';
import { mapLegacyOpportunityStatus } from '../matter/lifecycle.js';
import { createPdeDecisionContext } from '../pde/context.js';

const OPAQUE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#/-]*$/;
const OpaqueRefSchema = z.string().trim().min(1).max(80).regex(OPAQUE_REF_PATTERN, 'ref must be an opaque identifier without names or free text');
const C5ItemsWriteSchema = z.object(Object.fromEntries(
  C5_ITEMS.map((key) => [key, z.boolean().optional()]),
)).strict();

const AccountFactSchema = z.object({
  id: z.string().trim().min(1).max(80).optional(),
  externalRef: z.string().trim().min(1).max(80).optional(),
  unifiedCreditCode: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(100),
  customerType: z.number().int().min(1).max(4).optional(),
  region: z.string().max(40).optional(),
  group: z.string().max(100).optional(),
  primaryOwner: z.string().max(40).optional(),
  primaryOwnerUserId: z.string().max(100).nullable().optional(),
  profile: z.record(z.string()).optional(),
}).strict().refine((value) => value.id || value.externalRef || value.unifiedCreditCode, 'account requires id, externalRef, or unifiedCreditCode');

const OpportunityFactSchema = z.object({
  externalRef: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(100),
  pipelineStage: z.enum(['线索', '需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签']).optional(),
  engageStage: z.enum(['需求调研立项', '方案可研', '预算批复', '招标论证', '招采执行']).optional(),
  status: z.enum(['active', 'paused', 'won', 'lost']).optional(),
  changeMode: z.enum(['G', 'T', 'EK', 'OC']).nullable().optional(),
  productSolution: z.string().max(500).optional(),
  competitor: z.string().max(200).optional(),
  competitiveSituation: z.enum(['', '领先', '胶着', '落后', '未识别']).optional(),
  singleSalesGoal: z.string().max(500).optional(),
  customerBusinessGoal: z.string().max(500).nullable().optional(),
  buyingMotivation: z.string().max(500).nullable().optional(),
  expectedSignDate: z.string().max(20).optional(),
  expectedAmountW: z.number().finite().optional(),
  c3Items: z.record(z.boolean()).optional(),
  c5Items: C5ItemsWriteSchema.optional(),
  meta: z.record(z.unknown()).refine((value) => !Object.prototype.hasOwnProperty.call(value, '_mcpOrigin'), {
    message: 'meta contains reserved key _mcpOrigin',
  }).optional(),
}).strict();

const VisitFactSchema = z.object({
  externalRef: z.string().trim().min(1).max(120),
  opportunityId: z.string().trim().min(1).max(80).optional(),
  date: z.string().trim().min(1).max(20),
  summary: z.string().trim().min(1).max(5000),
  topic: z.string().max(200).optional(),
  participants: z.array(z.object({
    name: z.string().trim().min(1).max(40),
    side: z.enum(['our', 'customer']),
  }).strict()).max(50).optional(),
}).strict();

const PersonCandidateSchema = z.object({
  ref: OpaqueRefSchema,
  name: z.string().trim().min(1).max(40),
  title: z.string().max(60).default(''),
  orgLevel: z.number().int().min(1).max(4).default(3),
  evidence: z.string().max(500).default(''),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();

const RelationCandidateSchema = z.object({
  ref: OpaqueRefSchema,
  sourceRef: OpaqueRefSchema,
  targetRef: OpaqueRefSchema,
  layer: z.enum(['L1', 'L2', 'L3', 'L4']).default('L3'),
  label: z.string().trim().min(1).max(40),
  evidence: z.string().max(500).default(''),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();

const EvidenceCandidateSchema = z.object({
  ref: OpaqueRefSchema,
  personId: z.string().trim().min(1).max(80),
  signalKey: z.string().trim().min(1).max(80),
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]).default(0),
  tier: z.enum(['weak', 'mid', 'strong']).default('mid'),
  rawContent: z.string().max(2000).default(''),
  occurredAt: z.string().max(20).default(''),
}).strict();

export const SyncIntelBundleArgsSchema = z.object({
  idempotencyKey: z.string().trim().min(8).max(200).regex(OPAQUE_REF_PATTERN, 'idempotencyKey must be an opaque identifier without names or free text'),
  bundle: z.object({
    account: AccountFactSchema,
    opportunity: OpportunityFactSchema.optional(),
    visit: VisitFactSchema.optional(),
    people: z.array(PersonCandidateSchema).max(100).default([]),
    relations: z.array(RelationCandidateSchema).max(100).default([]),
    evidences: z.array(EvidenceCandidateSchema).max(100).default([]),
  }).strict(),
}).strict();

export type SyncIntelBundleArgs = z.infer<typeof SyncIntelBundleArgsSchema>;
type FaultOptions = { failAfterStep?: number };
const MAX_PENDING_PERSON_SUGGESTIONS = 200;
const MAX_PENDING_REL_SUGGESTIONS = 200;

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
};
const requestHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const parseReceipt = (value: string): StoredSyncReceipt => JSON.parse(value) as StoredSyncReceipt;
const proposalValue = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value ?? null);
const parseObject = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};
const prismaCode = (error: unknown): string | undefined => (
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
);
const retryableTransactionError = (error: unknown): boolean => {
  const code = prismaCode(error);
  if (code === 'P2034' || code === 'P1008' || code === 'P2028') return true;
  return error instanceof Error && error.message.toLowerCase().includes('database is locked');
};
const fault = (options: FaultOptions | undefined, step: number) => {
  if (options?.failAfterStep === step) throw new Error(`injected sync failure after step ${step}`);
};

async function persistFailedSyncRun(
  db: PrismaClient,
  ctx: CommandContext,
  input: SyncIntelBundleArgs,
  hash: string,
  proposedRunId: string,
): Promise<void> {
  const storedKey = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const where = { tenantId_idempotencyKey: {
    tenantId: ctx.tenantId, idempotencyKey: storedKey,
  } } as const;
  const failedReceipt: StoredSyncReceipt = {
    syncRunId: proposedRunId,
    created: [], updated: [], proposed: [], skipped: [],
    failed: [{ ref: 'bundle', code: 'sync_failed', message: '同步事务失败，业务数据已回滚' }],
  };
  try {
    const existing = await db.syncRun.findUnique({ where });
    if (existing?.requestHash !== undefined && existing.requestHash !== hash) return;
    if (existing?.status === 'completed' || existing?.status === 'running') return;
    if (existing) {
      failedReceipt.syncRunId = existing.id;
      await db.syncRun.update({ where: { id: existing.id }, data: {
        actorId: ctx.actorId, status: 'failed', receipt: JSON.stringify(failedReceipt),
      } });
      return;
    }
    await db.syncRun.create({ data: {
      id: proposedRunId, tenantId: ctx.tenantId, actorId: ctx.actorId,
      idempotencyKey: storedKey, requestHash: hash, status: 'failed',
      receipt: JSON.stringify(failedReceipt),
    } });
  } catch (error) {
    // 审计记录不得掩盖原始同步错误；并发完成者由其 completed 回执作为事实来源。
    if (prismaCode(error) !== 'P2002') return;
  }
}

function validateBundleRefs(input: SyncIntelBundleArgs): void {
  const refs = new Set<string>();
  const identities = new Set<string>();
  for (const person of input.bundle.people) {
    if (refs.has(person.ref)) throw new Error(`duplicate person ref: ${person.ref}`);
    const identity = person.name.trim();
    if (identities.has(identity)) throw new Error(`person refs resolve to the same candidate identity: ${identity}`);
    refs.add(person.ref);
    identities.add(identity);
  }
  const relationRefs = new Set<string>();
  for (const relation of input.bundle.relations) {
    if (relationRefs.has(relation.ref)) throw new Error(`duplicate relationship ref: ${relation.ref}`);
    relationRefs.add(relation.ref);
    if (!refs.has(relation.sourceRef) || !refs.has(relation.targetRef)) throw new Error(`relationship ${relation.ref} references an unknown candidate`);
    if (relation.sourceRef === relation.targetRef) throw new Error(`relationship ${relation.ref} cannot be a self-loop`);
  }
  const evidenceRefs = new Set<string>();
  for (const evidence of input.bundle.evidences) {
    if (evidenceRefs.has(evidence.ref)) throw new Error(`duplicate evidence ref: ${evidence.ref}`);
    evidenceRefs.add(evidence.ref);
  }
}

async function executeBundle(
  ctx: CommandContext,
  input: SyncIntelBundleArgs,
  syncRunId: string,
  db: DbClient,
  options?: FaultOptions,
): Promise<StoredSyncReceipt> {
  const receipt: StoredSyncReceipt = { syncRunId, created: [], updated: [], proposed: [], skipped: [], failed: [] };
  const { account: accountFact } = input.bundle;
  const byId = accountFact.id
    ? await db.account.findFirst({ where: { id: accountFact.id, tenantId: ctx.tenantId } })
    : null;
  const byExternal = accountFact.externalRef
    ? await db.account.findUnique({ where: { tenantId_externalRef: { tenantId: ctx.tenantId, externalRef: accountFact.externalRef } } })
    : null;
  const byCredit = accountFact.unifiedCreditCode
    ? await db.account.findUnique({ where: { tenantId_unifiedCreditCode: { tenantId: ctx.tenantId, unifiedCreditCode: accountFact.unifiedCreditCode } } })
    : null;
  if (accountFact.id && !byId) throw new Error('account id does not exist in the current tenant');
  const resolvedIds = new Set([byId?.id, byExternal?.id, byCredit?.id].filter(Boolean));
  if (resolvedIds.size > 1) throw new Error('account anchors resolve to different rows');
  let account = byId ?? byExternal ?? byCredit;
  if (accountFact.externalRef && account?.externalRef && accountFact.externalRef !== account.externalRef) {
    throw new Error('account anchors conflict: externalRef does not match the resolved row');
  }
  if (accountFact.unifiedCreditCode && account?.unifiedCreditCode && accountFact.unifiedCreditCode !== account.unifiedCreditCode) {
    throw new Error('account anchors conflict: unifiedCreditCode does not match the resolved row');
  }
  if (input.bundle.people.length) {
    const uniqueNames = [...new Set(input.bundle.people.map((candidate) => candidate.name))];
    const [pendingCount, existingNames] = await Promise.all([
      db.personSuggestion.count({ where: { tenantId: ctx.tenantId, status: 'pending' } }),
      account ? db.personSuggestion.findMany({
        where: { tenantId: ctx.tenantId, accountId: account.id, status: 'pending', name: { in: uniqueNames } },
        select: { name: true },
      }) : Promise.resolve([]),
    ]);
    const additional = uniqueNames.filter((name) => !existingNames.some((row) => row.name === name)).length;
    if (pendingCount + additional > MAX_PENDING_PERSON_SUGGESTIONS) {
      throw new Error(`候选干系人已达上限（${MAX_PENDING_PERSON_SUGGESTIONS}），请先处理现有候选`);
    }
  }
  if (accountFact.primaryOwnerUserId) {
    const owner = await db.user.findFirst({ where: { id: accountFact.primaryOwnerUserId, tenantId: ctx.tenantId }, select: { id: true } });
    if (!owner) throw new Error('primary owner not found in tenant');
  }
  if (!account) {
    const profile = {
      ...(accountFact.profile ?? {}),
      _mcpOrigin: { source: 'mcp', syncRunId, at: new Date().toISOString(), needsReview: true },
    };
    account = await db.account.create({ data: {
      id: 'acc_' + randomUUID().replaceAll('-', ''), tenantId: ctx.tenantId,
      externalRef: accountFact.externalRef ?? null, unifiedCreditCode: accountFact.unifiedCreditCode ?? null,
      name: accountFact.name, customerType: accountFact.customerType ?? 1,
      region: accountFact.region ?? '', group: accountFact.group ?? '',
      primaryOwner: accountFact.primaryOwner ?? '', primaryOwnerUserId: accountFact.primaryOwnerUserId ?? null,
      profile: JSON.stringify(profile),
    } });
    try { await enqueueEnrichJob(ctx.tenantId, account.id, 'auto', db); }
    catch { receipt.skipped.push({ ref: `job:enrich:${account.id}`, reason: 'queue unavailable' }); }
    try { await enqueueProfileJob(ctx.tenantId, account.id, db); }
    catch { receipt.skipped.push({ ref: `job:profile:${account.id}`, reason: 'queue unavailable' }); }
    receipt.created.push(`account:${accountFact.externalRef ?? accountFact.unifiedCreditCode ?? accountFact.id}`);
  } else {
    const patch: Record<string, string | number | null> = {};
    if (account.name !== accountFact.name) patch.name = accountFact.name;
    if (accountFact.customerType !== undefined && account.customerType !== accountFact.customerType) patch.customerType = accountFact.customerType;
    if (accountFact.region !== undefined && account.region !== accountFact.region) patch.region = accountFact.region;
    if (accountFact.group !== undefined && account.group !== accountFact.group) patch.group = accountFact.group;
    if (accountFact.primaryOwner !== undefined && account.primaryOwner !== accountFact.primaryOwner) patch.primaryOwner = accountFact.primaryOwner;
    if (accountFact.primaryOwnerUserId !== undefined && account.primaryOwnerUserId !== accountFact.primaryOwnerUserId) patch.primaryOwnerUserId = accountFact.primaryOwnerUserId;
    if (accountFact.profile !== undefined) {
      patch.profile = JSON.stringify({
        ...parseObject(account.profile), ...accountFact.profile,
        _mcpOrigin: { source: 'mcp', syncRunId, at: new Date().toISOString(), needsReview: true },
      });
    }
    if (accountFact.externalRef && !account.externalRef) patch.externalRef = accountFact.externalRef;
    if (accountFact.unifiedCreditCode && !account.unifiedCreditCode) patch.unifiedCreditCode = accountFact.unifiedCreditCode;
    const ref = `account:${accountFact.externalRef ?? accountFact.unifiedCreditCode ?? accountFact.id}`;
    if (Object.keys(patch).length) {
      account = await db.account.update({ where: { id: account.id }, data: patch });
      receipt.updated.push(ref);
    } else receipt.skipped.push({ ref, reason: 'unchanged' });
  }
  fault(options, 1);

  let opportunity = null;
  if (input.bundle.opportunity) {
    const fact = input.bundle.opportunity;
    opportunity = await db.opportunity.findUnique({ where: { tenantId_accountId_externalRef: {
      tenantId: ctx.tenantId, accountId: account.id, externalRef: fact.externalRef,
    } } });
    if (!opportunity) {
      const status = fact.status ?? 'active';
      opportunity = await db.opportunity.create({ data: {
        id: 'opp_' + randomUUID().replaceAll('-', ''), tenantId: ctx.tenantId, accountId: account.id,
        externalRef: fact.externalRef, name: fact.name, customerType: account.customerType,
        pipelineStage: fact.pipelineStage ?? '线索', engageStage: fact.engageStage ?? '需求调研立项',
        status, ...mapLegacyOpportunityStatus(status), changeMode: fact.changeMode ?? null,
        productSolution: fact.productSolution ?? '', competitor: fact.competitor ?? '',
        competitiveSituation: fact.competitiveSituation ?? '', singleSalesGoal: fact.singleSalesGoal ?? '',
        customerBusinessGoal: fact.customerBusinessGoal ?? null, buyingMotivation: fact.buyingMotivation ?? null,
        expectedSignDate: fact.expectedSignDate ?? '', expectedAmountW: fact.expectedAmountW ?? 0,
        c3Items: JSON.stringify(fact.c3Items ?? {}), c5Items: JSON.stringify(fact.c5Items ?? {}),
        meta: JSON.stringify({ ...(fact.meta ?? {}), _mcpOrigin: { source: 'mcp', syncRunId, needsReview: true } }),
      } });
      await createPdeDecisionContext(db, {
        tenantId: ctx.tenantId,
        opportunityId: opportunity.id,
      });
      try { await enqueueSuggestJob(ctx.tenantId, account.id, opportunity.id, db); }
      catch { receipt.skipped.push({ ref: `job:suggest:${opportunity.id}`, reason: 'queue unavailable' }); }
      receipt.created.push(`opportunity:${fact.externalRef}`);
    } else {
      const changes: Array<[string, unknown, unknown]> = [['name', opportunity.name, fact.name]];
      const optionalChanges: Array<[keyof typeof fact, keyof typeof opportunity]> = [
        ['pipelineStage', 'pipelineStage'], ['engageStage', 'engageStage'], ['status', 'status'], ['changeMode', 'changeMode'],
        ['productSolution', 'productSolution'], ['competitor', 'competitor'], ['competitiveSituation', 'competitiveSituation'],
        ['singleSalesGoal', 'singleSalesGoal'], ['customerBusinessGoal', 'customerBusinessGoal'], ['buyingMotivation', 'buyingMotivation'],
        ['expectedSignDate', 'expectedSignDate'], ['expectedAmountW', 'expectedAmountW'], ['c3Items', 'c3Items'], ['c5Items', 'c5Items'],
      ];
      for (const [inputField, storedField] of optionalChanges) {
        const value = fact[inputField];
        if (value === undefined) continue;
        const stored = opportunity[storedField];
        changes.push([String(inputField), stored, typeof value === 'object' && value !== null ? JSON.stringify(value) : value]);
      }
      if (fact.meta !== undefined) {
        const currentMeta = parseObject(opportunity.meta);
        const nextMeta: Record<string, unknown> = { ...currentMeta, ...fact.meta };
        if (Object.prototype.hasOwnProperty.call(currentMeta, '_mcpOrigin')) nextMeta._mcpOrigin = currentMeta._mcpOrigin;
        changes.push(['meta', opportunity.meta, JSON.stringify(nextMeta)]);
      }
      for (const [field, oldValueRaw, newValueRaw] of changes) {
        const oldValue = proposalValue(oldValueRaw);
        const newValue = proposalValue(newValueRaw);
        if (oldValue === newValue) continue;
        await createFieldProposal(ctx.tenantId, {
          accountId: account.id, opportunityId: opportunity.id, entityKind: 'opportunity', entityId: opportunity.id,
          field, oldValue, newValue, origin: 'mcp', evidence: 'WorkBuddy 原子同步建议修改正式商机字段',
          confidence: 0.6, proposedBy: ctx.actorId,
        }, db);
        receipt.proposed.push(`opportunity:${fact.externalRef}:${field}`);
      }
      if (!receipt.proposed.some((ref) => ref.startsWith(`opportunity:${fact.externalRef}:`))) {
        receipt.skipped.push({ ref: `opportunity:${fact.externalRef}`, reason: 'unchanged' });
      }
    }
  }
  fault(options, 2);

  if (input.bundle.visit) {
    const fact = input.bundle.visit;
    let visitOpportunityId = opportunity?.id ?? null;
    if (fact.opportunityId) {
      const scopedOpportunity = await db.opportunity.findFirst({ where: {
        id: fact.opportunityId, tenantId: ctx.tenantId, accountId: account.id,
      } });
      if (!scopedOpportunity) throw new Error('visit opportunity does not exist under the resolved account');
      if (visitOpportunityId && visitOpportunityId !== scopedOpportunity.id) {
        throw new Error('visit opportunity anchors resolve to different rows');
      }
      visitOpportunityId = scopedOpportunity.id;
    }
    const existing = await db.visitNote.findUnique({ where: { tenantId_accountId_externalRef: {
      tenantId: ctx.tenantId, accountId: account.id, externalRef: fact.externalRef,
    } } });
    if (existing) {
      await db.visitNote.update({ where: { id: existing.id }, data: {
        opportunityId: visitOpportunityId ?? existing.opportunityId, date: fact.date,
        topic: fact.topic ?? existing.topic, summary: fact.summary,
        ...(fact.participants !== undefined ? { participants: JSON.stringify(fact.participants) } : {}),
      } });
      receipt.updated.push(`visit:${fact.externalRef}`);
    } else {
      await db.visitNote.create({ data: {
        id: 'visit_' + randomUUID().replaceAll('-', ''), tenantId: ctx.tenantId, accountId: account.id,
        opportunityId: visitOpportunityId, externalRef: fact.externalRef,
        date: fact.date, topic: fact.topic ?? '', summary: fact.summary,
        participants: JSON.stringify(fact.participants ?? []), origin: 'mcp', createdBy: ctx.actorId,
      } });
      receipt.created.push(`visit:${fact.externalRef}`);
    }
  }
  fault(options, 3);

  const candidateIds = new Map<string, string>();
  for (const candidate of input.bundle.people) {
    let row = await db.personSuggestion.findFirst({ where: {
      tenantId: ctx.tenantId, accountId: account.id, name: candidate.name, status: 'pending',
    } });
    if (!row) {
      row = await db.personSuggestion.create({ data: {
        id: 'ps_' + randomUUID().replaceAll('-', ''), tenantId: ctx.tenantId, accountId: account.id,
        opportunityId: opportunity?.id ?? null, name: candidate.name, title: candidate.title,
        orgLevel: candidate.orgLevel, evidence: candidate.evidence, confidence: candidate.confidence,
        origin: 'mcp', status: 'pending', proposedBy: ctx.actorId,
      } });
    }
    candidateIds.set(candidate.ref, row.id);
    receipt.proposed.push(`person:${candidate.ref}`);
  }

  if (input.bundle.relations.length && !opportunity) throw new Error('relationship candidates require an opportunity');
  if (input.bundle.relations.length) {
    const pendingCount = await db.relSuggestion.count({ where: { tenantId: ctx.tenantId, opportunityId: opportunity!.id, status: 'pending' } });
    if (pendingCount + input.bundle.relations.length > MAX_PENDING_REL_SUGGESTIONS) {
      throw new Error(`候选关系已达上限（${MAX_PENDING_REL_SUGGESTIONS}），请先处理现有候选`);
    }
  }
  for (const relation of input.bundle.relations) {
    const sourcePersonId = candidateIds.get(relation.sourceRef)!;
    const targetPersonId = candidateIds.get(relation.targetRef)!;
    const existing = await db.relSuggestion.findFirst({ where: {
      tenantId: ctx.tenantId, opportunityId: opportunity!.id, status: 'pending',
      OR: [
        { sourceKind: 'suggestion', sourcePersonId, targetKind: 'suggestion', targetPersonId },
        { sourceKind: 'suggestion', sourcePersonId: targetPersonId, targetKind: 'suggestion', targetPersonId: sourcePersonId },
      ],
    } });
    if (!existing) await db.relSuggestion.create({ data: {
      id: 'rs_' + randomUUID().replaceAll('-', ''), tenantId: ctx.tenantId, opportunityId: opportunity!.id,
      sourceKind: 'suggestion', sourcePersonId, targetKind: 'suggestion', targetPersonId,
      layer: relation.layer, label: relation.label, evidence: relation.evidence,
      confidence: relation.confidence, origin: 'mcp', status: 'pending',
    } });
    receipt.proposed.push(`relationship:${relation.ref}`);
  }

  if (input.bundle.evidences.length && !opportunity) throw new Error('evidence candidates require an opportunity');
  for (const evidence of input.bundle.evidences) {
    const person = await db.person.findFirst({ where: { id: evidence.personId, tenantId: ctx.tenantId, accountId: account.id, ...activePersonWhere } });
    if (!person) throw new Error(`evidence ${evidence.ref} person is outside the account`);
    await db.evidenceEvent.create({ data: {
      id: 'ev_' + randomUUID().replaceAll('-', ''), tenantId: ctx.tenantId, accountId: account.id,
      opportunityId: opportunity!.id, personId: person.id, signalKey: evidence.signalKey,
      direction: evidence.direction, tier: evidence.tier, rawContent: evidence.rawContent,
      occurredAt: evidence.occurredAt, status: 'pending_review', origin: 'mcp', createdBy: ctx.actorId,
    } });
    receipt.proposed.push(`evidence:${evidence.ref}`);
  }
  fault(options, 4);
  return receipt;
}

export async function syncIntelBundle(
  ctx: CommandContext,
  raw: unknown,
  db: PrismaClient = prisma,
  options?: FaultOptions,
): Promise<SyncReceipt> {
  const input = SyncIntelBundleArgsSchema.parse(raw);
  validateBundleRefs(input);
  const hash = requestHash(input.bundle);
  const storedKey = createHash('sha256').update(input.idempotencyKey).digest('hex');
  const proposedRunId = randomUUID();
  const where = { tenantId_idempotencyKey: {
    tenantId: ctx.tenantId, idempotencyKey: storedKey,
  } } as const;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(async (tx) => {
        const existing = await tx.syncRun.findUnique({ where });
        if (existing && existing.requestHash !== hash) throw new Error('idempotency key reused with a different bundle');
        if (existing?.status === 'completed') return replayReceipt(parseReceipt(existing.receipt));
        const syncRun = existing
          ? await tx.syncRun.update({ where: { id: existing.id }, data: { actorId: ctx.actorId, status: 'running', receipt: '{}' } })
          : await tx.syncRun.create({ data: {
            id: proposedRunId, tenantId: ctx.tenantId, actorId: ctx.actorId,
            idempotencyKey: storedKey, requestHash: hash,
          } });
        const receipt = await executeBundle(ctx, input, syncRun.id, tx, options);
        await tx.syncRun.update({ where: { id: syncRun.id }, data: { status: 'completed', receipt: JSON.stringify(receipt) } });
        return { ...receipt, replayed: false };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 5_000, timeout: 30_000 });
    } catch (error) {
      const code = prismaCode(error);
      if (code === 'P2002') {
        const existing = await db.syncRun.findUnique({ where });
        if (existing && existing.requestHash !== hash) throw new Error('idempotency key reused with a different bundle');
        if (existing?.status === 'completed') return replayReceipt(parseReceipt(existing.receipt));
      }
      if (retryableTransactionError(error) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 15 * attempt));
        continue;
      }
      const isIdempotencyConflict = error instanceof Error
        && error.message === 'idempotency key reused with a different bundle';
      if (!isIdempotencyConflict) await persistFailedSyncRun(db, ctx, input, hash, proposedRunId);
      throw error;
    }
  }
  throw new Error('sync transaction could not be completed');
}
