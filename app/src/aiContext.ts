import type { Account, Opportunity } from './types';
import type { ScoreBreakdown } from './lib/g64111';

/** 把当前商机 + 趋赢力打分组装成给 AI 的紧凑上下文（用户自己的数据，发给用户自己的模型） */
export function buildAiContext(account: Account, opp: Opportunity, breakdown: ScoreBreakdown) {
  const personById = new Map(account.persons.map((p) => [p.id, p]));
  const roleByPerson = new Map(opp.roles.map((r) => [r.personId, r]));
  const nameOf = (id: string) => personById.get(id)?.name ?? id;

  const people = account.persons.map((p) => {
    const r = roleByPerson.get(p.id);
    return {
      name: p.name, title: p.title, isCompetitor: !!p.isCompetitor,
      role: r?.role ?? null, sentiment: r?.sentiment ?? null,
      confidence: r?.confidence ?? null, isKeyInfluencer: !!r?.isKeyInfluencer,
    };
  });
  const relationships = [...account.baseEdges, ...opp.edges].slice(0, 40)
    .map((e) => ({ from: nameOf(e.source), to: nameOf(e.target), layer: e.layer, label: e.label }));
  const bis = opp.bis.map((b) => ({ person: nameOf(b.personId), category: b.category, description: b.description }));

  return {
    account: { name: account.name, customerType: account.customerType },
    opportunity: { name: opp.name, pipelineStage: opp.pipelineStage, engageStage: opp.engageStage, singleSalesGoal: opp.singleSalesGoal },
    winTendency: { percent: breakdown.percent, total: breakdown.total, band: breakdown.band, items: breakdown.items },
    people, relationships, bis,
  };
}
