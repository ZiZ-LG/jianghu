// 江湖 · 数据层：状态 + reducer + localStorage 持久化 + 实体工厂
// 抽象在此层，未来切换到后端 API 只需替换 load/save 与 dispatch 的落地方式。
import type {
  Account, Opportunity, Person, OppRole, Edge, BurningIssue, UCV, InteractionLog, CustomerType, VisitNote, PlanAction, OppMilestone, OppStage, Half,
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

// ── Actions ──
export type Action =
  | { type: 'ADD_ACCOUNT'; account: Account }
  | { type: 'UPDATE_ACCOUNT'; accId: string; patch: Partial<Account> }
  | { type: 'DELETE_ACCOUNT'; accId: string }
  | { type: 'ADD_OPP'; accId: string; opp: Opportunity }
  | { type: 'UPDATE_OPP'; accId: string; oppId: string; patch: Partial<Opportunity> }
  | { type: 'DELETE_OPP'; accId: string; oppId: string }
  | { type: 'ADD_PERSON'; accId: string; person: Person }
  | { type: 'UPDATE_PERSON'; accId: string; personId: string; patch: Partial<Person> }
  | { type: 'MOVE_PERSON'; accId: string; personId: string; x: number; y: number }
  | { type: 'DELETE_PERSON'; accId: string; personId: string }
  | { type: 'ADD_LOG'; accId: string; personId: string; log: InteractionLog }
  | { type: 'SET_ROLE'; accId: string; oppId: string; personId: string; patch: Partial<OppRole> }
  | { type: 'REMOVE_ROLE'; accId: string; oppId: string; personId: string }
  | { type: 'ADD_OPP_MEMBER'; accId: string; oppId: string; personId: string }
  | { type: 'REMOVE_OPP_MEMBER'; accId: string; oppId: string; personId: string }
  | { type: 'ADD_EDGE'; accId: string; oppId: string; edge: Edge }
  | { type: 'UPDATE_EDGE'; accId: string; oppId: string; edgeId: string; patch: Partial<Edge> }
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
      return mapOpp(s, action.accId, action.oppId, (o) => ({ ...o, ...action.patch }));
    case 'DELETE_OPP':
      return mapAcc(s, action.accId, (a) => ({ ...a, opportunities: a.opportunities.filter((o) => o.id !== action.oppId) }));

    case 'ADD_PERSON':
      return mapAcc(s, action.accId, (a) => ({ ...a, persons: [...a.persons, action.person] }));
    case 'UPDATE_PERSON':
      return mapAcc(s, action.accId, (a) => ({
        ...a, persons: a.persons.map((p) => (p.id === action.personId ? { ...p, ...action.patch } : p)),
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
        baseEdges: a.baseEdges.map((e) => (e.id === action.edgeId ? { ...e, ...action.patch } : e)),
        opportunities: a.opportunities.map((o) => ({
          ...o, edges: o.edges.map((e) => (e.id === action.edgeId ? { ...e, ...action.patch } : e)),
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
