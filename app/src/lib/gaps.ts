// M3 缺口卡片：把 G64111 低分项翻译成「待确认卡片」，让周复盘/补分从「填表」变「刷卡」。
// 复用引擎 buildScoringInput——不写新算法，只把"缺什么"定位到具体的人/项，翻成可一键点选的动作。
import type { Account, Opportunity, ProcurementType } from './../types';
import { C3_ITEMS, C5_ITEMS } from './../types';
import { buildScoringInput, type ItemKey } from './g64111';

export type GapAction =
  | { kind: 'sentiment'; personId: string }  // 点支持度（最高频）
  | { kind: 'c3' }                            // 勾选立项材料
  | { kind: 'c5' }                            // 勾选招采事项
  | { kind: 'c4' }                            // 选介入阶段
  | { kind: 'key-influencer' }                // 锁定关键影响人
  | { kind: 'guide'; to: string };            // 需自由文本/画布操作 → 引导去对应处

export interface Gap {
  id: string;
  item: ItemKey;
  deficit: number;  // 估算缺分，仅用于「性价比」排序
  title: string;
  hint: string;
  action: GapAction;
}

export function computeGaps(account: Account, opp: Opportunity): Gap[] {
  const input = buildScoringInput(account, opp);
  const nameOf = (id: string) => account.persons.find((p) => p.id === id)?.name ?? '?';
  const gaps: Gap[] = [];
  const D = opp.roles.find((r) => r.role === 'D');

  // 态度未知 → 每人一张，点一下定调（A→1K、D→P3 分值最高排前，其余→P1）
  for (const r of opp.roles) {
    if (r.sentiment === 'unknown') {
      const item: ItemKey = r.role === 'A' ? '1K' : r.role === 'D' ? 'P3' : 'P1';
      gaps.push({ id: 'sent-' + r.personId, item, deficit: r.role === 'A' || r.role === 'D' ? 8 : 4, title: `${nameOf(r.personId)}（${r.role}）的态度还没定`, hint: '点一下他当前的支持度', action: { kind: 'sentiment', personId: r.personId } });
    }
  }
  // C1 角色缺失 → 引导（缺任一角色扣 3 分）
  (['A', 'D', 'U', 'R', 'C'] as const).forEach((role) => {
    if (!input.rolesPresent[role]) gaps.push({ id: 'role-' + role, item: 'C1', deficit: 3, title: `决策链缺「${role}」角色`, hint: '在画布上新建或指认该角色', action: { kind: 'guide', to: '画布' } });
  });
  // C2 拍板人 BI（需自由文本）
  if (!input.dHasBI && D) gaps.push({ id: 'bi-d', item: 'C2', deficit: 5, title: `缺拍板人 ${nameOf(D.personId)} 的燃眉之急`, hint: '到详情抽屉记一条他最迫切的难题/压力（可信度 ≥ 明确才计分）', action: { kind: 'guide', to: '详情抽屉' } });
  // C1 FORM
  if (D && input.dFamily7Filled < 7) gaps.push({ id: 'form-d', item: 'C1', deficit: 1, title: `${nameOf(D.personId)} 的家庭 7 问缺 ${7 - input.dFamily7Filled} 项`, hint: '到详情抽屉补齐（严格曲线：填满 7 项才满 3 分）', action: { kind: 'guide', to: '详情抽屉' } });
  // C3 立项材料
  const missC3 = C3_ITEMS.filter((k) => !opp.c3Items[k]);
  if (missC3.length) gaps.push({ id: 'c3', item: 'C3', deficit: Math.min(5, missC3.length), title: `立项材料缺 ${missC3.length} 项`, hint: '点亮你已掌握的', action: { kind: 'c3' } });
  // C4 介入阶段
  if (!opp.engageStage) gaps.push({ id: 'c4', item: 'C4', deficit: 5, title: '还没标记介入阶段', hint: '越早介入分越高', action: { kind: 'c4' } });
  // C5 招采事项
  const missC5 = C5_ITEMS.filter((k) => !opp.c5Items[k]);
  if (missC5.length) gaps.push({ id: 'c5', item: 'C5', deficit: Math.min(5, missC5.length), title: `招采事项缺 ${missC5.length} 项`, hint: '点亮你已掌握的', action: { kind: 'c5' } });
  // C6 UCV
  if (input.ucvStatus !== '已解决') gaps.push({ id: 'ucv', item: 'C6', deficit: input.ucvStatus === '获认可' ? 2 : 5, title: '独特价值（UCV）未落地', hint: '到详情抽屉针对 D 的 BI 提炼对手给不了的价值', action: { kind: 'guide', to: '详情抽屉' } });
  // P2 招采关键人
  const types: ProcurementType[] = ['purchasing', 'agency', 'ownerRep'];
  if (types.every((t) => input.p2[t] === 'none')) gaps.push({ id: 'p2', item: 'P2', deficit: 10, title: '招采关键人一个都没接触', hint: '采购/招标代理/甲方代表 至少接触一类（详情抽屉设招采状态）', action: { kind: 'guide', to: '详情抽屉' } });
  // P4 关键影响人
  if (!opp.roles.some((r) => r.isKeyInfluencer)) gaps.push({ id: 'p4', item: 'P4', deficit: 5, title: '未锁定关键影响人', hint: '选一个能影响 A/D 的非 A/D 角色', action: { kind: 'key-influencer' } });

  return gaps.sort((a, b) => b.deficit - a.deficit);
}
