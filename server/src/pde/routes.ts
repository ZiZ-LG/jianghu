// PDE 评估主链 API（M3）：ev / intel-priorities / action-ranking / snapshot。
// 铁律：① 全程 tenantId 隔离 ② 引擎产出只读不写业务库（快照除外——快照是留痕不是业务态）
// ③ 赢面永不裸出（响应恒带 confidenceFlag）④ inputsJson 完整留痕（DECISIONS#4，未来校准训练集）。
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  actionDeltaEV, CRED, evaluate, recommend, voiCComp, voiStance, weightedScore,
  type ActionDelta, type Cred, type Deal, type EvalResult, type KernelAction, type Mark,
  type Recommendation, type ScoreResult, type Stage, type Stakeholder,
} from 'pde-kernel';
import { prisma } from '../prisma.js';
import { assembleDeal, type AssembledPde } from './assemble.js';
import { ensureIndustryPack, PACK_KEY } from './pack.js';

const STAGE_ORDER: Stage[] = ['initiation', 'feasibility', 'budget_approval', 'tender_design', 'tender_execution'];

interface InstantiatedAction extends ActionDelta {
  actionKey: string;
  title: string;
  category: string;
  personId: string;
  personName: string;
  gist: string;
  scriptRef: string;
}

function stageInWindow(win: string, stage: Stage): boolean {
  if (!win || win === 'any') return true;
  const [lo, hi] = win.split('..') as [Stage, Stage?];
  const i = STAGE_ORDER.indexOf(stage);
  const a = STAGE_ORDER.indexOf(lo);
  const b = hi ? STAGE_ORDER.indexOf(hi) : a;
  return i >= Math.min(a, b) && i <= Math.max(a, b);
}

function slotMatch(targetSlots: string[], st: Stakeholder): boolean {
  if (targetSlots.includes('any')) return true;
  return st.slots.some((s) => targetSlots.includes(s));
}

/** relationship 类动作 × 当前干系人 → 内核动作实例（无效变换跳过），按 ΔEV 降序。 */
function rankActions(deal: Deal, catalog: Array<{ actionKey: string; category: string; title: string; effectJson: string; costWan: number; stageWindow: string; targetSlots: string; gist: string; scriptRef: string }>, personName: Map<string, string>): InstantiatedAction[] {
  const out: InstantiatedAction[] = [];
  for (const row of catalog) {
    if (row.category !== 'relationship') continue;
    if (!stageInWindow(row.stageWindow, deal.stage)) continue;
    let effect: any; let targets: string[];
    try { effect = JSON.parse(row.effectJson); targets = JSON.parse(row.targetSlots); } catch { continue; }
    for (const st of deal.stakeholders) {
      if (!slotMatch(targets, st)) continue;
      let newMark: Mark | undefined; let newCred: Cred | undefined;
      if (effect.type === 'mark_shift') {
        if (!effect.targetMark || effect.targetMark === st.mark) continue; // 已在目标态，无效动作
        newMark = effect.targetMark;
        newCred = effect.resolvedCred;
      } else if (effect.type === 'cred_upgrade') {
        const target: Cred | undefined = effect.targetCred;
        if (!target) continue;
        const cur = st.mark === 'unk' ? 'unclear' : (st.cred ?? 'unclear');
        if (CRED[target].n <= CRED[cur].n) continue; // 升不动，无效
        newCred = target;
      } else {
        continue; // item_resolve 走 intel-priorities（VoI 口径）
      }
      const act: KernelAction = { id: `${row.actionKey}@${st.id}`, stakeholder_id: st.id, new_mark: newMark, new_cred: newCred, cost: row.costWan };
      const d = actionDeltaEV(deal, act);
      out.push({ ...d, actionKey: row.actionKey, title: row.title, category: row.category, personId: st.id, personName: personName.get(st.id) ?? st.id, gist: row.gist, scriptRef: row.scriptRef });
    }
  }
  out.sort((a, b) => b.dEV - a.dEV);
  return out;
}

function strategy741Label(seeds: any, score: ScoreResult): { posture: string; plays: string[] } | null {
  const total = Number(seeds.scoringSchema.totalScore ?? 100) || 100;
  const ratio = score.weighted / total;
  for (const b of seeds.scoringSchema.strategy741?.bands ?? []) {
    const r: string = b.range;
    if (r.startsWith('>=') && ratio >= parseFloat(r.slice(2))) return { posture: b.posture, plays: b.plays };
    if (r.startsWith('<') && ratio < parseFloat(r.slice(1))) return { posture: b.posture, plays: b.plays };
    const m = r.match(/^([\d.]+)-([\d.]+)$/);
    if (m && ratio >= parseFloat(m[1]!) && ratio < parseFloat(m[2]!)) return { posture: b.posture, plays: b.plays };
  }
  return null;
}

interface PdeComputation {
  asm: AssembledPde;
  seeds: any;
  ev: EvalResult;
  score: ScoreResult;
  actions: InstantiatedAction[];
  recommendation: Recommendation;
  confidenceFlag: string;
  s741: { posture: string; plays: string[] } | null;
}

/** 核心计算（三路由与快照共用）。opp 不存在返回 null。 */
export async function computePde(tenantId: string, oppId: string): Promise<PdeComputation | null> {
  const { seeds } = await ensureIndustryPack(tenantId);
  const asm = await assembleDeal(tenantId, oppId, seeds);
  if (!asm) return null;
  const catalog = await prisma.actionCatalog.findMany({ where: { tenantId } });
  const ev = evaluate(asm.deal);
  const score = weightedScore(asm.deal.items);
  const actions = rankActions(asm.deal, catalog, asm.personName);
  // prevEv：上一张快照的 ev_continue（FOLD 的「连续两期」判据；无快照=null 不触发 FOLD）
  const prevSnap = await prisma.eVSnapshot.findFirst({ where: { tenantId, opportunityId: oppId }, orderBy: { createdAt: 'desc' } });
  let prevEv: number | null = null;
  try { prevEv = prevSnap ? (JSON.parse(prevSnap.resultJson)?.eval?.ev_continue ?? null) : null; } catch { prevEv = null; }
  const recommendation = recommend(ev, actions, ev.stakeholders, score, ev.m_stage, prevEv);
  const flags: string[] = [];
  if (recommendation.action === 'CHECK') flags.push('low_confidence');
  if (asm.potSource === 'missing') flags.push('no_pot');
  return { asm, seeds, ev, score, actions, recommendation, confidenceFlag: flags.join(','), s741: strategy741Label(seeds, score) };
}

/** 无彩池时金额类字段降级（屏效护栏：pot 未填→只给排序不给绝对金额）。 */
const moneyOrNull = (c: PdeComputation, v: number) => (c.asm.potSource === 'missing' ? null : Math.round(v * 100) / 100);

export function pdeRoutes(app: FastifyInstance) {
  // 牌局评估：赢面（带置信）+ 双轨分 + 四动作建议
  app.get('/api/pde/:oppId/ev', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const c = await computePde(req.user.tenantId, req.params.oppId);
    if (!c) return reply.code(404).send({ error: '商机不存在' });
    return {
      opportunity: c.asm.opp,
      pwin: c.ev.pwin, pwin_raw: c.ev.pwin_raw, gate: c.ev.gate, S: c.ev.S,
      ev_continue: moneyOrNull(c, c.ev.ev_continue),
      m_stage: c.ev.m_stage, stage: c.asm.stage, potSource: c.asm.potSource,
      score: c.score,
      recommendation: c.recommendation,
      strategy741: c.s741,
      stakeholders: c.ev.stakeholders.map((d) => ({ ...d, name: c.asm.personName.get(d.id) ?? d.id })),
      confidenceFlag: c.confidenceFlag, // 铁律：赢面永不脱离置信标识返回
    };
  });

  // 情报作战清单（VoI 排序·拜访卡引擎）：立场未知/低可信干系人 + 竞争系数未实测，各挂 info 动作
  app.get('/api/pde/:oppId/intel-priorities', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const c = await computePde(req.user.tenantId, req.params.oppId);
    if (!c) return reply.code(404).send({ error: '商机不存在' });
    const catalog = await prisma.actionCatalog.findMany({ where: { tenantId: req.user.tenantId } });
    const hangable = catalog.map((row) => {
      let targets: string[] = []; let effect: any = {};
      try { targets = JSON.parse(row.targetSlots); effect = JSON.parse(row.effectJson); } catch { /* 忽略坏行 */ }
      return { ...row, targets, effect };
    }).filter((r) => stageInWindow(r.stageWindow, c.asm.stage));
    const infoActions = hangable.filter((r) => r.effect?.type === 'item_resolve');
    // 立场摸底的正确动作 = 可信度升级类（如压力测试）：问的是「这个人」而非「某件事」
    const credActions = hangable.filter((r) => r.effect?.type === 'cred_upgrade');

    const out: any[] = [];
    for (const st of c.asm.deal.stakeholders) {
      const cred = st.mark === 'unk' ? 'unclear' : (st.cred ?? 'unclear');
      if (st.mark !== 'unk' && cred !== 'unclear' && cred !== 'inference') continue; // 已扎实，不进清单
      const v = voiStance(c.asm.deal, st.id);
      const hangs = [...credActions, ...infoActions].filter((a) => slotMatch(a.targets, st)).map((a) => ({ actionKey: a.actionKey, title: a.title, gist: a.gist, scriptRef: a.scriptRef }));
      out.push({
        kind: 'stance', stakeholderId: st.id, name: c.asm.personName.get(st.id) ?? st.id,
        mark: st.mark, cred, voi: moneyOrNull(c, v.voi), voiRaw: v.voi,
        question: `${c.asm.personName.get(st.id) ?? st.id} 的真实态度到底站哪边？`,
        infoActions: hangs.slice(0, 3),
      });
    }
    if ((c.asm.deal.c_comp ?? 1.0) === 1.0) { // 竞争系数未实测 → C5 招采情报
      const v = voiCComp(c.asm.deal);
      out.push({
        kind: 'c_comp', voi: moneyOrNull(c, v.voi), voiRaw: v.voi,
        question: '招采规则与竞争格局摸清了吗（评标办法/对手投入）？',
        infoActions: infoActions.filter((a) => String(a.effect?.targetItem ?? '').startsWith('C5')).map((a) => ({ actionKey: a.actionKey, title: a.title, gist: a.gist, scriptRef: a.scriptRef })).slice(0, 3),
      });
    }
    out.sort((a, b) => (b.voiRaw ?? 0) - (a.voiRaw ?? 0));
    for (const o of out) delete o.voiRaw;
    return { items: out, potSource: c.asm.potSource, confidenceFlag: c.confidenceFlag };
  });

  // 行动排序（ΔEV·坞行动列/今日一屏引擎）：relationship 动作实例化，含 741 子策略标签
  app.get('/api/pde/:oppId/action-ranking', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const c = await computePde(req.user.tenantId, req.params.oppId);
    if (!c) return reply.code(404).send({ error: '商机不存在' });
    return {
      actions: c.actions.map((a) => ({
        actionKey: a.actionKey, title: a.title, personId: a.personId, personName: a.personName,
        d_pwin: a.d_pwin, gross: moneyOrNull(c, a.gross), cost: a.cost,
        dEV: moneyOrNull(c, a.dEV), ratio: Number.isFinite(a.ratio) ? Math.round(a.ratio * 100) / 100 : null,
        gist: a.gist, scriptRef: a.scriptRef,
      })),
      strategy741: c.s741,
      recommendation: c.recommendation,
      potSource: c.asm.potSource, confidenceFlag: c.confidenceFlag,
    };
  });

  // 手动快照（K7 的 manual 触发；inputsJson 完整留痕=可回放 evaluate）
  app.post('/api/pde/:oppId/snapshot', { preHandler: [app.authenticate] }, async (req: any, reply) => {
    const tenantId = req.user.tenantId;
    const c = await computePde(tenantId, req.params.oppId);
    if (!c) return reply.code(404).send({ error: '商机不存在' });
    const snap = await prisma.eVSnapshot.create({
      data: {
        id: 'evs_' + randomUUID().slice(0, 12), tenantId, opportunityId: req.params.oppId,
        trigger: 'manual',
        inputsJson: JSON.stringify({ deal: c.asm.deal, packKey: PACK_KEY, paramsSchemaVersion: c.seeds.params.schemaVersion }),
        resultJson: JSON.stringify({ eval: c.ev, score: c.score, recommendation: c.recommendation, confidenceFlag: c.confidenceFlag }),
        schemaId: String(c.seeds.scoringSchema.schemaId ?? ''), schemaVersion: String(c.seeds.scoringSchema.schemaVersion ?? ''),
        confidenceFlag: c.confidenceFlag, createdBy: req.user.userId ?? '',
      },
    });
    return { ok: true, id: snap.id, pwin: c.ev.pwin, recommendation: c.recommendation.action, confidenceFlag: c.confidenceFlag };
  });

  // 快照列表（复盘走势；不回 inputsJson 大字段）
  app.get('/api/pde/:oppId/snapshots', { preHandler: [app.authenticate] }, async (req: any) => {
    const rows = await prisma.eVSnapshot.findMany({
      where: { tenantId: req.user.tenantId, opportunityId: req.params.oppId },
      orderBy: { createdAt: 'desc' }, take: 60,
    });
    return {
      snapshots: rows.map((r) => {
        let brief: any = {};
        try { const j = JSON.parse(r.resultJson); brief = { pwin: j?.eval?.pwin, action: j?.recommendation?.action, nominal: j?.score?.nominal, weighted: j?.score?.weighted }; } catch { /* 坏行忽略 */ }
        return { id: r.id, trigger: r.trigger, createdAt: r.createdAt, confidenceFlag: r.confidenceFlag, ...brief };
      }),
    };
  });
}
