import { prisma } from './prisma.js';

const J = (s: string | null | undefined, d: unknown) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function edgeView(e: any) {
  return { id: e.id, source: e.source, target: e.target, layer: e.layer, label: e.label, color: e.color ?? undefined, style: e.style ?? undefined, width: e.width ?? undefined, directed: e.directed, origin: e.origin, shape: e.shape ?? undefined, bend: e.bend ?? undefined };
}
function roleView(r: any) {
  return { personId: r.personId, role: r.role, sentiment: r.sentiment, sentimentValue: r.sentimentValue ?? undefined, confidence: r.confidence, isKeyInfluencer: r.isKeyInfluencer, procurementType: r.procurementType ?? undefined, procurementStatus: r.procurementStatus ?? undefined };
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

  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      customerType: a.customerType,
      unifiedCreditCode: a.unifiedCreditCode ?? undefined,
      persons: a.persons.map((p) => ({
        id: p.id, name: p.name, title: p.title, orgLevel: p.orgLevel, isCompetitor: p.isCompetitor,
        avatarUrl: p.avatarUrl ?? undefined, coachLevel: p.coachLevel ?? undefined, x: p.x, y: p.y,
        form: J(p.form, { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} }),
        logs: J(p.logs, []),
      })),
      baseEdges: a.edges.filter((e) => !e.opportunityId).map(edgeView),
      opportunities: a.opportunities.map((o) => ({
        id: o.id, accountId: o.accountId, name: o.name, customerType: o.customerType,
        pipelineStage: o.pipelineStage, engageStage: o.engageStage, changeMode: o.changeMode ?? undefined,
        singleSalesGoal: o.singleSalesGoal, customerBusinessGoal: o.customerBusinessGoal ?? undefined,
        buyingMotivation: o.buyingMotivation ?? undefined,
        c3Items: J(o.c3Items, {}), c5Items: J(o.c5Items, {}),
        roles: o.roles.map(roleView),
        edges: o.edges.map(edgeView),
        bis: o.bis.map((b) => ({ id: b.id, personId: b.personId, description: b.description, category: b.category, isPrivate: b.isPrivate, confidence: b.confidence })),
        ucvs: o.ucvs.map((u) => ({ id: u.id, targetBiId: u.targetBiId, description: u.description, competitorCannot: u.competitorCannot, status: u.status })),
      })),
    })),
  };
}
