// 方案包推演（L2）—— 确定性骨架：姿态定基调 × 杠杆排序定攻坚目标 × gapItem 映射行动宝典模板。
// 纯前端、零网络、本地暂存（守铁律②）；LLM 润色为后续可选增强。docs/策略引擎-设计方案.md §4。
import type { Account, Opportunity, Role, Sentiment } from '../../types';
import { FAMILY_7Q } from '../../types';
import type { ScoreBreakdown } from '../g64111';
import { personContributions } from '../g64111';
import { analyzeDeal, type JianghuPdeResult } from './adapter';

export interface PlaybookCard { gapItem: string; title: string; basis: string; personId?: string }
export interface PlaybookAction { title: string; kind: 'gain' | 'probe'; gapItem: string; personId?: string; offsetDays: number; scene?: string }
export interface Playbook {
  key: string;
  title: string;
  tone: 'raise' | 'call' | 'check' | 'fold';
  rationale: string;
  cards: PlaybookCard[];
  actions: PlaybookAction[];
  expectedWinTendency: number;   // 预期最多可解锁趋赢力（聚焦人 upside 和，封顶）
  clarityUp: boolean;            // 探牌包：提升把握度而非直接提分
  costTier: 'low' | 'mid' | 'high';
}

// 角色 → 主攻 gapItem（与 g64111 归因一致）
const ROLE_GAP: Record<Role, string> = { D: 'P3', A: '1K', U: 'P1', TB: 'P1', R: 'P1' };
// gain 行动模板（{name} 占位）
const GAIN_TMPL: Record<string, { t: string; scene: string }> = {
  P3: { t: '与{name}单独深谈，摸清燃眉之急与政绩诉求', scene: '带可上报的降本/样板数据，争取"密谋级"支持' },
  '1K': { t: '请{intro}引荐触达批准人{name}', scene: '用可上报的降本/样板数据换 A 的背书' },
  P4: { t: '争取关键影响人{name}出面发声', scene: '把态度从中立推到明确支持，借其影响力撬动他人' },
  P2: { t: '接触招采关键人{name}，争取口头承诺', scene: '摸清招采流程与规则制定空间' },
  P1: { t: '把{name}的态度逐步转为明确支持', scene: '高频低成本接触，找其个人赢点' },
  C2: { t: '挖出{name}的燃眉之急 BI 并记录到明确级', scene: '从业务痛点切入，不要泛泛而谈' },
  C6: { t: '针对 BI 提炼独特价值 UCV 并争取{name}认可', scene: '突出友商做不到的差异点' },
};
const FORM_PROBE = { t: '借非正式拜访补全{name}的 FORM 七问', scene: '家庭/事业/休闲/金钱动机，建立私人连接' };
const CLARITY_PROBE = { t: '低成本接触{name}，摸清真实立场', scene: '借流程性事务自然接触，先看牌再决定是否下重注' };

const sentOf = (opp: Opportunity) => new Map(opp.roles.map((r) => [r.personId, r.sentiment as Sentiment]));

/** 找引荐通路：与 target 相连且支持度为 ☆/+ 的盟友（优先 ☆） */
function findIntroducer(targetId: string, account: Account, opp: Opportunity): { id: string; name: string } | null {
  const edges = [...account.baseEdges, ...opp.edges];
  const sent = sentOf(opp);
  const nameById = new Map(account.persons.map((p) => [p.id, p.name]));
  let plusFallback: { id: string; name: string } | null = null;
  for (const e of edges) {
    const other = e.source === targetId ? e.target : e.target === targetId ? e.source : null;
    if (!other || other === targetId) continue;
    const s = sent.get(other);
    if (s === 'star') return { id: other, name: nameById.get(other) ?? '盟友' };
    if (s === 'plus' && !plusFallback) plusFallback = { id: other, name: nameById.get(other) ?? '盟友' };
  }
  return plusFallback;
}

const fill = (tmpl: string, vars: Record<string, string>) => tmpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const cap = (n: number, hi: number) => Math.min(n, hi);

/** 生成 2-3 个候选方案包（主攻 + 迂回[有通路时] + 探牌[恒有]） */
export function buildPlaybooks(account: Account, opp: Opportunity, breakdown: ScoreBreakdown, pde?: JianghuPdeResult): Playbook[] {
  const r = pde ?? analyzeDeal(account, opp, breakdown);
  const contrib = personContributions(account, opp);
  const roleByPerson = new Map(opp.roles.map((x) => [x.personId, x]));
  const nameById = new Map(account.persons.map((p) => [p.id, p.name]));
  const formFilled = (pid: string) => {
    const p = account.persons.find((x) => x.id === pid);
    if (!p) return 7;
    return FAMILY_7Q.filter((q) => (p.form.family7[q] ?? '').trim()).length;
  };
  // 杠杆榜（已按 upside 降序，含人名）
  const lever = r.leverageNamed.filter((l) => roleByPerson.has(l.id));
  const postureById = new Map(r.stakeholders.map((s) => [s.id, s]));
  const out: Playbook[] = [];

  // ── 主攻包（杠杆 top 1-2 人直攻；基调随姿态）──
  const mainTargets = lever.slice(0, 2);
  if (mainTargets.length) {
    const cards: PlaybookCard[] = [];
    const actions: PlaybookAction[] = [];
    let off = 5;
    for (const t of mainTargets) {
      const role = roleByPerson.get(t.id);
      if (!role) continue;
      const gap = ROLE_GAP[role.role];
      const tmpl = GAIN_TMPL[gap] ?? GAIN_TMPL.P1;
      actions.push({ title: fill(tmpl.t, { name: t.name }), kind: 'gain', gapItem: gap, personId: t.id, offsetDays: off, scene: tmpl.scene });
      cards.push({ gapItem: gap, title: `攻坚${t.name}（${role.role}）· 补强${gap}`, basis: `杠杆最高：经营到位可再解锁约 ${Math.round(t.score)} 分`, personId: t.id });
      off += 7;
      // D 且 FORM 不全 → 附 probe 补 FORM
      if (role.role === 'D' && formFilled(t.id) < 5) {
        actions.push({ title: fill(FORM_PROBE.t, { name: t.name }), kind: 'probe', gapItem: 'C1', personId: t.id, offsetDays: off, scene: FORM_PROBE.scene });
        off += 5;
      }
    }
    const tone = r.stance === 'fold' ? 'call' : r.stance; // 主攻包基调不取 fold（fold 用专门止损包）
    out.push({
      key: 'frontal',
      title: tone === 'raise' ? '正面攻坚 · 拿下杠杆人' : '稳步攻坚 · 补强短板',
      tone,
      rationale: `杠杆榜 top：${mainTargets.map((t) => t.name).join('、')}——经营到位提分最快`,
      cards, actions,
      expectedWinTendency: cap(Math.round(mainTargets.reduce((s, t) => s + t.score, 0)), 30),
      clarityUp: false,
      costTier: r.stance === 'raise' ? 'high' : 'mid',
    });
  }

  // ── 迂回包（高杠杆但未触达/看不清的人，经盟友引荐）──
  const detour = lever.find((l) => {
    const p = postureById.get(l.id);
    return p && (p.clarity === 'unclear' || p.pO > 0.3) && findIntroducer(l.id, account, opp);
  });
  if (detour) {
    const intro = findIntroducer(detour.id, account, opp)!;
    const role = roleByPerson.get(detour.id)!;
    const gap = ROLE_GAP[role.role];
    out.push({
      key: 'flank',
      title: '侧翼包抄 · 借盟友引荐',
      tone: 'call',
      rationale: `${detour.name}（${role.role}）杠杆高但难直接触达，${intro.name}是现成引荐通路`,
      cards: [{ gapItem: gap, title: `经${intro.name}迂回触达${detour.name}`, basis: '直接攻坚成本高，借盟友政治资本背书更稳', personId: detour.id }],
      actions: [
        { title: `请${intro.name}牵线，非正式引荐${detour.name}`, kind: 'gain', gapItem: gap, personId: detour.id, offsetDays: 5, scene: '由盟友铺垫，降低首次接触的戒心' },
        { title: `准备面向${detour.name}视角的价值一页纸`, kind: 'probe', gapItem: gap, personId: detour.id, offsetDays: 7, scene: '从其关注点（合规/政绩/风险）切入' },
        { title: `引荐后正式拜访${detour.name}`, kind: 'gain', gapItem: gap, personId: detour.id, offsetDays: 14, scene: '把态度推进到明确支持' },
      ],
      expectedWinTendency: cap(Math.round(detour.score), 25),
      clarityUp: false,
      costTier: 'mid',
    });
  }

  // ── 探牌包（高熵关键人，恒有；信息永远有价值）──
  const foggy = r.stakeholders
    .filter((s) => s.clarity !== 'clear' && s.weightShare > 0.1)
    .sort((a, b) => b.weightShare - a.weightShare)
    .slice(0, 3)
    .map((s) => ({ id: s.id, name: nameById.get(s.id) ?? '干系人' }))
    .filter((x) => roleByPerson.has(x.id));
  if (foggy.length) {
    out.push({
      key: 'probe',
      title: '先清再动 · 摸清摇摆人',
      tone: 'check',
      rationale: `${foggy.map((f) => f.name).join('、')}立场未清——大投入前先用低成本动作收窄判断`,
      cards: [],
      actions: foggy.map((f, i) => ({
        title: fill(CLARITY_PROBE.t, { name: f.name }), kind: 'probe' as const, gapItem: 'C1', personId: f.id, offsetDays: 4 + i * 3, scene: CLARITY_PROBE.scene,
      })),
      expectedWinTendency: 0,
      clarityUp: true,
      costTier: 'low',
    });
  }

  return out;
}
