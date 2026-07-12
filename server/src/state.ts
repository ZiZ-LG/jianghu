import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';

const J = (s: string | null | undefined, d: unknown) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export interface StateSecurityWarning {
  event: 'state_scope_rows_dropped';
  tenantId: string;
  counts: Record<string, Record<string, number>>;
  samples: Array<{ model: string; reason: string; id: string }>;
}

export interface AssembleStateOptions {
  onSecurityWarning?: (warning: StateSecurityWarning) => void;
}

class StateDropCollector {
  private readonly counts: Record<string, Record<string, number>> = {};
  private readonly samples: Array<{ model: string; reason: string; id: string }> = [];
  private readonly seen = new Set<string>();

  constructor(private readonly tenantId: string) {}

  keep(model: string, id: string, reasons: readonly string[]): boolean {
    for (const reason of new Set(reasons)) {
      const key = `${model}\u0000${reason}\u0000${id}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      const byReason = this.counts[model] ?? {};
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      this.counts[model] = byReason;
      if (this.samples.length < 20) this.samples.push({ model, reason, id });
    }
    return reasons.length === 0;
  }

  emit(callback: AssembleStateOptions['onSecurityWarning']): void {
    if (!callback || this.seen.size === 0) return;
    callback({
      event: 'state_scope_rows_dropped',
      tenantId: this.tenantId,
      counts: this.counts,
      samples: this.samples,
    });
  }
}

function stringIds(raw: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const accountTreeInclude = {
  persons: true,
  edges: true,
  opportunities: { include: { roles: true, edges: true, bis: true, ucvs: true, members: true } },
} as const satisfies Prisma.AccountInclude;

type AccountTreeRow = Prisma.AccountGetPayload<{ include: typeof accountTreeInclude }>;

function edgeView(e: any) {
  return { id: e.id, source: e.source, target: e.target, layer: e.layer, label: e.label, color: e.color ?? undefined, style: e.style ?? undefined, width: e.width ?? undefined, directed: e.directed, origin: e.origin, shape: e.shape ?? undefined, bend: e.bend ?? undefined, version: e.version };
}
function roleView(r: any) {
  return { personId: r.personId, role: r.role, sentiment: r.sentiment, sentimentValue: r.sentimentValue ?? undefined, confidence: r.confidence, isKeyInfluencer: r.isKeyInfluencer, procurementType: r.procurementType ?? undefined, procurementStatus: r.procurementStatus ?? undefined };
}
function visitView(v: any) {
  return { id: v.id, accountId: v.accountId, opportunityId: v.opportunityId ?? undefined, externalRef: v.externalRef ?? undefined, date: v.date, topic: v.topic, summary: v.summary, participants: J(v.participants, []), origin: v.origin, createdBy: v.createdBy || undefined, createdAt: v.createdAt.toISOString() };
}
function noteView(n: any) {
  return { id: n.id, accountId: n.accountId ?? undefined, opportunityId: n.opportunityId ?? undefined, personId: n.personId ?? undefined, content: n.content, source: n.source || undefined, tags: J(n.tags, []), createdBy: n.createdBy || undefined, createdAt: n.createdAt.toISOString() };
}
function planActionView(a: any) {
  return { id: a.id, accountId: a.accountId, opportunityId: a.opportunityId, gapItem: a.gapItem || undefined, personId: a.personId ?? undefined, title: a.title, scene: a.scene || undefined, scripts: a.scripts || undefined, target: a.target || undefined, ownerId: a.ownerId || undefined, startDate: a.startDate, endDate: a.endDate, half: a.half, done: a.done, doneAt: a.doneAt ?? undefined, draft: !!a.draft, review: a.review || undefined, resources: a.resources || undefined, cautions: a.cautions || undefined, props: a.props || undefined, origin: a.origin, createdBy: a.createdBy || undefined, createdAt: a.createdAt.toISOString() };
}
function milestoneView(m: any) {
  return { id: m.id, accountId: m.accountId, opportunityId: m.opportunityId, title: m.title, startDate: m.startDate, endDate: m.endDate, half: m.half, createdAt: m.createdAt.toISOString() };
}
function oppStageView(s: any) {
  return { id: s.id, accountId: s.accountId, opportunityId: s.opportunityId, stageKey: s.stageKey, startDate: s.startDate, endDate: s.endDate, createdAt: s.createdAt.toISOString() };
}
function strategyCardView(c: any) {
  return { id: c.id, accountId: c.accountId, opportunityId: c.opportunityId, gapItem: c.gapItem || undefined, title: c.title, basis: c.basis || undefined, alternatives: c.alternatives || undefined, personId: c.personId ?? undefined, status: c.status, origin: c.origin, orderIndex: c.orderIndex, dispatchedActionIds: J(c.dispatchedActionIds, []), createdAt: c.createdAt.toISOString() };
}
function strategyRiskView(r: any) {
  return { id: r.id, accountId: r.accountId, opportunityId: r.opportunityId, kind: r.kind, text: r.text, severity: r.severity, mitigation: r.mitigation || undefined, status: r.status, origin: r.origin, createdAt: r.createdAt.toISOString() };
}
function strategyResourceView(x: any) {
  return { id: x.id, accountId: x.accountId, opportunityId: x.opportunityId, label: x.label, kind: x.kind || undefined, note: x.note || undefined, createdAt: x.createdAt.toISOString() };
}

/**
 * 组装某租户的完整 Account 树，形状与前端 types.ts 一致。
 * scope（viewer 只读投影·契约 v1.0 §四）：只下发 primaryOwner === 该销售姓名 的客户及其子树；
 * 未归属（primaryOwner 空）的客户对 viewer 不可见。非 viewer 不传 scope，维持全租户共享。
 */
export async function assembleState(
  tenantId: string,
  scope?: { primaryOwner: string },
  options: AssembleStateOptions = {},
) {
  const drops = new StateDropCollector(tenantId);
  const rawAccounts = await prisma.account.findMany({
    where: { tenantId, ...(scope ? { primaryOwner: scope.primaryOwner } : {}) },
    orderBy: { createdAt: 'asc' },
    include: accountTreeInclude,
  });
  const accounts: AccountTreeRow[] = rawAccounts.map((account) => ({
    ...account,
    persons: account.persons.filter((person) => {
      const reasons: string[] = [];
      if (person.tenantId !== tenantId) reasons.push('tenant_mismatch');
      if (person.accountId !== account.id) reasons.push('account_mismatch');
      return drops.keep('Person', person.id, reasons);
    }),
    opportunities: account.opportunities.filter((opportunity) => {
      const reasons: string[] = [];
      if (opportunity.tenantId !== tenantId) reasons.push('tenant_mismatch');
      if (opportunity.accountId !== account.id) reasons.push('account_mismatch');
      return drops.keep('Opportunity', opportunity.id, reasons);
    }),
  }));

  const accountIds = new Set(accounts.map((account) => account.id));
  const personAccount = new Map<string, string>();
  const opportunityAccount = new Map<string, string>();
  for (const account of accounts) {
    for (const person of account.persons) personAccount.set(person.id, account.id);
    for (const opportunity of account.opportunities) opportunityAccount.set(opportunity.id, account.id);
  }

  for (const account of accounts) {
    account.edges = account.edges.filter((edge) => {
      const reasons: string[] = [];
      if (edge.tenantId !== tenantId) reasons.push('tenant_mismatch');
      if (edge.accountId !== account.id) reasons.push('account_mismatch');
      if (edge.opportunityId && opportunityAccount.get(edge.opportunityId) !== account.id) {
        reasons.push('opportunity_mismatch');
      }
      if (personAccount.get(edge.source) !== account.id) reasons.push('source_mismatch');
      if (personAccount.get(edge.target) !== account.id) reasons.push('target_mismatch');
      return drops.keep('Edge', edge.id, reasons);
    });

    for (const opportunity of account.opportunities) {
      opportunity.roles = opportunity.roles.filter((role) => {
        const reasons: string[] = [];
        if (role.tenantId !== tenantId) reasons.push('tenant_mismatch');
        if (role.opportunityId !== opportunity.id) reasons.push('opportunity_mismatch');
        if (personAccount.get(role.personId) !== account.id) reasons.push('person_mismatch');
        return drops.keep('OppRole', role.id, reasons);
      });
      opportunity.edges = opportunity.edges.filter((edge) => {
        const reasons: string[] = [];
        if (edge.tenantId !== tenantId) reasons.push('tenant_mismatch');
        if (edge.accountId !== account.id) reasons.push('account_mismatch');
        if (edge.opportunityId !== opportunity.id) reasons.push('opportunity_mismatch');
        if (personAccount.get(edge.source) !== account.id) reasons.push('source_mismatch');
        if (personAccount.get(edge.target) !== account.id) reasons.push('target_mismatch');
        return drops.keep('Edge', edge.id, reasons);
      });
      opportunity.bis = opportunity.bis.filter((bi) => {
        const reasons: string[] = [];
        if (bi.tenantId !== tenantId) reasons.push('tenant_mismatch');
        if (bi.opportunityId !== opportunity.id) reasons.push('opportunity_mismatch');
        if (personAccount.get(bi.personId) !== account.id) reasons.push('person_mismatch');
        return drops.keep('BurningIssue', bi.id, reasons);
      });
      const biIds = new Set(opportunity.bis.map((bi) => bi.id));
      opportunity.ucvs = opportunity.ucvs.filter((ucv) => {
        const reasons: string[] = [];
        if (ucv.tenantId !== tenantId) reasons.push('tenant_mismatch');
        if (ucv.opportunityId !== opportunity.id) reasons.push('opportunity_mismatch');
        if (!biIds.has(ucv.targetBiId)) reasons.push('bi_mismatch');
        return drops.keep('UCV', ucv.id, reasons);
      });
      opportunity.members = opportunity.members.filter((member) => {
        const reasons: string[] = [];
        if (member.tenantId !== tenantId) reasons.push('tenant_mismatch');
        if (member.opportunityId !== opportunity.id) reasons.push('opportunity_mismatch');
        if (personAccount.get(member.personId) !== account.id) reasons.push('person_mismatch');
        return drops.keep('OpportunityMember', member.id, reasons);
      });
    }
  }

  // viewer 范围：后续按 accountId 挂载的表统一收敛到名下客户（防止越权行随树下发）
  const accFilter = scope ? { accountId: { in: accounts.map((a) => a.id) } } : {};

  // VisitNote 与 Account 无 Prisma relation（设计稿）：单独查后按 accountId 挂到对应客户
  const visits = await prisma.visitNote.findMany({ where: { tenantId, ...accFilter }, orderBy: { date: 'desc' } });
  const visitsByAccount = new Map<string, ReturnType<typeof visitView>[]>();
  for (const v of visits) {
    const reasons: string[] = [];
    if (v.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(v.accountId)) reasons.push('account_mismatch');
    if (v.opportunityId && opportunityAccount.get(v.opportunityId) !== v.accountId) {
      reasons.push('opportunity_mismatch');
    }
    if (!drops.keep('VisitNote', v.id, reasons)) continue;
    const arr = visitsByAccount.get(v.accountId) ?? [];
    arr.push(visitView(v));
    visitsByAccount.set(v.accountId, arr);
  }

  // Note（自由文本层）：accountId 非空 → 按客户挂载；accountId 空 → 顶层「未归类」
  const notes = await prisma.note.findMany({ where: { tenantId, ...accFilter }, orderBy: { createdAt: 'desc' } });
  const notesByAccount = new Map<string, ReturnType<typeof noteView>[]>();
  const unfiledNotes: ReturnType<typeof noteView>[] = [];
  for (const n of notes) {
    const reasons: string[] = [];
    if (n.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (n.accountId) {
      if (!accountIds.has(n.accountId)) reasons.push('account_mismatch');
      if (n.opportunityId && opportunityAccount.get(n.opportunityId) !== n.accountId) {
        reasons.push('opportunity_mismatch');
      }
      if (n.personId && personAccount.get(n.personId) !== n.accountId) reasons.push('person_mismatch');
    } else {
      if (n.opportunityId) reasons.push('opportunity_mismatch');
      if (n.personId) reasons.push('person_mismatch');
    }
    if (!drops.keep('Note', n.id, reasons)) continue;
    if (n.accountId) {
      const arr = notesByAccount.get(n.accountId) ?? [];
      arr.push(noteView(n));
      notesByAccount.set(n.accountId, arr);
    } else {
      unfiledNotes.push(noteView(n));
    }
  }

  // PlanAction / OppMilestone 同 VisitNote：无 Account relation，单独查后按 accountId 挂载
  const plans = await prisma.planAction.findMany({ where: { tenantId, ...accFilter } });
  const plansByAccount = new Map<string, ReturnType<typeof planActionView>[]>();
  const planActionLocation = new Map<string, { accountId: string; opportunityId: string }>();
  for (const p of plans) {
    const reasons: string[] = [];
    if (p.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(p.accountId)) reasons.push('account_mismatch');
    if (opportunityAccount.get(p.opportunityId) !== p.accountId) reasons.push('opportunity_mismatch');
    if (p.personId && personAccount.get(p.personId) !== p.accountId) reasons.push('person_mismatch');
    if (!drops.keep('PlanAction', p.id, reasons)) continue;
    planActionLocation.set(p.id, { accountId: p.accountId, opportunityId: p.opportunityId });
    const arr = plansByAccount.get(p.accountId) ?? [];
    arr.push(planActionView(p));
    plansByAccount.set(p.accountId, arr);
  }
  const milestones = await prisma.oppMilestone.findMany({ where: { tenantId, ...accFilter } });
  const milestonesByAccount = new Map<string, ReturnType<typeof milestoneView>[]>();
  for (const m of milestones) {
    const reasons: string[] = [];
    if (m.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(m.accountId)) reasons.push('account_mismatch');
    if (opportunityAccount.get(m.opportunityId) !== m.accountId) reasons.push('opportunity_mismatch');
    if (!drops.keep('OppMilestone', m.id, reasons)) continue;
    const arr = milestonesByAccount.get(m.accountId) ?? [];
    arr.push(milestoneView(m));
    milestonesByAccount.set(m.accountId, arr);
  }
  const oppStages = await prisma.oppStage.findMany({ where: { tenantId, ...accFilter } });
  const stagesByAccount = new Map<string, ReturnType<typeof oppStageView>[]>();
  for (const s of oppStages) {
    const reasons: string[] = [];
    if (s.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(s.accountId)) reasons.push('account_mismatch');
    if (opportunityAccount.get(s.opportunityId) !== s.accountId) reasons.push('opportunity_mismatch');
    if (!drops.keep('OppStage', s.id, reasons)) continue;
    const arr = stagesByAccount.get(s.accountId) ?? [];
    arr.push(oppStageView(s));
    stagesByAccount.set(s.accountId, arr);
  }

  // 策略沙盘 · 策略卡/风险/弹药：同 PlanAction，无 Account relation，按 accountId 挂载
  const sCards = await prisma.strategyCard.findMany({ where: { tenantId, ...accFilter } });
  const cardsByAccount = new Map<string, ReturnType<typeof strategyCardView>[]>();
  for (const c of sCards) {
    const reasons: string[] = [];
    if (c.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(c.accountId)) reasons.push('account_mismatch');
    if (opportunityAccount.get(c.opportunityId) !== c.accountId) reasons.push('opportunity_mismatch');
    if (c.personId && personAccount.get(c.personId) !== c.accountId) reasons.push('person_mismatch');
    const dispatchedActionIds = stringIds(c.dispatchedActionIds);
    if (!dispatchedActionIds || dispatchedActionIds.some((id) => {
      const location = planActionLocation.get(id);
      return !location
        || location.accountId !== c.accountId
        || location.opportunityId !== c.opportunityId;
    })) reasons.push('plan_action_mismatch');
    if (!drops.keep('StrategyCard', c.id, reasons)) continue;
    const arr = cardsByAccount.get(c.accountId) ?? [];
    arr.push(strategyCardView(c));
    cardsByAccount.set(c.accountId, arr);
  }
  const sRisks = await prisma.strategyRisk.findMany({ where: { tenantId, ...accFilter } });
  const risksByAccount = new Map<string, ReturnType<typeof strategyRiskView>[]>();
  for (const r of sRisks) {
    const reasons: string[] = [];
    if (r.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(r.accountId)) reasons.push('account_mismatch');
    if (opportunityAccount.get(r.opportunityId) !== r.accountId) reasons.push('opportunity_mismatch');
    if (!drops.keep('StrategyRisk', r.id, reasons)) continue;
    const arr = risksByAccount.get(r.accountId) ?? [];
    arr.push(strategyRiskView(r));
    risksByAccount.set(r.accountId, arr);
  }
  const sResources = await prisma.strategyResource.findMany({ where: { tenantId, ...accFilter } });
  const resourcesByAccount = new Map<string, ReturnType<typeof strategyResourceView>[]>();
  for (const x of sResources) {
    const reasons: string[] = [];
    if (x.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(x.accountId)) reasons.push('account_mismatch');
    if (opportunityAccount.get(x.opportunityId) !== x.accountId) reasons.push('opportunity_mismatch');
    if (!drops.keep('StrategyResource', x.id, reasons)) continue;
    const arr = resourcesByAccount.get(x.accountId) ?? [];
    arr.push(strategyResourceView(x));
    resourcesByAccount.set(x.accountId, arr);
  }
  // 证据事件（E2）按 opportunityId 分组，挂到对应商机
  const evidences = await prisma.evidenceEvent.findMany({ where: { tenantId, ...accFilter }, orderBy: { createdAt: 'asc' } });
  const evByOpp = new Map<string, any[]>();
  for (const e of evidences) {
    const reasons: string[] = [];
    if (e.tenantId !== tenantId) reasons.push('tenant_mismatch');
    if (!accountIds.has(e.accountId)) reasons.push('account_mismatch');
    if (opportunityAccount.get(e.opportunityId) !== e.accountId) reasons.push('opportunity_mismatch');
    if (personAccount.get(e.personId) !== e.accountId) reasons.push('person_mismatch');
    if (!drops.keep('EvidenceEvent', e.id, reasons)) continue;
    const arr = evByOpp.get(e.opportunityId) ?? [];
    arr.push({ id: e.id, accountId: e.accountId, opportunityId: e.opportunityId, personId: e.personId, signalKey: e.signalKey, direction: e.direction, tier: e.tier, rawContent: e.rawContent, occurredAt: e.occurredAt, status: e.status ?? 'approved', origin: e.origin ?? 'manual' });
    evByOpp.set(e.opportunityId, arr);
  }

  drops.emit(options.onSecurityWarning);

  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      customerType: a.customerType,
      unifiedCreditCode: a.unifiedCreditCode ?? undefined,
      externalRef: a.externalRef ?? undefined,
      region: a.region,
      group: a.group,
      primaryOwner: a.primaryOwner,
      profile: J(a.profile, {}),
      persons: a.persons.map((p) => ({
        id: p.id, name: p.name, title: p.title, orgLevel: p.orgLevel, isCompetitor: p.isCompetitor,
        avatarUrl: p.avatarUrl ?? undefined, coachLevel: p.coachLevel ?? undefined, color: p.color ?? undefined, x: p.x, y: p.y, version: p.version,
        // 默认结构兜底再 spread 解析结果：采纳候选/导入/语音建的 Person form='{}'，
        // 直接 JSON.parse 会得空对象、缺 family7，前端访问 form.family7.xxx 即崩。
        form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {}, ...(J(p.form, {}) as Record<string, unknown>) },
        logs: J(p.logs, []),
      })),
      baseEdges: a.edges.filter((e) => !e.opportunityId).map(edgeView),
      visitNotes: visitsByAccount.get(a.id) ?? [],
      notes: notesByAccount.get(a.id) ?? [],
      planActions: plansByAccount.get(a.id) ?? [],
      milestones: milestonesByAccount.get(a.id) ?? [],
      oppStages: stagesByAccount.get(a.id) ?? [],
      strategyCards: cardsByAccount.get(a.id) ?? [],
      strategyRisks: risksByAccount.get(a.id) ?? [],
      strategyResources: resourcesByAccount.get(a.id) ?? [],
      opportunities: a.opportunities.map((o) => ({
        id: o.id, accountId: o.accountId, name: o.name, customerType: o.customerType,
        pipelineStage: o.pipelineStage, engageStage: o.engageStage, changeMode: o.changeMode ?? undefined,
        singleSalesGoal: o.singleSalesGoal, customerBusinessGoal: o.customerBusinessGoal ?? undefined,
        buyingMotivation: o.buyingMotivation ?? undefined,
        externalRef: o.externalRef ?? undefined, status: o.status,
        productSolution: o.productSolution, competitor: o.competitor, competitiveSituation: o.competitiveSituation,
        winProbability: o.winProbability, expectedSignDate: o.expectedSignDate, expectedAmountW: o.expectedAmountW,
        meta: J(o.meta, {}),
        c3Items: J(o.c3Items, {}), c5Items: J(o.c5Items, {}),
        roles: o.roles.map(roleView),
        edges: o.edges.map(edgeView),
        bis: o.bis.map((b) => ({ id: b.id, personId: b.personId, description: b.description, category: b.category, isPrivate: b.isPrivate, confidence: b.confidence })),
        ucvs: o.ucvs.map((u) => ({ id: u.id, targetBiId: u.targetBiId, description: u.description, competitorCannot: u.competitorCannot, status: u.status })),
        memberScoped: o.memberScoped,
        memberIds: o.members.map((m) => m.personId),
        evidenceEvents: evByOpp.get(o.id) ?? [],
        version: o.version,
      })),
    })),
    unfiledNotes,
  };
}
