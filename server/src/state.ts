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

/** 组装某租户的完整 Account 树，形状与前端 types.ts 一致 */
export async function assembleState(tenantId: string) {
  const accounts = await prisma.account.findMany({
    where: { tenantId },
    orderBy: { createdAt: 'asc' },
    include: {
      persons: true,
      edges: true,
      opportunities: { include: { roles: true, edges: true, bis: true, ucvs: true } },
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
      })),
    })),
  };
}
