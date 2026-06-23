// 江湖 · 数据层：状态 + reducer + localStorage 持久化 + 实体工厂
// 抽象在此层，未来切换到后端 API 只需替换 load/save 与 dispatch 的落地方式。
import type {
  Account, Opportunity, Person, OppRole, Edge, BurningIssue, UCV, InteractionLog, CustomerType, VisitNote, PlanAction, OppMilestone, OppStage, Half,
  StrategyCard, StrategyRisk, StrategyResource, EvidenceEvent,
} from './types';
import { seedAccount } from './data/seed';

export interface StoreState { accounts: Account[]; }

const KEY = 'jianghu.store.v1';

export function loadState(): StoreState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as StoreState;
  } catch { /* ignore */ }
  return { accounts: [] };
}
export function saveState(s: StoreState): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const uid = (p = 'id'): string =>
  `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// ── 工厂 ──
export function newAccount(name: string, customerType: CustomerType): Account {
  return { id: uid('acc'), name, customerType, persons: [], baseEdges: [], opportunities: [] };
}
export function newOpportunity(accountId: string, name: string, customerType: CustomerType): Opportunity {
  return {
    id: uid('opp'), accountId, name, customerType,
    pipelineStage: '线索', engageStage: '需求调研立项', singleSalesGoal: '',
    c3Items: {}, c5Items: {}, roles: [], bis: [], ucvs: [], edges: [], memberScoped: false, memberIds: [],
  };
}
export function newPerson(name: string, title: string, x: number, y: number, isCompetitor?: boolean): Person {
  return {
    id: uid('p'), name, title, orgLevel: 3, isCompetitor,
    form: { family: '', occupation: '', recreation: '', moneyMotivation: '', family7: {} },
    logs: [], x, y,
  };
}
export function newPlanAction(accountId: string, opportunityId: string, startDate: string, endDate?: string, half: Half = 'am'): PlanAction {
  return { id: uid('act'), accountId, opportunityId, title: '', startDate, endDate: endDate || startDate, half, done: false, origin: 'manual' };
}
export function newMilestone(accountId: string, opportunityId: string, startDate: string, half: Half = 'am'): OppMilestone {
  return { id: uid('ms'), accountId, opportunityId, title: '', startDate, endDate: startDate, half };
}
export function newOppStage(accountId: string, opportunityId: string, stageKey: string, startDate: string, endDate: string): OppStage {
  return { id: uid('st'), accountId, opportunityId, stageKey, startDate, endDate };
}
// ── 策略沙盘工厂 ──
export function newStrategyCard(accountId: string, opportunityId: string, gapItem = ''): StrategyCard {
  return { id: uid('sc'), accountId, opportunityId, gapItem, title: '', status: 'active', origin: 'manual', orderIndex: 0, dispatchedActionIds: [] };
}
export function newStrategyRisk(accountId: string, opportunityId: string, kind: 'risk' | 'assumption' = 'risk'): StrategyRisk {
  return { id: uid('sr'), accountId, opportunityId, kind, text: '', severity: 'mid', status: 'open', origin: 'manual' };
}
export function newStrategyResource(accountId: string, opportunityId: string): StrategyResource {
  return { id: uid('sx'), accountId, opportunityId, label: '', kind: '', note: '' };
}
export function newEvidence(accountId: string, opportunityId: string, personId: string, signalKey: string, direction: number, tier: 'weak' | 'mid' | 'strong'): EvidenceEvent {
  return { id: uid('ev'), accountId, opportunityId, personId, signalKey, direction, tier, rawContent: '', occurredAt: '' };
}

// ── Actions ──
export type Action =
  | { type: 'ADD_ACCOUNT'; account: Account }
  | { type: 'UPDATE_ACCOUNT'; accId: string; patch: Partial<Account> }
  | { type: 'DELETE_ACCOUNT'; accId: string }
  | { type: 'ADD_OPP'; accId: string; opp: Opportunity }
  | { type: 'UPDATE_OPP'; accId: string; oppId: string; patch: Partial<Opportunity>; baseVersion?: number }
  | { type: 'DELETE_OPP'; accId: string; oppId: string }
  | { type: 'ADD_PERSON'; accId: string; person: Person }
  | { type: 'UPDATE_PERSON'; accId: string; personId: string; patch: Partial<Person>; baseVersion?: number }
  | { type: 'MOVE_PERSON'; accId: string; personId: string; x: number; y: number }
  | { type: 'DELETE_PERSON'; accId: string; personId: string }
  | { type: 'ADD_LOG'; accId: string; personId: string; log: InteractionLog }
  | { type: 'SET_ROLE'; accId: string; oppId: string; personId: string; patch: Partial<OppRole> }
  | { type: 'REMOVE_ROLE'; accId: string; oppId: string; personId: string }
  | { type: 'ADD_OPP_MEMBER'; accId: string; oppId: string; personId: string }
  | { type: 'REMOVE_OPP_MEMBER'; accId: string; oppId: string; personId: string }
  | { type: 'ADD_EDGE'; accId: string; oppId: string; edge: Edge }
  | { type: 'UPDATE_EDGE'; accId: string; oppId: string; edgeId: string; patch: Partial<Edge>; baseVersion?: number }
  | { type: 'DELETE_EDGE'; accId: string; oppId: string; edgeId: string }
  | { type: 'ADD_BI'; accId: string; oppId: string; bi: BurningIssue }
  | { type: 'UPDATE_BI'; accId: string; oppId: string; biId: string; patch: Partial<BurningIssue> }
  | { type: 'DELETE_BI'; accId: string; oppId: string; biId: string }
  | { type: 'ADD_UCV'; accId: string; oppId: string; ucv: UCV }
  | { type: 'UPDATE_UCV'; accId: string; oppId: string; ucvId: string; patch: Partial<UCV> }
  | { type: 'DELETE_UCV'; accId: string; oppId: string; ucvId: string }
  | { type: 'ADD_VISIT'; accId: string; visit: VisitNote }
  | { type: 'UPDATE_VISIT'; accId: string; visitId: string; patch: Partial<VisitNote> }
  | { type: 'DELETE_VISIT'; accId: string; visitId: string }
  | { type: 'ADD_PLAN_ACTION'; accId: string; oppId: string; planAction: PlanAction }
  | { type: 'UPDATE_PLAN_ACTION'; accId: string; actionId: string; patch: Partial<PlanAction> }
  | { type: 'DELETE_PLAN_ACTION'; accId: string; actionId: string }
  | { type: 'TOGGLE_PLAN_ACTION'; accId: string; actionId: string; done: boolean; doneAt?: string }
  | { type: 'ADD_MILESTONE'; accId: string; oppId: string; milestone: OppMilestone }
  | { type: 'UPDATE_MILESTONE'; accId: string; milestoneId: string; patch: Partial<OppMilestone> }
  | { type: 'DELETE_MILESTONE'; accId: string; milestoneId: string }
  | { type: 'ADD_OPP_STAGE'; accId: string; oppId: string; stage: OppStage }
  | { type: 'UPDATE_OPP_STAGE'; accId: string; stageId: string; patch: Partial<OppStage> }
  | { type: 'DELETE_OPP_STAGE'; accId: string; stageId: string }
  | { type: 'ADD_STRATEGY_CARD'; accId: string; oppId: string; card: StrategyCard }
  | { type: 'UPDATE_STRATEGY_CARD'; accId: string; cardId: string; patch: Partial<StrategyCard> }
  | { type: 'DELETE_STRATEGY_CARD'; accId: string; cardId: string }
  | { type: 'ADD_STRATEGY_RISK'; accId: string; oppId: string; risk: StrategyRisk }
  | { type: 'UPDATE_STRATEGY_RISK'; accId: string; riskId: string; patch: Partial<StrategyRisk> }
  | { type: 'DELETE_STRATEGY_RISK'; accId: string; riskId: string }
  | { type: 'ADD_STRATEGY_RESOURCE'; accId: string; oppId: string; resource: StrategyResource }
  | { type: 'UPDATE_STRATEGY_RESOURCE'; accId: string; resourceId: string; patch: Partial<StrategyResource> }
  | { type: 'DELETE_STRATEGY_RESOURCE'; accId: string; resourceId: string }
  | { type: 'ADD_EVIDENCE'; accId: string; oppId: string; evidence: EvidenceEvent }
  | { type: 'DELETE_EVIDENCE'; accId: string; oppId: string; evidenceId: string }
  | { type: 'LOAD_DEMO' }
  | { type: 'RESET' }
  | { type: 'HYDRATE'; accounts: Account[] };

// ── 不可变更新助手 ──
const mapAcc = (s: StoreState, accId: string, fn: (a: Account) => Account): StoreState => ({
  accounts: s.accounts.map((a) => (a.id === accId ? fn(a) : a)),
});
const mapOpp = (s: StoreState, accId: string, oppId: string, fn: (o: Opportunity) => Opportunity): StoreState =>
  mapAcc(s, accId, (a) => ({ ...a, opportunities: a.opportunities.map((o) => (o.id === oppId ? fn(o) : o)) }));

export function reducer(s: StoreState, action: Action): StoreState {
  switch (action.type) {
    case 'ADD_ACCOUNT':
      return { accounts: [...s.accounts, action.account] };
    case 'UPDATE_ACCOUNT':
      return mapAcc(s, action.accId, (a) => ({ ...a, ...action.patch }));
    case 'DELETE_ACCOUNT':
      return { accounts: s.accounts.filter((a) => a.id !== action.accId) };

    case 'ADD_OPP':
      return mapAcc(s, action.accId, (a) => ({ ...a, opportunities: [...a.opportunities, action.opp] }));
    case 'UPDATE_OPP':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, ...action.patch, version: (o.version ?? 0) + 1 }));
    case 'DELETE_OPP':
      return mapAcc(s, action.accId, (a) => ({ ...a, opportunities: a.opportunities.filter((o) => o.id !== action.oppId) }));

    case 'ADD_PERSON':
      return mapAcc(s, action.accId, (a) => ({ ...a, persons: [...a.persons, action.person] }));
    case 'UPDATE_PERSON':
      return mapAcc(s, action.accId, (a) => ({
        ...a, persons: a.persons.map((p) => (p.id === action.personId ? { ...p, ...action.patch, version: (p.version ?? 0) + 1 } : p)),
      }));
    case 'MOVE_PERSON':
      return mapAcc(s, action.accId, (a) => ({
        ...a, persons: a.persons.map((p) => (p.id === action.personId ? { ...p, x: action.x, y: action.y } : p)),
      }));
    case 'DELETE_PERSON':
      return mapAcc(s, action.accId, (a) => ({
        ...a,
        persons: a.persons.filter((p) => p.id !== action.personId),
        baseEdges: a.baseEdges.filter((e) => e.source !== action.personId && e.target !== action.personId),
        opportunities: a.opportunities.map((o) => {
          const deadBis = o.bis.filter((b) => b.personId === action.personId).map((b) => b.id);
          return {
            ...o,
            roles: o.roles.filter((r) => r.personId !== action.personId),
            edges: o.edges.filter((e) => e.source !== action.personId && e.target !== action.personId),
            bis: o.bis.filter((b) => b.personId !== action.personId),
            ucvs: o.ucvs.filter((u) => !deadBis.includes(u.targetBiId)),
            memberIds: (o.memberIds ?? []).filter((id) => id !== action.personId),
          };
        }),
      }));
    case 'ADD_LOG':
      return mapAcc(s, action.accId, (a) => ({
        ...a, persons: a.persons.map((p) => (p.id === action.personId ? { ...p, logs: [action.log, ...p.logs] } : p)),
      }));

    case 'SET_ROLE':
      return mapOpp(s, action.accId, action.oppId, (o) => {
        const exists = o.roles.some((r) => r.personId === action.personId);
        const roles = exists
          ? o.roles.map((r) => (r.personId === action.personId ? { ...r, ...action.patch } : r))
          : [...o.roles, { personId: action.personId, role: 'U', sentiment: 'unknown', confidence: '推理', ...action.patch } as OppRole];
        return { ...o, roles };
      });
    case 'REMOVE_ROLE':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, roles: o.roles.filter((r) => r.personId !== action.personId) }));

    case 'ADD_OPP_MEMBER':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, memberIds: (o.memberIds ?? []).includes(action.personId) ? o.memberIds : [...(o.memberIds ?? []), action.personId] }));
    case 'REMOVE_OPP_MEMBER':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, memberIds: (o.memberIds ?? []).filter((id) => id !== action.personId) }));

    case 'ADD_EDGE':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, edges: [...o.edges, action.edge] }));
    case 'UPDATE_EDGE':
      // 连线可能在 baseEdges(L1) 或某商机 edges 里——两处都尝试 patch（按 id 命中才改）
      return mapAcc(s, action.accId, (a) => ({
        ...a,
        baseEdges: a.baseEdges.map((e) => (e.id === action.edgeId ? { ...e, ...action.patch, version: (e.version ?? 0) + 1 } : e)),
        opportunities: a.opportunities.map((o) => ({
          ...o, edges: o.edges.map((e) => (e.id === action.edgeId ? { ...e, ...action.patch, version: (e.version ?? 0) + 1 } : e)),
        })),
      }));
    case 'DELETE_EDGE':
      return mapAcc(s, action.accId, (a) => ({
        ...a,
        baseEdges: a.baseEdges.filter((e) => e.id !== action.edgeId),
        opportunities: a.opportunities.map((o) => (o.id === action.oppId ? { ...o, edges: o.edges.filter((e) => e.id !== action.edgeId) } : o)),
      }));

    case 'ADD_BI':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, bis: [...o.bis, action.bi] }));
    case 'UPDATE_BI':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, bis: o.bis.map((b) => (b.id === action.biId ? { ...b, ...action.patch } : b)) }));
    case 'DELETE_BI':
      return mapOpp(s, action.accId, action.oppId, (o) => ({
        ...o, bis: o.bis.filter((b) => b.id !== action.biId), ucvs: o.ucvs.filter((u) => u.targetBiId !== action.biId),
      }));

    case 'ADD_UCV':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, ucvs: [...o.ucvs, action.ucv] }));
    case 'UPDATE_UCV':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, ucvs: o.ucvs.map((u) => (u.id === action.ucvId ? { ...u, ...action.patch } : u)) }));
    case 'DELETE_UCV':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, ucvs: o.ucvs.filter((u) => u.id !== action.ucvId) }));

    case 'ADD_VISIT':
      return mapAcc(s, action.accId, (a) => ({ ...a, visitNotes: [action.visit, ...(a.visitNotes ?? [])] }));
    case 'UPDATE_VISIT':
      return mapAcc(s, action.accId, (a) => ({ ...a, visitNotes: (a.visitNotes ?? []).map((v) => (v.id === action.visitId ? { ...v, ...action.patch } : v)) }));
    case 'DELETE_VISIT':
      return mapAcc(s, action.accId, (a) => ({ ...a, visitNotes: (a.visitNotes ?? []).filter((v) => v.id !== action.visitId) }));

    // ── 商机策划 · 行动计划 / 里程碑（挂 account 级，同 visitNotes）──
    case 'ADD_PLAN_ACTION':
      return mapAcc(s, action.accId, (a) => ({ ...a, planActions: [...(a.planActions ?? []), action.planAction] }));
    case 'UPDATE_PLAN_ACTION':
      return mapAcc(s, action.accId, (a) => ({ ...a, planActions: (a.planActions ?? []).map((p) => (p.id === action.actionId ? { ...p, ...action.patch } : p)) }));
    case 'DELETE_PLAN_ACTION':
      return mapAcc(s, action.accId, (a) => ({ ...a, planActions: (a.planActions ?? []).filter((p) => p.id !== action.actionId) }));
    case 'TOGGLE_PLAN_ACTION':
      return mapAcc(s, action.accId, (a) => ({ ...a, planActions: (a.planActions ?? []).map((p) => (p.id === action.actionId ? { ...p, done: action.done, doneAt: action.done ? (action.doneAt ?? new Date().toISOString().slice(0, 10)) : undefined } : p)) }));
    case 'ADD_MILESTONE':
      return mapAcc(s, action.accId, (a) => ({ ...a, milestones: [...(a.milestones ?? []), action.milestone] }));
    case 'UPDATE_MILESTONE':
      return mapAcc(s, action.accId, (a) => ({ ...a, milestones: (a.milestones ?? []).map((m) => (m.id === action.milestoneId ? { ...m, ...action.patch } : m)) }));
    case 'DELETE_MILESTONE':
      return mapAcc(s, action.accId, (a) => ({ ...a, milestones: (a.milestones ?? []).filter((m) => m.id !== action.milestoneId) }));

    case 'ADD_OPP_STAGE':
      return mapAcc(s, action.accId, (a) => ({ ...a, oppStages: [...(a.oppStages ?? []), action.stage] }));
    case 'UPDATE_OPP_STAGE':
      return mapAcc(s, action.accId, (a) => ({ ...a, oppStages: (a.oppStages ?? []).map((st) => (st.id === action.stageId ? { ...st, ...action.patch } : st)) }));
    case 'DELETE_OPP_STAGE':
      return mapAcc(s, action.accId, (a) => ({ ...a, oppStages: (a.oppStages ?? []).filter((st) => st.id !== action.stageId) }));

    // ── 策略沙盘 · 策略卡 / 风险 / 弹药（挂 account 级，同 planActions）──
    case 'ADD_STRATEGY_CARD':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyCards: [...(a.strategyCards ?? []), action.card] }));
    case 'UPDATE_STRATEGY_CARD':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyCards: (a.strategyCards ?? []).map((c) => (c.id === action.cardId ? { ...c, ...action.patch } : c)) }));
    case 'DELETE_STRATEGY_CARD':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyCards: (a.strategyCards ?? []).filter((c) => c.id !== action.cardId) }));
    case 'ADD_STRATEGY_RISK':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyRisks: [...(a.strategyRisks ?? []), action.risk] }));
    case 'UPDATE_STRATEGY_RISK':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyRisks: (a.strategyRisks ?? []).map((r) => (r.id === action.riskId ? { ...r, ...action.patch } : r)) }));
    case 'DELETE_STRATEGY_RISK':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyRisks: (a.strategyRisks ?? []).filter((r) => r.id !== action.riskId) }));
    case 'ADD_STRATEGY_RESOURCE':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyResources: [...(a.strategyResources ?? []), action.resource] }));
    case 'UPDATE_STRATEGY_RESOURCE':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyResources: (a.strategyResources ?? []).map((x) => (x.id === action.resourceId ? { ...x, ...action.patch } : x)) }));
    case 'DELETE_STRATEGY_RESOURCE':
      return mapAcc(s, action.accId, (a) => ({ ...a, strategyResources: (a.strategyResources ?? []).filter((x) => x.id !== action.resourceId) }));
    case 'ADD_EVIDENCE':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, evidenceEvents: [...(o.evidenceEvents ?? []), action.evidence] }));
    case 'DELETE_EVIDENCE':
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, evidenceEvents: (o.evidenceEvents ?? []).filter((e) => e.id !== action.evidenceId) }));

    case 'LOAD_DEMO': {
      if (s.accounts.some((a) => a.id === seedAccount.id)) return s;
      return { accounts: [...s.accounts, JSON.parse(JSON.stringify(seedAccount))] };
    }
    case 'RESET':
      return { accounts: [] };
    case 'HYDRATE':
      return { accounts: action.accounts };
    default:
      return s;
  }
}

// ── Undo/Redo：逆 action 计算（复用现有 mutate 链路；不可逆操作返回 null 不入历史）──
// 级联删除(PERSON/OPP/ACCOUNT)、ADD_LOG、MEMBER、VISIT、HYDRATE/LOAD_DEMO/RESET 不纳入撤销。
export function computeInverse(a: Action, s: StoreState): Action[] | null {
  const acc = (id: string) => s.accounts.find((x) => x.id === id);
  const allEdges = (id: string) => { const A = acc(id); return A ? [...A.baseEdges, ...A.opportunities.flatMap((o) => o.edges)] : []; };
  const pick = (obj: any, keys: string[]) => { const o: any = {}; for (const k of keys) o[k] = obj[k]; return o; };
  switch (a.type) {
    case 'MOVE_PERSON': { const p = acc(a.accId)?.persons.find((x) => x.id === a.personId); return p ? [{ type: 'MOVE_PERSON', accId: a.accId, personId: a.personId, x: p.x, y: p.y }] : null; }
    case 'ADD_PERSON': return [{ type: 'DELETE_PERSON', accId: a.accId, personId: a.person.id }];
    case 'UPDATE_PERSON': { const p = acc(a.accId)?.persons.find((x) => x.id === a.personId); return p ? [{ type: 'UPDATE_PERSON', accId: a.accId, personId: a.personId, patch: pick(p, Object.keys(a.patch)) }] : null; }
    case 'ADD_EDGE': return [{ type: 'DELETE_EDGE', accId: a.accId, oppId: a.oppId, edgeId: a.edge.id }];
    case 'DELETE_EDGE': { const e = allEdges(a.accId).find((x) => x.id === a.edgeId); return e ? [{ type: 'ADD_EDGE', accId: a.accId, oppId: a.oppId, edge: e }] : null; }
    case 'UPDATE_EDGE': { const e = allEdges(a.accId).find((x) => x.id === a.edgeId); return e ? [{ type: 'UPDATE_EDGE', accId: a.accId, oppId: a.oppId, edgeId: a.edgeId, patch: pick(e, Object.keys(a.patch)) }] : null; }
    case 'SET_ROLE': { const o = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId); const old = o?.roles.find((r) => r.personId === a.personId); return old ? [{ type: 'SET_ROLE', accId: a.accId, oppId: a.oppId, personId: a.personId, patch: old }] : [{ type: 'REMOVE_ROLE', accId: a.accId, oppId: a.oppId, personId: a.personId }]; }
    case 'REMOVE_ROLE': { const o = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId); const old = o?.roles.find((r) => r.personId === a.personId); return old ? [{ type: 'SET_ROLE', accId: a.accId, oppId: a.oppId, personId: a.personId, patch: old }] : null; }
    case 'UPDATE_OPP': { const o = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId); return o ? [{ type: 'UPDATE_OPP', accId: a.accId, oppId: a.oppId, patch: pick(o, Object.keys(a.patch)) }] : null; }
    case 'UPDATE_ACCOUNT': { const A = acc(a.accId); return A ? [{ type: 'UPDATE_ACCOUNT', accId: a.accId, patch: pick(A, Object.keys(a.patch)) }] : null; }
    case 'ADD_BI': return [{ type: 'DELETE_BI', accId: a.accId, oppId: a.oppId, biId: a.bi.id }];
    case 'DELETE_BI': { const b = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId)?.bis.find((x) => x.id === a.biId); return b ? [{ type: 'ADD_BI', accId: a.accId, oppId: a.oppId, bi: b }] : null; }
    case 'UPDATE_BI': { const b = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId)?.bis.find((x) => x.id === a.biId); return b ? [{ type: 'UPDATE_BI', accId: a.accId, oppId: a.oppId, biId: a.biId, patch: pick(b, Object.keys(a.patch)) }] : null; }
    case 'ADD_UCV': return [{ type: 'DELETE_UCV', accId: a.accId, oppId: a.oppId, ucvId: a.ucv.id }];
    case 'DELETE_UCV': { const u = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId)?.ucvs.find((x) => x.id === a.ucvId); return u ? [{ type: 'ADD_UCV', accId: a.accId, oppId: a.oppId, ucv: u }] : null; }
    case 'UPDATE_UCV': { const u = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId)?.ucvs.find((x) => x.id === a.ucvId); return u ? [{ type: 'UPDATE_UCV', accId: a.accId, oppId: a.oppId, ucvId: a.ucvId, patch: pick(u, Object.keys(a.patch)) }] : null; }
    case 'ADD_PLAN_ACTION': return [{ type: 'DELETE_PLAN_ACTION', accId: a.accId, actionId: a.planAction.id }];
    case 'DELETE_PLAN_ACTION': { const pa = acc(a.accId)?.planActions?.find((x) => x.id === a.actionId); return pa ? [{ type: 'ADD_PLAN_ACTION', accId: a.accId, oppId: pa.opportunityId, planAction: pa }] : null; }
    case 'UPDATE_PLAN_ACTION': { const pa = acc(a.accId)?.planActions?.find((x) => x.id === a.actionId); return pa ? [{ type: 'UPDATE_PLAN_ACTION', accId: a.accId, actionId: a.actionId, patch: pick(pa, Object.keys(a.patch)) }] : null; }
    case 'TOGGLE_PLAN_ACTION': { const pa = acc(a.accId)?.planActions?.find((x) => x.id === a.actionId); return pa ? [{ type: 'TOGGLE_PLAN_ACTION', accId: a.accId, actionId: a.actionId, done: pa.done, doneAt: pa.doneAt }] : null; }
    case 'ADD_MILESTONE': return [{ type: 'DELETE_MILESTONE', accId: a.accId, milestoneId: a.milestone.id }];
    case 'DELETE_MILESTONE': { const m = acc(a.accId)?.milestones?.find((x) => x.id === a.milestoneId); return m ? [{ type: 'ADD_MILESTONE', accId: a.accId, oppId: m.opportunityId, milestone: m }] : null; }
    case 'UPDATE_MILESTONE': { const m = acc(a.accId)?.milestones?.find((x) => x.id === a.milestoneId); return m ? [{ type: 'UPDATE_MILESTONE', accId: a.accId, milestoneId: a.milestoneId, patch: pick(m, Object.keys(a.patch)) }] : null; }
    case 'ADD_OPP_STAGE': return [{ type: 'DELETE_OPP_STAGE', accId: a.accId, stageId: a.stage.id }];
    case 'DELETE_OPP_STAGE': { const st = acc(a.accId)?.oppStages?.find((x) => x.id === a.stageId); return st ? [{ type: 'ADD_OPP_STAGE', accId: a.accId, oppId: st.opportunityId, stage: st }] : null; }
    case 'UPDATE_OPP_STAGE': { const st = acc(a.accId)?.oppStages?.find((x) => x.id === a.stageId); return st ? [{ type: 'UPDATE_OPP_STAGE', accId: a.accId, stageId: a.stageId, patch: pick(st, Object.keys(a.patch)) }] : null; }
    case 'ADD_STRATEGY_CARD': return [{ type: 'DELETE_STRATEGY_CARD', accId: a.accId, cardId: a.card.id }];
    case 'DELETE_STRATEGY_CARD': { const c = acc(a.accId)?.strategyCards?.find((x) => x.id === a.cardId); return c ? [{ type: 'ADD_STRATEGY_CARD', accId: a.accId, oppId: c.opportunityId, card: c }] : null; }
    case 'UPDATE_STRATEGY_CARD': { const c = acc(a.accId)?.strategyCards?.find((x) => x.id === a.cardId); return c ? [{ type: 'UPDATE_STRATEGY_CARD', accId: a.accId, cardId: a.cardId, patch: pick(c, Object.keys(a.patch)) }] : null; }
    case 'ADD_STRATEGY_RISK': return [{ type: 'DELETE_STRATEGY_RISK', accId: a.accId, riskId: a.risk.id }];
    case 'DELETE_STRATEGY_RISK': { const r = acc(a.accId)?.strategyRisks?.find((x) => x.id === a.riskId); return r ? [{ type: 'ADD_STRATEGY_RISK', accId: a.accId, oppId: r.opportunityId, risk: r }] : null; }
    case 'UPDATE_STRATEGY_RISK': { const r = acc(a.accId)?.strategyRisks?.find((x) => x.id === a.riskId); return r ? [{ type: 'UPDATE_STRATEGY_RISK', accId: a.accId, riskId: a.riskId, patch: pick(r, Object.keys(a.patch)) }] : null; }
    case 'ADD_STRATEGY_RESOURCE': return [{ type: 'DELETE_STRATEGY_RESOURCE', accId: a.accId, resourceId: a.resource.id }];
    case 'DELETE_STRATEGY_RESOURCE': { const x = acc(a.accId)?.strategyResources?.find((y) => y.id === a.resourceId); return x ? [{ type: 'ADD_STRATEGY_RESOURCE', accId: a.accId, oppId: x.opportunityId, resource: x }] : null; }
    case 'ADD_EVIDENCE': return [{ type: 'DELETE_EVIDENCE', accId: a.accId, oppId: a.oppId, evidenceId: a.evidence.id }];
    case 'DELETE_EVIDENCE': { const o = acc(a.accId)?.opportunities.find((x) => x.id === a.oppId); const e = o?.evidenceEvents?.find((x) => x.id === a.evidenceId); return e ? [{ type: 'ADD_EVIDENCE', accId: a.accId, oppId: a.oppId, evidence: e }] : null; }
    case 'UPDATE_STRATEGY_RESOURCE': { const x = acc(a.accId)?.strategyResources?.find((y) => y.id === a.resourceId); return x ? [{ type: 'UPDATE_STRATEGY_RESOURCE', accId: a.accId, resourceId: a.resourceId, patch: pick(x, Object.keys(a.patch)) }] : null; }
    default: return null;
  }
}

/**
 * 乐观锁：dispatch 前为 UPDATE_PERSON/OPP/EDGE 注入 baseVersion（取最新 state 中实体的当前 version）。
 * 集中在此，免去每个调用点手填；其余 action 原样返回。后端据 baseVersion 校验并发冲突（不匹配→409）。
 */
export function injectBaseVersion(s: StoreState, action: Action): Action {
  switch (action.type) {
    case 'UPDATE_PERSON': {
      const p = s.accounts.find((a) => a.id === action.accId)?.persons.find((x) => x.id === action.personId);
      return { ...action, baseVersion: p?.version };
    }
    case 'UPDATE_OPP': {
      const o = s.accounts.find((a) => a.id === action.accId)?.opportunities.find((x) => x.id === action.oppId);
      return { ...action, baseVersion: o?.version };
    }
    case 'UPDATE_EDGE': {
      const acc = s.accounts.find((a) => a.id === action.accId);
      const edges = acc ? [...acc.baseEdges, ...acc.opportunities.flatMap((o) => o.edges)] : [];
      return { ...action, baseVersion: edges.find((x) => x.id === action.edgeId)?.version };
    }
    default:
      return action;
  }
}
