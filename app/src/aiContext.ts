import { pickKeyInfluencerKeeper, type Account, type Opportunity } from './types';
import type { ScoreBreakdown } from './lib/g64111';

// P13：AI 上下文补两维——
// ①ucvs（独特价值×BI×认可状态）：AI 建议 UCV 打法 / 对手撬点时的决胜素材；
// ②recentInteractions（关键人近 2 条交往日志）：让参谋知道「他最近跟你聊过啥」，
// 上下文膨胀受控（每人 2 条+全局 30 条上限），避免 payload 过大压模型 token 预算。

/** 把当前商机 + 趋赢力打分组装成给 AI 的紧凑上下文（用户自己的数据，发给用户自己的模型） */
export function buildAiContext(account: Account, opp: Opportunity, breakdown: ScoreBreakdown) {
  const personById = new Map(account.persons.map((p) => [p.id, p]));
  const roleByPerson = new Map(opp.roles.map((r) => [r.personId, r]));
  const nameOf = (id: string) => personById.get(id)?.name ?? id;
  const dRoles = opp.roles.filter((role) => role.role === 'D');
  const primaryD = dRoles.find((role) => role.personId === opp.primaryDPersonId) ?? dRoles[0];
  const keyInfluencer = pickKeyInfluencerKeeper(opp.roles);

  const people = account.persons.map((p) => {
    const r = roleByPerson.get(p.id);
    return {
      name: p.name, title: p.title, isCompetitor: !!p.isCompetitor,
      role: r?.role ?? null, sentiment: r?.sentiment ?? null,
      confidence: r?.confidence ?? null,
      isPrimaryD: !!primaryD && r?.personId === primaryD.personId,
      isKeyInfluencer: !!keyInfluencer && r?.personId === keyInfluencer.personId,
    };
  });
  const relationships = [...account.baseEdges, ...opp.edges].slice(0, 40)
    .map((e) => ({ from: nameOf(e.source), to: nameOf(e.target), layer: e.layer, label: e.label }));
  const biById = new Map(opp.bis.map((b) => [b.id, b]));
  const bis = opp.bis.map((b) => ({ person: nameOf(b.personId), category: b.category, description: b.description }));
  // UCV 挂靠某个 BI：解 BI 得到「针对谁的什么燃点」，AI 能理解为什么这条价值对得上
  const ucvs = opp.ucvs.map((u) => {
    const bi = biById.get(u.targetBiId);
    return { person: bi ? nameOf(bi.personId) : '?', bi: bi ? `${bi.category}·${bi.description}` : '?', description: u.description, competitorCannot: u.competitorCannot, status: u.status };
  });
  // 近期交往：关键人（A/D/关键影响人）优先各出 2 条最新 log，全局 30 条上限——够上下文用又不撑爆 payload
  const keyIds = new Set(opp.roles
    .filter((role) => role.role === 'A' || role.role === 'D' || role.personId === keyInfluencer?.personId)
    .map((role) => role.personId));
  const recentInteractions: { person: string; date: string; content: string }[] = [];
  for (const p of account.persons) {
    if (!keyIds.has(p.id)) continue;
    for (const l of (p.logs ?? []).slice(0, 2)) recentInteractions.push({ person: p.name, date: l.date, content: l.content });
    if (recentInteractions.length >= 30) break;
  }

  return {
    account: { name: account.name, customerType: account.customerType },
    opportunity: { name: opp.name, pipelineStage: opp.pipelineStage, engageStage: opp.engageStage, singleSalesGoal: opp.singleSalesGoal, expectedSignDate: opp.expectedSignDate ?? null },
    winTendency: { percent: breakdown.percent, total: breakdown.total, band: breakdown.band, items: breakdown.items },
    people, relationships, bis, ucvs, recentInteractions,
  };
}
