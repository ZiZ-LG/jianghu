// 提案影响预览（v2.0 + P13）：克隆 opp + apply 提案字段改动 → scoreFromDomain 重算 → 返回趋赢力 before/after（%）。
// 纯函数，复用 g64111 的 scoreFromDomain；克隆只动副本不污染原对象。非评分字段 / 无 opp → null（不显影响）。
// P13 扩：sentiment / isKeyInfluencer 影响名义分（预览有意义）；confidence 只影响加权分（PDE），名义分无变化 → null。
import type { Account, Opportunity, Sentiment } from '../types';
import { scoreFromDomain } from './g64111';

export interface ProposalLike { entityKind: string; entityId: string; field: string; newValue: string }

export function previewProposalImpact(account: Account, opp: Opportunity | null | undefined, p: ProposalLike): { before: number; after: number } | null {
  if (!opp || p.entityKind !== 'oppRole') return null;
  if (p.field !== 'sentiment' && p.field !== 'isKeyInfluencer') return null; // confidence 只动 PDE 加权，g64111 名义分不受影响
  const patchRole = (r: any) => {
    if (r.personId !== p.entityId) return { ...r };
    if (p.field === 'sentiment') return { ...r, sentiment: p.newValue as Sentiment };
    return { ...r, isKeyInfluencer: p.newValue === 'true' }; // isKeyInfluencer
  };
  const before = Math.round(scoreFromDomain(account, opp).percent * 100);
  const oppClone: Opportunity = { ...opp, roles: opp.roles.map(patchRole) };
  const after = Math.round(scoreFromDomain(account, oppClone).percent * 100);
  return { before, after };
}
