import { prisma } from './prisma.js';

const J = (s: string | null | undefined, d: unknown) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function edgeView(e: any) {
  return { id: e.id, source: e.source, target: e.target, layer: e.layer, label: e.label, color: e.color ?? undefined, style: e.style ?? undefined, width: e.width ?? undefined, directed: e.directed, origin: e.origin, shape: e.shape ?? undefined, bend: e.bend ?? undefined };
}
function roleView(r: any) {
  return { personId: r.personId, role: r.role, sentiment: r.sentiment, sentimentValue: r.sentimentValue ?? undefined, confidence: r.confidence, isKeyInfluencer: r.isKeyInfluencer, procurementType: r.procurementType ?? undefined, procurementStatus: r.procurementStatus ?? undefined };
}
function visitView(v: any) {
  return { id: v.id, accountId: v.accountId, opportunityId: v.opportunityId ?? undefined, externalRef: v.externalRef ?? undefined, date: v.date, topic: v.topic, summary: v.summary, participants: J(v.participants, []), origin: v.origin, createdBy: v.createdBy || undefined, createdAt: v.createdAt.toISOString() };
}
function planActionView(a: any) {
  return { id: a.id, accountId: a.accountId, opportunityId: a.opportunityId, gapItem: a.gapItem || undefined, personId: a.personId ?? undefined, title: a.title, scene: a.scene || undefined, scripts: a.scripts || undefined, target: a.target || undefined, ownerId: a.ownerId || undefined, startDate: a.startDate, endDate: a.endDate, half: a.half, done: a.done, doneAt: a.doneAt ?? undefined, review: a.review || undefined, origin: a.origin, createdBy: a.createdBy || undefined, createdAt: a.createdAt.toISOString() };
}
function milestoneView(m: any) {
  return { id: m.id, accountId: m.accountId, opportunityId: m.opportunityId, title: m.title, startDate: m.startDate, endDate: m.endDate, half: m.half, createdAt: m.createdAt.toISOString() };
}
function oppStageView(s: any) {
  return { id: s.id, accountId: s.accountId, opportunityId: s.opportunityId, stageKey: s.stageKey, startDate: s.startDate, endDate: s.endDate, createdAt: s.createdAt.toISOString() };
}

/** 组装某租户的完整 Account 树，形状与前端 types.ts 一致 */
export async function assembleState(tenantId: string) {
  const accounts = await prisma.account.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    include: {
      persons: true,
      edges: true,
      opportunities: { include: { roles: true, edges: true, bis: true, ucvs: true, members: true } },
    },
  });

  // VisitNote 与 Account 无 Prisma relation（设计稿）：单独查后按 accountId 挂到对应客户
  const visits = await prisma.visitNote.findMany({ where: { tenantId }, orderBy: { date: 'desc' } });
  const visitsByAccount = new Map<string, ReturnType<typeof visitView>[]>();
  for (const v of visits) {
    const arr = visitsByAccount.get(v.accountId) ?? [];
    arr.push(visitView(v));
    visitsByAccount.set(v.accountId, arr);
  }

  // PlanAction / OppMilestone 同 VisitNote：无 Account relation，单独查后按 accountId 挂载
  const plans = await prisma.planAction.findMany({ where: { tenantId } });
  const plansByAccount = new Map<string, ReturnType<typeof planActionView>[]>();
  for (const p of plans) {
    const arr = plansByAccount.get(p.accountId) ?? [];
    arr.push(planActionView(p));
    plansByAccount.set(p.accountId, arr);
  }
  const milestones = await prisma.oppMilestone.findMany({ where: { tenantId } });
  const milestonesByAccount = new Map<string, ReturnType<typeof milestoneView>[]>();
  for (const m of milestones) {
    const arr = milestonesByAccount.get(m.accountId) ?? [];
    arr.push(milestoneView(m));
    milestonesByAccount.set(m.accountId, arr);
  }
  const oppStages = await prisma.oppStage.findMany({ where: { tenantId } });
  const stagesByAccount = new Map<string, ReturnType<typeof oppStageView>[]>();
  for (const s of oppStages) {
    const arr = stagesByAccount.get(s.accountId) ?? [];
    arr.push(oppStageView(s));
    stagesByAccount.set(s.accountId, arr);
  }

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
        avatarUrl: p.avatarUrl ?? undefined, coachLevel: p.coachLevel ?? undefined, color: p.color ?? undefined, x: p.x, y: p.y,
        // 默认结构兜底再 spread 解析结果：采纳候选/导入/语音建的 Person form='{}'，
        // 直接 JSON.parse 会得空对象、缺 family7，前端访问 form.family7.xxx 即崩。
        form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {}, ...(J(p.form, {}) as Record<string, unknown>) },
        logs: J(p.logs, []),
      })),
      baseEdges: a.edges.filter((e) => !e.opportunityId).map(edgeView),
      visitNotes: visitsByAccount.get(a.id) ?? [],
      planActions: plansByAccount.get(a.id) ?? [],
      milestones: milestonesByAccount.get(a.id) ?? [],
      oppStages: stagesByAccount.get(a.id) ?? [],
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
      })),
    })),
  };
}
