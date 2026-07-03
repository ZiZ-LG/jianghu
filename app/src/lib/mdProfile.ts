// 客户档案 / 商机档案 / 拜访记录 的 Markdown 序列化（系统 → MD，块B）。
// 纯函数、无副作用：把 Account/Opportunity/VisitNote 按 v1.1 母版结构渲染成 .md 文本。
// 与 docs/templates/ 的两份母版对齐。来源标记/版本日志为 .md 侧元数据（决策 b，系统不存）。
// 字段级 HTML 注释 <!-- f:xxx --> 作为结构锚点，供块C「MD→系统」回写解析定位。
import type { Account, Opportunity, VisitNote, Person, OppRole, AccountProfile } from '../types';
import {
  CUSTOMER_TYPE_LABEL, ROLE_LABEL, SENTIMENT_CHAR, FAMILY_7Q, C3_ITEMS, C5_ITEMS,
  PROCUREMENT_TYPE_LABEL, PROCUREMENT_STATUS_LABEL, CHANGE_MODES,
} from '../types';
import { scoreFromDomain, BAND_LABEL, BAND_STRATEGY, ITEM_MAX, type ItemKey } from './g64111';

/** .md 侧维护的版本日志条目（决策 b：存 localStorage，不入系统库） */
export interface VersionLogEntry { version: string; date: string; editor: string; summary: string; trigger: string; }

// P15：PDE 引擎裁决摘要（面板异步 fetch 后传入；无引擎结果时 skip 该章不 crash）
export interface PdeBrief {
  pwin?: number;             // 赢面 0..1
  action?: string;           // RAISE|CALL|CHECK|FOLD
  actionLabel?: string;      // 「⬆强攻/▶跟进/🔍摸底/⛔止损」（前端 ACT_LABEL 映射结果）
  reason?: string;           // 引擎给的理由
  weakNames?: string[];      // 薄弱关键人（已解析为姓名）
  nominal?: number;          // 名义分
  weighted?: number;         // 加权分（可信度折扣）
  snapshotsTrend?: string;   // 近 N 次快照走势文案（如 "62% → 58% → 44%（近3次）"）
  gate?: 'clear' | 'no_pot' | 'low_confidence'; // 门控（金额/置信降级提示）
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const v = (s: string | undefined | null) => (s && String(s).trim() ? String(s).trim() : '⏳ 待补充');
const mark = (b: boolean | undefined) => (b ? '✅ 已掌握' : '⏳ 待补充');
const sentChar = (r?: OppRole) => (r ? SENTIMENT_CHAR[r.sentiment] : '？');

/** 渲染版本日志表（七/八章共用）；空日志给一行 v1.0 初始占位 */
function renderVersionLog(log: VersionLogEntry[], scope: string): string {
  const rows = log.length
    ? log.map((e) => `| ${e.version} | ${e.date} | ${e.editor || '—'} | ${e.summary} | ${e.trigger || '—'} |`)
    : [`| v1.0 | ⏳ | — | 基于 G64111 v1.1 母版初始化${scope} | 建档 |`];
  return ['| 版本 | 日期 | 更新人 | 更新内容摘要 | 触发来源 |', '|------|------|--------|-------------|----------|', ...rows].join('\n');
}

/** 取某人在本客户名下「第一个出现」的角色（账户级总图：跨商机可能不同，取代表性的一个） */
function primaryRole(account: Account, personId: string): OppRole | undefined {
  for (const o of account.opportunities) { const r = o.roles.find((x) => x.personId === personId); if (r) return r; }
  return undefined;
}

// ───────────────────────── 客户档案（Account 级） ─────────────────────────

export function renderCustomerMd(account: Account, log: VersionLogEntry[] = []): string {
  const scored = account.opportunities.map((o) => ({ o, b: scoreFromDomain(account, o) }));
  const best = scored.reduce<null | (typeof scored)[number]>((m, x) => (x.b.percent > (m?.b.percent ?? -Infinity) ? x : m), null);
  const last = log[log.length - 1];
  const L: string[] = [];

  L.push(`# ${account.name} · 客户档案（数字能源 G64111 作战地图）`, '');
  L.push('<!-- f:account.meta -->');
  L.push(`> **客户全称**：${account.name}　|　**客户类型**：${CUSTOMER_TYPE_LABEL[account.customerType]}（type=${account.customerType}）`);
  L.push(`> **大区**：${v(account.region)}　|　**集团/母公司**：${v(account.group)}　|　**主负责人**：${v(account.primaryOwner)}`);
  if (account.unifiedCreditCode) L.push(`> **统一社会信用代码**：${account.unifiedCreditCode}`);
  L.push(`> **在跟商机数**：${account.opportunities.length}　|　**最高趋赢力**：${best ? `${pct(best.b.percent)} · ${BAND_LABEL[best.b.band]}（${best.o.name}）` : '—'}`);
  L.push(`> **最近更新**：${last?.date ?? '⏳'}　|　**当前版本**：${last?.version ?? 'v1.0'}`);
  L.push('', '---', '');

  // 一、客户画像
  L.push('## 一、客户画像与分类', '');
  L.push('<!-- f:account.profile -->');
  L.push('| 维度 | 内容 |', '|------|------|');
  const pf = account.profile ?? {};
  L.push(`| 客户类型 | ${CUSTOMER_TYPE_LABEL[account.customerType]} |`);
  L.push(`| 工商基础 | ${v(pf.business)} |`);
  L.push(`| 集团关系 | ${v(pf.group)} |`);
  L.push(`| 招投标 | ${v(pf.bidding)} |`);
  L.push(`| 风险信号 | ${v(pf.risk)} |`);
  L.push(`| 我方现有合作 | ${v(pf.ourCooperation)} |`);
  L.push(`| 销售背景 | ${v(pf.salesNote)} |`);
  if (pf.aiSuggestion) L.push(`| AI 建议（参考·不计分） | ${pf.aiSuggestion} |`);
  L.push('');

  // 二、ADURC 组织
  L.push('## 二、ADURC 组织结构与角色图谱（账户级总图）', '');
  L.push('<!-- f:account.roles -->');
  L.push('| 姓名 | ADURC 角色 | 倾向性 | 部门/职位 | 教练级 | 关注点/备注 |', '|------|-----------|--------|-----------|--------|-------------|');
  for (const p of account.persons) {
    if (p.isCompetitor) continue;
    const r = primaryRole(account, p.id);
    const role = r ? `${r.role} ${ROLE_LABEL[r.role]}` : '⏳ 未指派';
    const coach = r?.role === 'C' && p.coachLevel ? `L${p.coachLevel}` : '—';
    L.push(`| ${p.name} | ${role} | ${sentChar(r)} | ${v(p.title)} | ${coach} | ${p.title || ''} |`);
  }
  const competitors = account.persons.filter((p) => p.isCompetitor);
  if (competitors.length) L.push('', `> 友商（不计角色）：${competitors.map((c) => c.name).join('、')}`);
  L.push('');

  // 三、关键人物 FORM（仅 A/D，FORM 是 C1/C2 依据）
  L.push('## 三、关键人物深度档案（FORM 表 + BI）', '');
  const keyPersonIds = new Set<string>();
  for (const o of account.opportunities) for (const r of o.roles) if (r.role === 'A' || r.role === 'D') keyPersonIds.add(r.personId);
  const keyPersons = account.persons.filter((p) => keyPersonIds.has(p.id));
  if (!keyPersons.length) L.push('> ⏳ 尚未识别 A/D 关键人，FORM 卡待建。', '');
  for (const p of keyPersons) {
    const r = primaryRole(account, p.id);
    L.push(`### ${p.name} · ${r ? ROLE_LABEL[r.role] : ''}`, '');
    L.push(`<!-- f:person.form:${p.id} -->`);
    L.push('| FORM 维度 | 内容 |', '|-----------|------|');
    for (const q of FAMILY_7Q) L.push(`| ${q} | ${v(p.form.family7?.[q])} |`);
    L.push(`| 职业经历 | ${v(p.form.occupation)} |`);
    L.push(`| 爱好/志趣 | ${v(p.form.recreation)} |`);
    L.push(`| 金钱与动机 | ${v(p.form.moneyMotivation)} |`);
    // BI / UCV（取该人在各商机的）
    const bis = account.opportunities.flatMap((o) => o.bis.filter((b) => b.personId === p.id).map((b) => ({ o, b })));
    if (bis.length) {
      L.push('', '**燃眉之急 BI**：');
      for (const { o, b } of bis) L.push(`- [${o.name}] ${b.description}（${b.category}·${b.confidence}）`);
    }
    L.push('');
  }

  // 四、项目机会索引
  L.push('## 四、项目机会索引（详情见各商机档案）', '');
  L.push('<!-- f:account.opps -->');
  L.push('| 机会 | 项目名称 | 单一销售目标 | 介入阶段 | 趋赢力 | 竞争态势 | 主要对手 |', '|------|----------|--------------|----------|--------|----------|----------|');
  scored.forEach(({ o, b }, i) => {
    L.push(`| 机会${String.fromCharCode(65 + i)} | ${o.name} | ${v(o.singleSalesGoal)} | ${o.engageStage} | ${pct(b.percent)} | ${BAND_LABEL[b.band]} | ${v(o.competitor)} |`);
  });
  if (!scored.length) L.push('| — | ⏳ 暂无商机 | | | | | |');
  L.push('');

  // 六、资源
  L.push('## 六、资源调配', '');
  const res = account.strategyResources ?? [];
  if (res.length) {
    L.push('| 弹药/资源 | 类型 | 说明 |', '|-----------|------|------|');
    for (const r of res) L.push(`| ${r.label} | ${v(r.kind)} | ${v(r.note)} |`);
  } else L.push('> ⏳ 暂无登记资源。');
  L.push('');

  // 七、拜访记录归档
  L.push('## 七、拜访记录归档', '');
  const visits = account.visitNotes ?? [];
  if (visits.length) {
    for (const vn of visits) {
      const who = vn.participants?.map((x) => `${x.name}(${x.side === 'our' ? '我方' : '客户'})`).join('、') || '⏳';
      L.push(`### ${vn.date || '⏳'} ${vn.topic || '拜访'}`);
      L.push(`- **参与人**：${who}`);
      L.push(`- **纪要**：${v(vn.summary)}`, '');
    }
  } else L.push('> ⏳ 暂无拜访记录。', '');

  // 八、笔记 · 情报（自由文本层 · 挂客户的零散信息，全量导出）
  L.push('## 八、笔记 · 情报', '');
  const cNotes = (account.notes ?? []).filter((n) => !n.personId && !n.opportunityId);
  if (cNotes.length) for (const n of cNotes) L.push(`- ${n.content}${n.source && n.source !== 'manual' ? `（来源：${n.source}）` : ''}`);
  else L.push('> ⏳ 暂无笔记。');
  L.push('');

  // 九、更新日志
  L.push('## 九、更新日志（账户级 · .md 侧维护）', '');
  L.push(renderVersionLog(log, '客户档案'), '');

  return L.join('\n');
}

// ───────────────────────── 商机档案（Opportunity 级） ─────────────────────────

export function renderOpportunityMd(account: Account, opp: Opportunity, log: VersionLogEntry[] = [], pde?: PdeBrief | null): string {
  const b = scoreFromDomain(account, opp);
  const last = log[log.length - 1];
  const nameById = new Map(account.persons.map((p) => [p.id, p.name]));
  const changeModeLabel = CHANGE_MODES.find((c) => c.v === opp.changeMode)?.label ?? '⏳';
  const L: string[] = [];

  L.push(`# ${opp.name}（商机档案）`, '');
  L.push('<!-- f:opp.meta -->');
  L.push(`> **所属客户**：${account.name}　|　**管线阶段**：${opp.pipelineStage}　|　**介入阶段(C4)**：${opp.engageStage}`);
  L.push(`> **单一销售目标**：${v(opp.singleSalesGoal)}`);
  L.push(`> **客户业务目标**：${v(opp.customerBusinessGoal)}　|　**购买动机**：${v(opp.buyingMotivation)}`);
  L.push(`> **客户变化模式**：${changeModeLabel}　|　**主要对手**：${v(opp.competitor)}　|　**竞争态势**：${v(opp.competitiveSituation)}`);
  L.push(`> **趋赢力**：${pct(b.percent)} · ${BAND_LABEL[b.band]}　|　**赢单概率(销售自评)**：${opp.winProbability ? `${opp.winProbability}%` : '⏳'}`);
  L.push(`> **预计签约**：${v(opp.expectedSignDate)}　|　**预计金额**：${opp.expectedAmountW ? `${opp.expectedAmountW} 万元` : '⏳'}`);
  L.push(`> **最近更新**：${last?.date ?? '⏳'}　|　**当前版本**：${last?.version ?? 'v1.0'}`);
  L.push('', '---', '');

  // 一、立项 C3
  L.push('## 一、项目基本信息（C3 立项 + C4 介入阶段）', '');
  L.push('<!-- f:opp.c3 -->');
  L.push('| 立项要素 | 状态 |', '|----------|------|');
  for (const k of C3_ITEMS) L.push(`| ${k} | ${mark(opp.c3Items?.[k])} |`);
  L.push(`| **介入阶段(C4)** | ${opp.engageStage} |`, '');

  // 二、招采 C5 + P2
  L.push('## 二、招采事项（C5 + P2 招采关键人）', '');
  L.push('<!-- f:opp.c5 -->');
  L.push('| 招采要素 | 状态 |', '|----------|------|');
  for (const k of C5_ITEMS) L.push(`| ${k} | ${mark(opp.c5Items?.[k])} |`);
  L.push('');
  const proc = opp.roles.filter((r) => r.procurementType);
  if (proc.length) {
    L.push('**招采关键人公关进度（P2）**：', '');
    L.push('| 招采角色 | 干系人 | 接触深度 |', '|----------|--------|----------|');
    for (const r of proc) L.push(`| ${PROCUREMENT_TYPE_LABEL[r.procurementType!]} | ${nameById.get(r.personId) ?? r.personId} | ${PROCUREMENT_STATUS_LABEL[r.procurementStatus ?? 'none']} |`);
    L.push('');
  }

  // 三、G64111 打分
  L.push('## 三、G64111 趋赢力打分摘要', '');
  L.push('<!-- f:opp.score（只读·由系统据角色/BI/UCV/招采实时算，回写以系统为准） -->');
  L.push('| 类别 | 编号 | 满分 | 当前分 |', '|------|------|------|--------|');
  const groups: [string, ItemKey[]][] = [['6必清', ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']], ['4优势', ['P1', 'P2', 'P3', 'P4']], ['1决胜', ['1K']]];
  for (const [g, keys] of groups) for (const k of keys) L.push(`| ${g} | ${k} | ${ITEM_MAX[k]} | ${round1(b.items[k])} |`);
  L.push(`| **合计** | — | **100** | **${round1(b.total)}** |`, '');
  L.push(`- **趋赢力百分比**：${pct(b.percent)}　**竞争态势**：${BAND_LABEL[b.band]}`, '');

  // 四、741 策略
  L.push('## 四、竞争态势与策略（741）', '');
  L.push('<!-- f:opp.strategy -->');
  L.push(`- **主要竞争对手**：${v(opp.competitor)}`);
  L.push(`- **态势**：${BAND_LABEL[b.band]}`);
  L.push(`- **推荐打法**：${BAND_STRATEGY[b.band]}`);
  L.push(`- **我方产品/方案**：${v(opp.productSolution)}`, '');

  // 五、行动计划
  L.push('## 五、行动计划（按得分缺口排兵布阵）', '');
  L.push('<!-- f:opp.actions -->');
  const actions = (account.planActions ?? []).filter((a) => a.opportunityId === opp.id);
  if (actions.length) {
    L.push('| 缺口 | 动作 | 人物 | 话术要点 | 完成时间 | 状态 |', '|------|------|------|----------|----------|------|');
    for (const a of actions) {
      const who = a.personId ? nameById.get(a.personId) ?? '' : '';
      L.push(`| ${v(a.gapItem)} | ${a.title} | ${who} | ${v(a.scripts)} | ${v(a.startDate)} | ${a.done ? '✅ 已完成' : '进行中'} |`);
    }
  } else L.push('> ⏳ 暂无行动计划。');
  L.push('');

  // ── P15 商机档案叙事组装（数据全在库/引擎，纯拼装；缺则跳过该章）──

  // 六、引擎裁决摘要（PDE：动作 + 理由 + 薄弱关键人 + 双轨分 + 走势）
  if (pde) {
    L.push('## 六、引擎裁决摘要（PDE · 只读）', '');
    L.push('<!-- f:opp.pde -->');
    if (pde.actionLabel || pde.action) L.push(`- **建议动作**：${pde.actionLabel || pde.action}${pde.pwin != null ? ` · **赢面** ${Math.round(pde.pwin * 100)}%` : ''}`);
    if (pde.reason) L.push(`- **理由**：${pde.reason}`);
    if (pde.weakNames && pde.weakNames.length) L.push(`- **薄弱关键人**：${pde.weakNames.join('、')}（先修这几个人，回报最高）`);
    if (pde.nominal != null || pde.weighted != null) L.push(`- **双轨分**：名义 ${round1(pde.nominal ?? 0)} / 加权 ${round1(pde.weighted ?? 0)}（差 = 情报未坐实的部分）`);
    if (pde.snapshotsTrend) L.push(`- **赢面走势**：${pde.snapshotsTrend}`);
    if (pde.gate && pde.gate !== 'clear') L.push(`- ⚠️ **门控提示**：${pde.gate === 'no_pot' ? '未填合同额，金额已降级为纯排序' : '置信度偏低，建议先摸底再动手'}`);
    L.push('');
  }

  // 七、策略卡（打法方向）——挂 Account 层，按 opp.id 过滤
  const cards = (account.strategyCards ?? []).filter((c) => c.opportunityId === opp.id && c.status !== 'dismissed');
  if (cards.length) {
    L.push('## 七、策略卡（打法方向）', '');
    L.push('<!-- f:opp.cards -->');
    L.push('| 缺口 | 打法标题 | 目标人 | 依据 | 来源 | 已派发 |', '|------|---------|--------|------|------|--------|');
    for (const c of cards) {
      const who = c.personId ? (nameById.get(c.personId) ?? '') : '';
      const dispatched = c.dispatchedActionIds?.length ? `${c.dispatchedActionIds.length}` : '—';
      L.push(`| ${v(c.gapItem)} | ${v(c.title)} | ${v(who)} | ${v(c.basis)} | ${c.origin === 'ai' ? '🤖 AI' : '✍️ 手'} | ${dispatched} |`);
    }
    L.push('');
  }

  // 八、⚠ 雷（人工登记的高危风险）——挂 Account 层，按 opp.id 过滤；kind='risk'，assumption 不展示
  const risks = (account.strategyRisks ?? []).filter((r) => r.opportunityId === opp.id && r.kind === 'risk' && r.status !== 'dismissed');
  if (risks.length) {
    L.push('## 八、⚠ 雷（高危风险登记）', '');
    L.push('<!-- f:opp.risks -->');
    L.push('| 雷 | 严重度 | 缓解措施 | 状态 |', '|----|--------|----------|------|');
    for (const r of risks) {
      const sev = r.severity === 'high' ? '🔴 高' : r.severity === 'mid' ? '🟠 中' : r.severity === 'low' ? '🟡 低' : '—';
      L.push(`| ${v(r.text)} | ${sev} | ${v(r.mitigation)} | ${r.status === 'resolved' ? '✅ 已解' : '📌 未解'} |`);
    }
    L.push('');
  }

  // 九、证据时间线（M3 approved 才入正式叙事；pending/rejected 跳过）
  const evs = (opp.evidenceEvents ?? []).filter((e) => e.status !== 'rejected').slice().sort((a, b) => {
    const da = a.occurredAt || a.createdAt || ''; const db = b.occurredAt || b.createdAt || '';
    return db.localeCompare(da);
  }).slice(0, 30);
  if (evs.length) {
    L.push('## 九、证据时间线（近期 30 条 · 按时间倒序）', '');
    L.push('<!-- f:opp.evidence -->');
    L.push('| 日期 | 人 | 方向 | 档 | 内容 | 溯源 | 状态 |', '|------|----|------|----|------|------|------|');
    for (const e of evs) {
      const d = (e.occurredAt || e.createdAt || '').slice(0, 10) || '⏳';
      const who = nameById.get(e.personId) ?? '?';
      const dir = e.direction > 0 ? '➕' : e.direction < 0 ? '➖' : '○';
      const tier = e.tier === 'strong' ? '强' : e.tier === 'mid' ? '中' : e.tier === 'weak' ? '弱' : '—';
      const src = e.origin === 'voice' ? '🎙️口述' : e.origin === 'recording' ? '🎧录音' : e.origin === 'manual' ? '✍️手动' : (e.origin ?? '—');
      const st = e.status === 'pending_review' ? '⏳待审' : '✅已批';
      L.push(`| ${d} | ${who} | ${dir} | ${tier} | ${v(e.rawContent)} | ${src} | ${st} |`);
    }
    L.push('');
  }

  // 十、笔记 · 情报（自由文本层 · 挂本商机的零散信息，全量导出）
  L.push('## 十、笔记 · 情报', '');
  const oNotes = (account.notes ?? []).filter((n) => n.opportunityId === opp.id);
  if (oNotes.length) for (const n of oNotes) L.push(`- ${n.content}${n.source && n.source !== 'manual' ? `（来源：${n.source}）` : ''}`);
  else L.push('> ⏳ 暂无笔记。');
  L.push('');

  // 十一、更新日志
  L.push('## 十一、更新日志（商机级 · .md 侧维护）', '');
  L.push(renderVersionLog(log, '商机档案'), '');

  return L.join('\n');
}

// ───────────────────────── 拜访记录（单条） ─────────────────────────

export function renderVisitMd(account: Account, visit: VisitNote): string {
  const oppName = visit.opportunityId ? account.opportunities.find((o) => o.id === visit.opportunityId)?.name : '';
  const who = visit.participants?.map((x) => `${x.name}（${x.side === 'our' ? '我方' : '客户方'}）`).join('、') || '⏳ 待补充';
  const L: string[] = [];
  L.push(`# 拜访记录 · ${visit.date || '⏳'} ${visit.topic || ''}`, '');
  L.push('<!-- f:visit.meta -->');
  L.push(`> **客户**：${account.name}${oppName ? `　|　**关联商机**：${oppName}` : ''}`);
  L.push(`> **日期**：${visit.date || '⏳'}　|　**主题**：${v(visit.topic)}　|　**来源**：${visit.origin || 'manual'}`);
  L.push(`> **参与人**：${who}`, '', '---', '');
  L.push('## 纪要正文', '');
  L.push('<!-- f:visit.summary -->');
  L.push(v(visit.summary), '');
  return L.join('\n');
}

const round1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

// ═════════════════════════ MD → 系统（块C 回写解析） ═════════════════════════
// 与上面的 render* 严格对称：只解析「可靠双向」字段（文本/勾选）。
// 打分(opp.score)、角色映射(account.roles)、客户名/类型 一律【只读】不回写——见设计取舍。
// round-trip 红线：parse(render(x)) 对可回写字段还原 x（占位符 ⏳ ↔ 空值）。

const PLACEHOLDER = /^(⏳ 待补充|⏳|—|\[.*\])$/;
/** 逆 v()：占位符 → 空串；其余 trim。 */
const unv = (s: string): string => { const t = s.trim(); return PLACEHOLDER.test(t) ? '' : t; };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 取 markdown 表格行 `| 键 | 值 |` 的值（首个匹配，按行锚定） */
function cell(md: string, key: string): string | undefined {
  const m = md.match(new RegExp(`^\\|\\s*${esc(key)}\\s*\\|\\s*(.+?)\\s*\\|`, 'm'));
  return m ? m[1] : undefined;
}
/** 取引用块 `**键**：值`（截断于 全角分隔　/ 竖线 / 行尾） */
function meta(md: string, key: string): string | undefined {
  const m = md.match(new RegExp(`\\*\\*${esc(key)}\\*\\*：([^　\\n|]+)`));
  return m ? m[1].trim() : undefined;
}
const truthyMark = (s: string) => /已掌握|✅/.test(s);

/** 客户档案 MD → Account patch（仅可靠双向字段；名称/类型/角色只读） */
export function parseCustomerMd(md: string, account: Account): Partial<Account> {
  const patch: Partial<Account> = {};
  const region = meta(md, '大区'); if (region !== undefined) patch.region = unv(region);
  const group = meta(md, '集团/母公司'); if (group !== undefined) patch.group = unv(group);
  const owner = meta(md, '主负责人'); if (owner !== undefined) patch.primaryOwner = unv(owner);
  const prof: AccountProfile = { ...(account.profile ?? {}) };
  const fields: [string, keyof AccountProfile][] = [
    ['工商基础', 'business'], ['集团关系', 'group'], ['招投标', 'bidding'],
    ['风险信号', 'risk'], ['我方现有合作', 'ourCooperation'], ['销售背景', 'salesNote'],
  ];
  let profChanged = false;
  for (const [label, k] of fields) { const c = cell(md, label); if (c !== undefined) { prof[k] = unv(c); profChanged = true; } }
  if (profChanged) patch.profile = prof;
  return patch;
}

/** 商机档案 MD → Opportunity patch（文本字段 + C3/C5 勾选；打分/态势只读） */
export function parseOpportunityMd(md: string, opp: Opportunity): Partial<Opportunity> {
  const patch: Partial<Opportunity> = {};
  const sg = meta(md, '单一销售目标'); if (sg !== undefined) patch.singleSalesGoal = unv(sg);
  const cbg = meta(md, '客户业务目标'); if (cbg !== undefined) patch.customerBusinessGoal = unv(cbg);
  const bm = meta(md, '购买动机'); if (bm !== undefined) patch.buyingMotivation = unv(bm);
  const comp = meta(md, '主要对手'); if (comp !== undefined) patch.competitor = unv(comp);
  const c3: Record<string, boolean> = { ...opp.c3Items };
  for (const k of C3_ITEMS) { const c = cell(md, k); if (c !== undefined) c3[k] = truthyMark(c); }
  patch.c3Items = c3;
  const c5: Record<string, boolean> = { ...opp.c5Items };
  for (const k of C5_ITEMS) { const c = cell(md, k); if (c !== undefined) c5[k] = truthyMark(c); }
  patch.c5Items = c5;
  return patch;
}

/** 拜访记录 MD → VisitNote patch（主题 + 纪要正文） */
export function parseVisitMd(md: string): Partial<VisitNote> {
  const patch: Partial<VisitNote> = {};
  const topic = meta(md, '主题'); if (topic !== undefined) patch.topic = unv(topic);
  const m = md.match(/## 纪要正文\s*\n(?:<!--[\s\S]*?-->\s*\n)?([\s\S]*?)\s*$/);
  if (m) patch.summary = unv(m[1]);
  return patch;
}
