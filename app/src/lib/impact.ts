// 提案影响预览（v2.0）：克隆 opp + apply 提案字段改动 → scoreFromDomain 重算 → 返回趋赢力 before/after（%）。
// 纯函数，复用 g64111 的 scoreFromDomain；克隆只动副本不污染原对象。非评分字段 / 无 opp → null（不显影响）。
import type { Account, Opportunity, Sentiment } from '../types';
import { scoreFromDomain } from './g64111';

export interface ProposalLike { entityKind: string; entityId: string; field: string; newValue: string }

export function previewProposalImpact(account: Account, opp: Opportunity | null | undefined, p: ProposalLike): { before: number; after: number } | null {
  if (!opp) return null;
  // v2.0：仅 oppRole.sentiment 影响评分；其余字段暂不预览
  if (p.entityKind === 'oppRole' && p.field === 'sentiment') {
    const before = Math.round(scoreFromDomain(account, opp).percent * 100);
    const oppClone: Opportunity = { ...opp, roles: opp.roles.map((r) => (r.personId === p.entityId ? { ...r, sentiment: p.newValue as Sentiment } : { ...r })) };
    const after = Math.round(scoreFromDomain(account, oppClone).percent * 100);
    return { before, after };
  }
  return null;
}
