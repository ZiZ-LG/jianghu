import { prisma } from './prisma.js';

const J = (s: string | null | undefined, d: unknown) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

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
  return { id: a.id, accountId: a.accountId, opportunityId: a.opportunityId, gapItem: a.gapItem || undefined, personId: a.personId ?? undefined, title: a.title, scene: a.scene || undefined, scripts: a.scripts || undefined, target: a.target || undefined, ownerId: a.ownerId || undefined, startDate: a.startDate, endDate: a.endDate, half: a.half, done: a.done, doneAt: a.doneAt ?? undefined, review: a.review || undefined, origin: a.origin, createdBy: a.createdBy || undefined, createdAt: a.createdAt.toISOString() };
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

  // Note（自由文本层）：accountId 非空 → 按客户挂载；accountId 空 → 顶层「未归类」
  const notes = await prisma.note.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' } });
  const notesByAccount = new Map<string, ReturnType<typeof noteView>[]>();
  const unfiledNotes: ReturnType<typeof noteView>[] = [];
  for (const n of notes) {
    if (n.accountId) {
      const arr = notesByAccount.get(n.accountId) ?? [];
      arr.push(noteView(n));
      notesByAccount.set(n.accountId, arr);
    } else {
      unfiledNotes.push(noteView(n));
    }
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

  // 策略沙盘 · 策略卡/风险/弹药：同 PlanAction，无 Account relation，按 accountId 挂载
  const sCards = await prisma.strategyCard.findMany({ where: { tenantId } });
  const cardsByAccount = new Map<string, ReturnType<typeof strategyCardView>[]>();
  for (const c of sCards) {
    const arr = cardsByAccount.get(c.accountId) ?? [];
    arr.push(strategyCardView(c));
    cardsByAccount.set(c.accountId, arr);
  }
  const sRisks = await prisma.strategyRisk.findMany({ where: { tenantId } });
  const risksByAccount = new Map<string, ReturnType<typeof strategyRiskView>[]>();
  for (const r of sRisks) {
    const arr = risksByAccount.get(r.accountId) ?? [];
    arr.push(strategyRiskView(r));
    risksByAccount.set(r.accountId, arr);
  }
  const sResources = await prisma.strategyResource.findMany({ where: { tenantId } });
  const resourcesByAccount = new Map<string, ReturnType<typeof strategyResourceView>[]>();
  for (const x of sResources) {
    const arr = resourcesByAccount.get(x.accountId) ?? [];
    arr.push(strategyResourceView(x));
    resourcesByAccount.set(x.accountId, arr);
  }
  // 证据事件（E2）按 opportunityId 分组，挂到对应商机
  const evidences = await prisma.evidenceEvent.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  const evByOpp = new Map<string, any[]>();
  for (const e of evidences) {
    const arr = evByOpp.get(e.opportunityId) ?? [];
    arr.push({ id: e.id, accountId: e.accountId, opportunityId: e.opportunityId, personId: e.personId, signalKey: e.signalKey, direction: e.direction, tier: e.tier, rawContent: e.rawContent, occurredAt: e.occurredAt });
    evByOpp.set(e.opportunityId, arr);
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
