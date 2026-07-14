// 组装层（M3）：江湖数据（OppRole 扩展承载·裁决B + G64111 名义分 + ScoringItemState + DealPdeConfig）→ kernel Deal。
// 引擎分层（裁决C）：名义分由 g64111 算=沟通语言；本层只负责把它连同可信度元数据喂给 PDE 决策内核。
import type { Cred, Deal, Mark, ScoreItem, Slot, Stage, Stakeholder, Volatility } from 'pde-kernel';
import { prisma } from '../prisma.js';
import { scoreFromState, type ItemKey } from '../g64111.js';
import { aggregateApprovedEvidence, type ApprovedEvidenceAggregate } from './evidence.js';
import type { DbClient } from '../mutation/scopeGuards.js';
import type { ReadPrincipal } from '../visibility.js';
import { activePersonWhere } from '../activePerson.js';

// ── 值域映射（江湖 ↔ 内核）──
export const SENT2MARK: Record<string, Mark> = { star: 'star', plus: 'plus', neutral: 'eq', unknown: 'unk', minus: 'minus', x: 'x' };
export const MARK2SENT: Record<Mark, string> = { star: 'star', plus: 'plus', eq: 'neutral', unk: 'unknown', minus: 'minus', x: 'x' };
export const CONF2CRED: Record<string, Cred> = { 共识: 'consensus', 明确: 'explicit', 推理: 'inference', 不清: 'unclear' };
export const CRED2CONF: Record<Cred, string> = { consensus: '共识', explicit: '明确', inference: '推理', unclear: '不清' };
export const STAGE_MAP: Record<string, Stage> = {
  需求调研立项: 'initiation', 方案可研: 'feasibility', 预算批复: 'budget_approval', 招标论证: 'tender_design', 招采执行: 'tender_execution',
};
const PROC2SLOT: Record<string, Slot> = { purchasing: 'PROC_MGMT', agency: 'PROC_AGENT', ownerRep: 'OWNER_REP' };
const ROLE2SLOT: Record<string, Slot> = { A: 'A', D: 'D', U: 'MEMBER', R: 'MEMBER', C: 'MEMBER' };

const J = (s: string | null | undefined, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

export interface AssembledPde {
  deal: Deal;
  potSource: 'pde_config' | 'expected_amount' | 'missing';
  stage: Stage;
  personName: Map<string, string>;   // personId → 姓名（响应装饰用）
  itemVolatility: Record<string, Volatility>;
  itemConfidence: Record<string, Cred>; // itemKey → 映射后可信度（默认 explicit·实现决策：温和上线不轰炸 CHECK）
  evidence: ApprovedEvidenceAggregate; // 快照重放所需：参与计算的 Evidence IDs + 每人聚合 alpha
  opp: { id: string; name: string; engageStage: string };
}

/** 从江湖库组装一个 kernel Deal（按 tenantId 严格隔离）。opp 不存在返回 null。 */
export async function assembleDeal(
  tenantId: string,
  oppId: string,
  seeds: any,
  packId: string,
  db: DbClient = prisma,
  principal?: ReadPrincipal,
): Promise<AssembledPde | null> {
  const opp = await db.opportunity.findFirst({
    where: { id: oppId, tenantId },
    include: { roles: true, bis: true, ucvs: true, account: { include: { persons: { where: activePersonWhere } } } },
  });
  if (!opp) return null;
  const cfg = await db.dealPdeConfig.findFirst({ where: { tenantId, opportunityId: oppId } });
  const itemStates = await db.scoringItemState.findMany({ where: { tenantId, opportunityId: oppId, subItemKey: '' } });

  // 1) 干系人 → stakeholders（排除竞品；slots = 角色 + 招采身份 + 关键影响人，多 slot 权重相加）
  const personById = new Map(opp.account.persons.map((p) => [p.id, p]));
  const personName = new Map<string, string>();
  const stakeholders: Stakeholder[] = [];
  const now = Date.now();
  for (const r of opp.roles) {
    const person = personById.get(r.personId);
    if (!person || person.isCompetitor) continue;
    personName.set(r.personId, person.name);
    const slots: Slot[] = [ROLE2SLOT[r.role] ?? 'MEMBER'];
    if (r.procurementType && PROC2SLOT[r.procurementType]) slots.push(PROC2SLOT[r.procurementType]!);
    if (r.isKeyInfluencer) slots.push('KEY_INFLUENCER');
    stakeholders.push({
      id: r.personId,
      slots: [...new Set(slots)],
      mark: SENT2MARK[r.sentiment] ?? 'unk',
      cred: CONF2CRED[r.confidence] ?? 'unclear',
      q: r.sourceQuality ?? 1.0,
      // assessedAt 为空（存量未记录）→ 0 不衰减：温和上线，衰减随 SET_ROLE 逐步生效（实现决策）
      age_days: r.assessedAt ? Math.max(0, (now - r.assessedAt.getTime()) / 86400e3) : 0,
    });
  }
  const evidence = await aggregateApprovedEvidence(
    db,
    tenantId,
    oppId,
    stakeholders.map((stakeholder) => stakeholder.id),
    packId,
    seeds.signalCatalog.deltaAlphaMap,
  );
  for (const stakeholder of stakeholders) {
    const alpha = evidence.alphaByStakeholder[stakeholder.id];
    if (alpha) stakeholder.evidence_alpha = alpha;
  }

  // 2) 名义分（g64111，照 mcpServer.getWinTendency 组装）+ 可信度元层 → items
  const account = { persons: opp.account.persons.map((p) => ({ id: p.id, form: J(p.form, {}) })) };
  const visibleBis = principal?.role === 'viewer' ? opp.bis.filter((b) => !b.isPrivate) : opp.bis;
  const visibleBiIds = new Set(visibleBis.map((b) => b.id));
  const visibleUcvs = opp.ucvs.filter((u) => visibleBiIds.has(u.targetBiId));
  const opportunity = {
    engageStage: opp.engageStage,
    c3Items: J(opp.c3Items, {}), c5Items: J(opp.c5Items, {}),
    roles: opp.roles.map((r) => ({
      personId: r.personId, role: r.role as any, sentiment: r.sentiment as any, confidence: r.confidence as any,
      isKeyInfluencer: r.isKeyInfluencer, procurementType: (r.procurementType ?? undefined) as any, procurementStatus: (r.procurementStatus ?? undefined) as any,
    })),
    bis: visibleBis.map((b) => ({ id: b.id, personId: b.personId, confidence: b.confidence as any })),
    ucvs: visibleUcvs.map((u) => ({ targetBiId: u.targetBiId, status: u.status as any })),
  };
  const nominal = scoreFromState(account as any, opportunity as any);

  const itemVolatility: Record<string, Volatility> = {};
  for (const it of seeds.scoringSchema.items as any[]) itemVolatility[it.key] = (it.volatility ?? 'stance') as Volatility;
  const stateByKey = new Map(itemStates.map((s) => [s.itemKey, s]));
  const itemConfidence: Record<string, Cred> = {};
  const items: ScoreItem[] = (Object.keys(nominal.items) as ItemKey[]).map((k) => {
    const st = stateByKey.get(k);
    const cred: Cred = st ? (CONF2CRED[st.confidence] ?? 'unclear') : 'explicit';
    itemConfidence[k] = cred;
    return {
      key: k, raw: nominal.items[k], cred,
      q: st?.sourceQuality ?? 1.0,
      age_days: st?.collectedAt ? Math.max(0, (now - st.collectedAt.getTime()) / 86400e3) : 0,
      volatility: itemVolatility[k] ?? 'stance',
    };
  });

  // 3) 彩池与阶段
  const potSource = cfg?.potValue != null ? 'pde_config' : opp.expectedAmountW > 0 ? 'expected_amount' : 'missing';
  const pot = cfg?.potValue ?? (opp.expectedAmountW > 0 ? opp.expectedAmountW : 0);
  const stage: Stage = STAGE_MAP[opp.engageStage] ?? 'initiation';

  const deal: Deal = {
    id: opp.id, pot, planned_cost: cfg?.plannedCost ?? 0, stage,
    c_comp: cfg?.cComp ?? 1.0, stakeholders, items,
  };
  return { deal, potSource, stage, personName, itemVolatility, itemConfidence, evidence, opp: { id: opp.id, name: opp.name, engageStage: opp.engageStage } };
}
