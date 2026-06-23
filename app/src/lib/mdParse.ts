// MD → 系统 双向回写（块C）。把用户编辑过的 .md 解析回字段，与「系统当前 render 再 parse」做 diff，
// 只为真正改动的白名单字段生成既有 UPDATE_* Action。评分只读区/角色表/行动计划不回写（见 README of 块C）。
//
// 设计红线：
//  1) 往返幂等——baseline = parse(render(实体))，target = parse(编辑后)，两者走「同一 render+parse 管线」，
//     占位符处理一致 ⇒ 未编辑字段 baseline===target 无 diff。详见 mdParse.test.ts 的幂等用例。
//  2) 并发安全——opp/person 锚点埋 version（mdProfile 渲染），回写显式带 baseVersion 复用乐观锁（后端不匹配→409 重拉）。
//  3) 占位符不污染——「⏳ 待补充」归一为空串，避免把占位符当真实空值写回。
import type { Action } from '../store';
import type { Account, Opportunity, VisitNote, Form, AccountProfile, CompetitiveSituation } from '../types';
import { FAMILY_7Q, C3_ITEMS, C5_ITEMS } from '../types';
import { renderCustomerMd, renderOpportunityMd, renderVisitMd } from './mdProfile';

// ───────────────────────── 段切片（按 <!-- f:KEY [v=N] --> 锚点）─────────────────────────

interface Section { key: string; subId?: string; version?: number; lines: string[] }

/** 按字段锚点注释把 .md 切成段。person.form:PID 拆出 subId；锚点行的 v=N 解析为 version。 */
function sliceSections(md: string): Section[] {
  const secs: Section[] = [];
  let cur: Section | null = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^<!--\s*f:([^\s（(>]+)([^>]*)-->\s*$/);
    if (m) {
      const full = m[1];
      const vm = (m[2] ?? '').match(/\bv=(\d+)/);
      const ci = full.indexOf(':');
      const key = ci >= 0 ? full.slice(0, ci) : full;
      const subId = ci >= 0 ? full.slice(ci + 1) : undefined;
      cur = { key, subId, version: vm ? Number(vm[1]) : undefined, lines: [] };
      secs.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return secs;
}
const findSec = (secs: Section[], key: string) => secs.find((s) => s.key === key);

// ───────────────────────── 值归一 / 行解析 ─────────────────────────

const PLACEHOLDERS = new Set(['⏳ 待补充', '⏳', '—', '']);
/** 占位符 / 空白 → 空串；其余 trim。回写比较与落库都用归一后的值。 */
const norm = (s: string | undefined): string => {
  const t = (s ?? '').trim();
  return PLACEHOLDERS.has(t) ? '' : t;
};

/** 解析 Markdown 表格的数据行（剥首尾管道、跳过 |---| 分隔行）。返回每行的单元格数组。 */
function parseRows(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|?$/.test(line)) continue; // |------|------| 分隔行
    const cells = line.split('|').map((c) => c.trim());
    if (cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    rows.push(cells);
  }
  return rows;
}
/** 两列表格 → { 列1: 列2 }（内容列含管道时拼回，容错）。 */
function kvFromRows(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of parseRows(lines)) if (r.length >= 2) out[r[0].replace(/\*\*/g, '').trim()] = r.slice(1).join('|').trim();
  return out;
}
/** blockquote 多字段：`> **label**：v　|　**label2**：v2` → { label: v, label2: v2 }。 */
function kvFromBlockquote(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of lines) {
    if (!raw.trimStart().startsWith('>')) continue;
    const body = raw.replace(/^\s*>\s?/, '');
    for (const seg of body.split('　|　')) {
      const m = seg.match(/\*\*(.+?)\*\*[：:]\s*(.*)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
  }
  return out;
}
/** 列表多字段：`- **label**：v` → { label: v }。 */
function kvFromList(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of lines) {
    const m = raw.trim().match(/^[-*]\s*\*\*(.+?)\*\*[：:]\s*(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}
/** checklist 表格（| 项 | ✅已掌握/⏳待补充 |）→ { 项: boolean }，仅取白名单 items。 */
function parseChecklist(lines: string[], items: readonly string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const r of parseRows(lines)) {
    if (r.length < 2) continue;
    const key = r[0].replace(/\*\*/g, '').replace(/[（(].*$/, '').trim(); // 去掉 **介入阶段(C4)** 之类
    if ((items as readonly string[]).includes(key)) out[key] = /✅|已掌握/.test(r.slice(1).join('|'));
  }
  return out;
}
/** 正文段（拜访纪要）：锚点后所有行拼回，归一。 */
const bodyText = (lines: string[]): string => norm(lines.join('\n').trim());

const parsePercent = (s: string | undefined): number | undefined => {
  const m = (s ?? '').match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : undefined;
};
const parseAmount = (s: string | undefined): number | undefined => {
  if (norm(s) === '') return undefined;
  const m = (s ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : undefined;
};
const COMPETITIVE: readonly string[] = ['领先', '胶着', '落后', '未识别'];
const mapCompetitive = (s: string): CompetitiveSituation => (COMPETITIVE.includes(s) ? (s as CompetitiveSituation) : '');

// ───────────────────────── 解析结果类型 ─────────────────────────

export interface CustomerParse {
  account: { region: string; group: string; primaryOwner: string };
  profile: { business: string; group: string; bidding: string; risk: string; ourCooperation: string; salesNote: string };
  forms: { id: string; version?: number; family7: Record<string, string>; occupation: string; recreation: string; moneyMotivation: string }[];
}
export interface OppParse {
  version?: number;
  meta: {
    singleSalesGoal: string; customerBusinessGoal: string; buyingMotivation: string;
    competitor: string; competitiveSituation: CompetitiveSituation;
    winProbability?: number; expectedSignDate: string; expectedAmountW?: number;
  };
  c3: Record<string, boolean>;
  c5: Record<string, boolean>;
  strategy: { productSolution: string };
}
export interface VisitParse { topic: string; summary: string }

// ───────────────────────── 解析器（MD 文本 → 字段）─────────────────────────

export function parseCustomerMd(md: string): CustomerParse {
  const secs = sliceSections(md);
  const meta = findSec(secs, 'account.meta');
  const prof = findSec(secs, 'account.profile');
  const mk = meta ? kvFromBlockquote(meta.lines) : {};
  const pm = prof ? kvFromRows(prof.lines) : {};
  const forms = secs.filter((s) => s.key === 'person.form' && s.subId).map((s) => {
    const m = kvFromRows(s.lines);
    const family7: Record<string, string> = {};
    for (const q of FAMILY_7Q) family7[q] = norm(m[q]);
    return {
      id: s.subId!, version: s.version, family7,
      occupation: norm(m['职业经历']), recreation: norm(m['爱好/志趣']), moneyMotivation: norm(m['金钱与动机']),
    };
  });
  return {
    account: { region: norm(mk['大区']), group: norm(mk['集团/母公司']), primaryOwner: norm(mk['主负责人']) },
    profile: {
      business: norm(pm['工商基础']), group: norm(pm['集团关系']), bidding: norm(pm['招投标']),
      risk: norm(pm['风险信号']), ourCooperation: norm(pm['我方现有合作']), salesNote: norm(pm['销售背景']),
    },
    forms,
  };
}

export function parseOpportunityMd(md: string): OppParse {
  const secs = sliceSections(md);
  const meta = findSec(secs, 'opp.meta');
  const kv = meta ? kvFromBlockquote(meta.lines) : {};
  const c3sec = findSec(secs, 'opp.c3'); const c5sec = findSec(secs, 'opp.c5'); const strat = findSec(secs, 'opp.strategy');
  const stratKv = strat ? kvFromList(strat.lines) : {};
  return {
    version: meta?.version,
    meta: {
      singleSalesGoal: norm(kv['单一销售目标']), customerBusinessGoal: norm(kv['客户业务目标']),
      buyingMotivation: norm(kv['购买动机']), competitor: norm(kv['主要对手']),
      competitiveSituation: mapCompetitive(norm(kv['竞争态势'])),
      winProbability: parsePercent(kv['赢单概率(销售自评)']),
      expectedSignDate: norm(kv['预计签约']), expectedAmountW: parseAmount(kv['预计金额']),
    },
    c3: c3sec ? parseChecklist(c3sec.lines, C3_ITEMS) : {},
    c5: c5sec ? parseChecklist(c5sec.lines, C5_ITEMS) : {},
    strategy: { productSolution: norm(stratKv['我方产品/方案']) },
  };
}

export function parseVisitMd(md: string): VisitParse {
  const secs = sliceSections(md);
  const meta = findSec(secs, 'visit.meta');
  const kv = meta ? kvFromBlockquote(meta.lines) : {};
  const sum = findSec(secs, 'visit.summary');
  return { topic: norm(kv['主题']), summary: sum ? bodyText(sum.lines) : '' };
}

// ───────────────────────── Diff（编辑后 MD → Action[]）─────────────────────────

/** 一条字段改动（确认弹窗预览用）。from/to 为归一后文本，空串由 UI 显示为「（空）」。 */
export interface MdChange { section: string; from: string; to: string }
export interface MdApplyResult { actions: Action[]; changes: MdChange[] }

const FAMILY_LABEL_MAP: [keyof CustomerParse['profile'], string][] = [
  ['business', '工商基础'], ['group', '集团关系'], ['bidding', '招投标'],
  ['risk', '风险信号'], ['ourCooperation', '我方现有合作'], ['salesNote', '销售背景'],
];

export function diffCustomer(account: Account, edited: string): MdApplyResult {
  const baseline = parseCustomerMd(renderCustomerMd(account, []));
  const target = parseCustomerMd(edited);
  const changes: MdChange[] = [];
  const actions: Action[] = [];

  // 客户顶层 + profile 合并为一个 UPDATE_ACCOUNT
  const accPatch: Partial<Account> = {};
  const accFields: [keyof CustomerParse['account'], string, 'region' | 'group' | 'primaryOwner'][] = [
    ['region', '大区', 'region'], ['group', '集团/母公司', 'group'], ['primaryOwner', '主负责人', 'primaryOwner'],
  ];
  for (const [pk, label, ak] of accFields) {
    if (baseline.account[pk] !== target.account[pk]) {
      accPatch[ak] = target.account[pk];
      changes.push({ section: '客户·' + label, from: baseline.account[pk], to: target.account[pk] });
    }
  }
  const profChanged: Partial<AccountProfile> = {};
  let profDirty = false;
  for (const [pk, label] of FAMILY_LABEL_MAP) {
    if (baseline.profile[pk] !== target.profile[pk]) {
      profChanged[pk] = target.profile[pk]; profDirty = true;
      changes.push({ section: '客户画像·' + label, from: baseline.profile[pk], to: target.profile[pk] });
    }
  }
  if (profDirty) accPatch.profile = { ...(account.profile ?? {}), ...profChanged };
  if (Object.keys(accPatch).length) actions.push({ type: 'UPDATE_ACCOUNT', accId: account.id, patch: accPatch });

  // 人物 FORM → UPDATE_PERSON（带 MD 埋的 baseVersion）
  for (const tf of target.forms) {
    const bf = baseline.forms.find((f) => f.id === tf.id);
    const person = account.persons.find((p) => p.id === tf.id);
    if (!bf || !person) continue;
    const newForm: Form = { ...person.form, family7: { ...(person.form.family7 ?? {}) } };
    let dirty = false;
    for (const q of FAMILY_7Q) {
      if (bf.family7[q] !== tf.family7[q]) { newForm.family7[q] = tf.family7[q]; dirty = true; changes.push({ section: `${person.name}·FORM·${q}`, from: bf.family7[q], to: tf.family7[q] }); }
    }
    const txt: ['occupation' | 'recreation' | 'moneyMotivation', string][] = [['occupation', '职业经历'], ['recreation', '爱好/志趣'], ['moneyMotivation', '金钱与动机']];
    for (const [pk, label] of txt) {
      if (bf[pk] !== tf[pk]) { newForm[pk] = tf[pk]; dirty = true; changes.push({ section: `${person.name}·FORM·${label}`, from: bf[pk], to: tf[pk] }); }
    }
    if (dirty) actions.push({ type: 'UPDATE_PERSON', accId: account.id, personId: person.id, patch: { form: newForm }, baseVersion: tf.version });
  }
  return { actions, changes };
}

export function diffOpportunity(account: Account, opp: Opportunity, edited: string): MdApplyResult {
  const baseline = parseOpportunityMd(renderOpportunityMd(account, opp, []));
  const target = parseOpportunityMd(edited);
  const changes: MdChange[] = [];
  const patch: Partial<Opportunity> = {};

  const txtFields: [keyof OppParse['meta'], string, 'singleSalesGoal' | 'customerBusinessGoal' | 'buyingMotivation' | 'competitor' | 'expectedSignDate'][] = [
    ['singleSalesGoal', '单一销售目标', 'singleSalesGoal'], ['customerBusinessGoal', '客户业务目标', 'customerBusinessGoal'],
    ['buyingMotivation', '购买动机', 'buyingMotivation'], ['competitor', '主要对手', 'competitor'], ['expectedSignDate', '预计签约', 'expectedSignDate'],
  ];
  for (const [mk, label, ok] of txtFields) {
    const b = String(baseline.meta[mk] ?? ''); const t = String(target.meta[mk] ?? '');
    if (b !== t) { patch[ok] = t; changes.push({ section: '商机·' + label, from: b, to: t }); }
  }
  if (baseline.meta.competitiveSituation !== target.meta.competitiveSituation) {
    patch.competitiveSituation = target.meta.competitiveSituation;
    changes.push({ section: '商机·竞争态势', from: baseline.meta.competitiveSituation, to: target.meta.competitiveSituation });
  }
  // 数值：仅当编辑后有值且不同才写（不支持经 MD 清空数值，避免 undefined 序列化歧义）
  if (target.meta.winProbability !== undefined && target.meta.winProbability !== baseline.meta.winProbability) {
    patch.winProbability = target.meta.winProbability;
    changes.push({ section: '商机·赢单概率', from: baseline.meta.winProbability != null ? `${baseline.meta.winProbability}%` : '', to: `${target.meta.winProbability}%` });
  }
  if (target.meta.expectedAmountW !== undefined && target.meta.expectedAmountW !== baseline.meta.expectedAmountW) {
    patch.expectedAmountW = target.meta.expectedAmountW;
    changes.push({ section: '商机·预计金额', from: baseline.meta.expectedAmountW != null ? `${baseline.meta.expectedAmountW}万` : '', to: `${target.meta.expectedAmountW}万` });
  }
  if (baseline.strategy.productSolution !== target.strategy.productSolution) {
    patch.productSolution = target.strategy.productSolution;
    changes.push({ section: '商机·我方产品/方案', from: baseline.strategy.productSolution, to: target.strategy.productSolution });
  }
  // C3 / C5 勾选（影响 G64111，引擎据 c3Items/c5Items 自动重算）
  const c3Changed: Record<string, boolean> = {}; let c3Dirty = false;
  for (const k of C3_ITEMS) {
    const b = baseline.c3[k] ?? false; const t = target.c3[k] ?? false;
    if (b !== t) { c3Changed[k] = t; c3Dirty = true; changes.push({ section: '立项C3·' + k, from: b ? '已掌握' : '待补充', to: t ? '已掌握' : '待补充' }); }
  }
  if (c3Dirty) patch.c3Items = { ...opp.c3Items, ...c3Changed };
  const c5Changed: Record<string, boolean> = {}; let c5Dirty = false;
  for (const k of C5_ITEMS) {
    const b = baseline.c5[k] ?? false; const t = target.c5[k] ?? false;
    if (b !== t) { c5Changed[k] = t; c5Dirty = true; changes.push({ section: '招采C5·' + k, from: b ? '已掌握' : '待补充', to: t ? '已掌握' : '待补充' }); }
  }
  if (c5Dirty) patch.c5Items = { ...opp.c5Items, ...c5Changed };

  const actions: Action[] = [];
  if (Object.keys(patch).length) actions.push({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch, baseVersion: target.version });
  return { actions, changes };
}

export function diffVisit(account: Account, visit: VisitNote, edited: string): MdApplyResult {
  const baseline = parseVisitMd(renderVisitMd(account, visit));
  const target = parseVisitMd(edited);
  const changes: MdChange[] = [];
  const patch: Partial<VisitNote> = {};
  if (baseline.topic !== target.topic) { patch.topic = target.topic; changes.push({ section: '拜访·主题', from: baseline.topic, to: target.topic }); }
  if (baseline.summary !== target.summary) { patch.summary = target.summary; changes.push({ section: '拜访·纪要正文', from: baseline.summary, to: target.summary }); }
  const actions: Action[] = [];
  if (Object.keys(patch).length) actions.push({ type: 'UPDATE_VISIT', accId: account.id, visitId: visit.id, patch });
  return { actions, changes };
}
