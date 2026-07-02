// 推演坞 · 关系地图底部可上拉的策略推演区（在策略沙盘逻辑上增量改造，作为地图的纯增量）。
// 第6刀旁支退役后坞真三层：坞头（PDE 徽章=唯一赢面出口 + 741 药丸 + 警示区：🔔机器背离黄条 · ⚠人工雷红条）/ 四列流水线 / 坞底对话。
// 风险砍容器降级红条（无 severity 分档、无管理窗口——坞头空间即数量约束）；假设/弹药 UI 全退、存量留库（Action 契约零改动）。
// 三档高度：收起(仅坞头+警示区) / 展开 / 全展开(四列更高)；画布始终在上方可见。
// 画布↔坞双向联动：selectedPersonId 高亮挂靠该人的策略卡；点策略卡 → onSelectPerson 回高亮画布目标。
// 老 PDE 适配层（lib/pde）在坞内只剩两职能：列① 姿态解读一句 + E2 背离提案（EngineBar 已退役，EV/赢面老口径废弃）。
import { useEffect, useMemo, useState } from 'react';
import type { Account, Opportunity, Sentiment, StrategyCard } from '../types';
import type { Action } from '../store';
import { newStrategyCard, newStrategyRisk, newPlanAction, newMilestone, newEvidence } from '../store';
import type { ScoreBreakdown, ItemKey, Band741 } from '../lib/g64111';
import { ITEM_MAX, ITEM_LABEL, ITEM_GROUP, BAND_LABEL, BAND_STRATEGY } from '../lib/g64111';
import { analyzeDeal } from '../lib/pde';
import { ChatPanel } from './ChatPanel';
import { usePersistentState } from '../ui';
import { api } from '../api';
import { buildAiContext } from '../aiContext';
import { ACT_LABEL } from '../lib/pdeUi';

// 741 四档语义色（同 types.ts 硬编码语义色惯例）
const BAND_TONE: Record<Band741, string> = {
  ABSOLUTE_ADVANTAGE: '#16a34a',
  RELATIVE_ADVANTAGE: '#2563eb',
  RELATIVE_DISADVANTAGE: '#f59e0b',
  ABSOLUTE_DISADVANTAGE: '#dc2626',
};
const GROUPS = ['6必清', '4优势', '1决胜'] as const;
// E2 背离警示行用（自 EngineBar 迁入）：六档支持度的界面用语
const SENT_TEXT: Record<Sentiment, string> = { star: '排他支持', plus: '支持', neutral: '中立', unknown: '未知', minus: '抗拒', x: '倒向对手' };
const p2 = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const todayYmd = () => fmt(new Date());
const addDaysYmd = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return fmt(d); };
const mmdd = (ymd: string) => (ymd && ymd.length >= 10 ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : '未定');

interface FwdCand { gapItem: string; title: string; basis: string; }
interface BwdCand { title: string; offsetDays: number; }
type DrawerState = null | { kind: 'card'; id: string } | { kind: 'milestone'; id: string } | { kind: 'goal' } | { kind: 'action'; id: string } | { kind: 'whatif' };
type DockHeight = 'collapsed' | 'half' | 'full';
// 第3刀：AI 可预填的行动四要素（title/personId 由策略卡携带，不在此列）
type AiFieldKey = 'target' | 'resources' | 'cautions' | 'props';
type Prefill = Record<AiFieldKey, string>;

// M5 · 列④引擎候选（action-ranking ΔEV 排序，裁决A IntelAndActionPanel 下半落坞）
interface EngineAction { actionKey: string; title: string; personId: string; personName: string; d_pwin: number; gross: number | null; cost: number; dEV: number | null; ratio: number | null; gist: string; scriptRef: string; }

// M5 复盘台 · 赢面走势 sparkline（快照序列，manual 打点高亮；纯 SVG 无依赖）
function Sparkline({ snaps }: { snaps: any[] }) {
  const pts = [...snaps].reverse().map((s) => ({ pwin: Number(s.pwin ?? 0), trigger: s.trigger, at: String(s.createdAt ?? '') }));
  const W = 220, H = 56, PAD = 7;
  const xs = (i: number) => PAD + (i / Math.max(1, pts.length - 1)) * (W - PAD * 2);
  const ys = (p: number) => H - PAD - Math.max(0, Math.min(1, p)) * (H - PAD * 2);
  const last = pts[pts.length - 1]!;
  return (
    <svg className="dock-spark" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="赢面走势">
      <polyline points={pts.map((p, i) => `${xs(i)},${ys(p.pwin)}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.5" />
      {pts.map((p, i) => (
        <circle key={i} cx={xs(i)} cy={ys(p.pwin)} r={i === pts.length - 1 ? 3 : 2} fill={p.trigger === 'manual' ? 'var(--accent)' : 'var(--faint)'}>
          <title>{`${p.at.slice(0, 10)} · 赢面 ${Math.round(p.pwin * 100)}%（${p.trigger === 'manual' ? '手动打点' : p.trigger}）`}</title>
        </circle>
      ))}
      <text x={W - PAD} y={Math.max(10, ys(last.pwin) - 6)} textAnchor="end" fontSize="10" fill="var(--ink-2)">{Math.round(last.pwin * 100)}%</text>
    </svg>
  );
}

export function DeliberationDock({
  account, opp, breakdown, dispatch, selectedPersonId, onSelectPerson, openActionId, onActionOpened, onChatDone,
}: {
  account: Account;
  opp: Opportunity;
  breakdown: ScoreBreakdown;
  dispatch: (a: Action) => void;
  selectedPersonId?: string | null;
  onSelectPerson?: (id: string | null) => void;
  openActionId?: string | null; // 点画布行动牌 → 打开该行动的编辑抽屉
  onActionOpened?: () => void;
  onChatDone?: () => void; // 坞尾「和地图对话」落库后刷新（第1刀：对话从左栏收进坞，一处入口）
}) {
  const itemKeys = Object.keys(ITEM_MAX) as ItemKey[];
  const personById = new Map(account.persons.map((p) => [p.id, p]));
  const [height, setHeight] = usePersistentState<DockHeight>('jianghu.dockHeight', 'half');

  // M5 嵌入：坞头四动作徽章（PDE 引擎建议·赢面带置信）——全屏唯一赢面出口。引擎不可用静默隐藏，不阻塞坞。
  // 复盘台（M5 裁决A·DealPokerDashboard 第二级）共用同一响应：双轨分/建议卡/gate 用 pdeFull，坞头徽章从中派生。
  const [pdeFull, setPdeFull] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    api.pdeEv(opp.id)
      .then((r) => { if (alive) setPdeFull(r); })
      .catch(() => { if (alive) setPdeFull(null); });
    return () => { alive = false; };
  }, [opp.id, breakdown]);
  const pde = pdeFull ? { action: pdeFull.recommendation?.action ?? '', pwin: pdeFull.pwin ?? 0, flag: pdeFull.confidenceFlag ?? '' } : null;

  // M5 · 列④引擎候选：action-ranking ΔEV 排序 top3。只展示，人采纳才落草稿（铁律②）；引擎不可用静默。
  const [engActs, setEngActs] = useState<EngineAction[] | null>(null);
  const [dismissedActs, setDismissedActs] = useState<Set<string>>(new Set()); // actionKey@personId 会话级忽略
  useEffect(() => {
    let alive = true;
    api.pdeActions(opp.id)
      .then((r) => { if (alive) setEngActs(r.actions ?? []); })
      .catch(() => { if (alive) setEngActs(null); });
    return () => { alive = false; };
  }, [opp.id, breakdown]);

  // 复盘台走势：full 档才懒拉快照序列；📸 手动打点后重拉
  const [snaps, setSnaps] = useState<any[] | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  useEffect(() => {
    if (height !== 'full') return;
    let alive = true;
    api.pdeSnapshots(opp.id).then((r) => { if (alive) setSnaps(r.snapshots ?? []); }).catch(() => { if (alive) setSnaps([]); });
    return () => { alive = false; };
  }, [height, opp.id, breakdown]);
  const takeSnapshot = async () => {
    if (snapBusy) return;
    setSnapBusy(true);
    try {
      await api.pdeSnapshot(opp.id);
      const r = await api.pdeSnapshots(opp.id);
      setSnaps(r.snapshots ?? []);
    } catch { /* 引擎不可用静默 */ } finally { setSnapBusy(false); }
  };

  // 老 PDE 适配层：只取 列① 姿态解读 + E2 背离提案（EV/赢面老口径随 EngineBar 退役，不再展示）
  const reading = useMemo(() => analyzeDeal(account, opp, breakdown), [account, opp, breakdown]);
  const [dismissedShifts, setDismissedShifts] = useState<Set<string>>(new Set()); // 忽略的背离提案 personId
  const shifts = reading.stanceShifts.filter((s) => !dismissedShifts.has(s.personId));
  const acceptShift = (personId: string, to: Sentiment) => {
    dispatch({ type: 'SET_ROLE', accId: account.id, oppId: opp.id, personId, patch: { sentiment: to } });
    setDismissedShifts((s) => new Set(s).add(personId));
  };

  // 缺口：低于满分的项，按缺口降序
  const gaps = itemKeys
    .map((k) => ({ key: k, score: breakdown.items[k], max: ITEM_MAX[k], deficit: ITEM_MAX[k] - breakdown.items[k] }))
    .filter((g) => g.deficit > 0)
    .sort((a, b) => b.deficit - a.deficit);

  // 本商机的策略卡 / 雷（第6刀：假设与弹药 UI 全退存量留库，风险只剩 kind==='risk' 进坞头红条）/ 里程碑
  const cards = (account.strategyCards ?? [])
    .filter((c) => c.opportunityId === opp.id && c.status !== 'dismissed')
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const risks = (account.strategyRisks ?? []).filter((r) => r.opportunityId === opp.id && r.status !== 'dismissed' && r.kind === 'risk');
  const milestones = (account.milestones ?? []).filter((m) => m.opportunityId === opp.id);
  const planActions = (account.planActions ?? []).filter((a) => a.opportunityId === opp.id);

  // 缺口是否已有策略卡覆盖（列① ✓ 标记）
  const coveredGaps = new Set(cards.map((c) => c.gapItem).filter(Boolean));

  const pct = Math.round(breakdown.percent * 100);
  const tone = BAND_TONE[breakdown.band];

  // ── 策略卡 ──
  const addCard = (gapItem = '') => {
    const card = newStrategyCard(account.id, opp.id, gapItem);
    card.orderIndex = cards.length;
    dispatch({ type: 'ADD_STRATEGY_CARD', accId: account.id, oppId: opp.id, card });
    setDrawer({ kind: 'card', id: card.id });
  };
  const updateCard = (cardId: string, patch: Partial<StrategyCard>) =>
    dispatch({ type: 'UPDATE_STRATEGY_CARD', accId: account.id, cardId, patch });
  const deleteCard = (cardId: string) => { dispatch({ type: 'DELETE_STRATEGY_CARD', accId: account.id, cardId }); setDrawer(null); };

  // ── 派发：策略卡 → 行动牌（第3刀：AI 预填四要素初稿 → 落草稿 origin=ai → 开抽屉人微调，人保存才定稿守铁律②）──
  // aiMark = 字段来源前端态（🤖AI建议/✍️手改，不落库）；prefillBusy = 预填中的 cardId 或 'drawer'（抽屉内补全）
  const [aiMark, setAiMark] = useState<{ actionId: string; fields: Partial<Record<AiFieldKey, 'ai' | 'edited'>> } | null>(null);
  const [prefillBusy, setPrefillBusy] = useState<string | null>(null);
  const fetchPrefill = async (card: { title?: string; basis?: string; gapItem?: string }, personId?: string): Promise<Prefill | null> => {
    try {
      const target = personId ? personById.get(personId) : null;
      const ctx = buildAiContext(account, opp, breakdown);
      const r = await api.strategyPrefill(opp.id, card, target ? { name: target.name, title: target.title } : undefined, ctx);
      return r.prefill;
    } catch { return null; } // 预填失败降级：无初稿开抽屉手填（不阻塞派发）
  };
  const dispatchToPlanner = async (card: StrategyCard) => {
    if (prefillBusy) return;
    setPrefillBusy(card.id);
    const pf = await fetchPrefill({ title: card.title, basis: card.basis, gapItem: card.gapItem }, card.personId);
    setPrefillBusy(null);
    const d0 = todayYmd();
    const pa = newPlanAction(account.id, opp.id, d0, d0, 'am');
    pa.title = card.title;
    pa.gapItem = card.gapItem || '';
    if (card.personId) pa.personId = card.personId;
    if (card.basis) pa.scene = card.basis;
    pa.origin = 'ai';
    pa.draft = true; // 第4刀：派发产物=坞内草稿，人微调后「→ 上桌」才挂画布
    if (pf) { pa.target = pf.target; pa.resources = pf.resources; pa.cautions = pf.cautions; pa.props = pf.props; }
    dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
    updateCard(card.id, { dispatchedActionIds: [...(card.dispatchedActionIds ?? []), pa.id] });
    const fields: Partial<Record<AiFieldKey, 'ai'>> = {};
    (['target', 'resources', 'cautions', 'props'] as AiFieldKey[]).forEach((k) => { if (pf?.[k]) fields[k] = 'ai'; });
    setAiMark(pf ? { actionId: pa.id, fields } : null);
    setDrawer({ kind: 'action', id: pa.id });
  };

  // ── 终局 + 里程碑（里程碑 = 行动计划 OppMilestone，直接共享）──
  const updateGoal = (patch: Partial<Opportunity>) => dispatch({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch });
  const addMilestone = () => {
    const ms = newMilestone(account.id, opp.id, opp.expectedSignDate || todayYmd(), 'am');
    dispatch({ type: 'ADD_MILESTONE', accId: account.id, oppId: opp.id, milestone: ms });
    setDrawer({ kind: 'milestone', id: ms.id });
  };
  const updateMilestone = (milestoneId: string, patch: { title?: string; startDate?: string; endDate?: string }) =>
    dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId, patch });
  const deleteMilestone = (milestoneId: string) => { dispatch({ type: 'DELETE_MILESTONE', accId: account.id, milestoneId }); setDrawer(null); };

  // ── 人工雷红条（第6刀：风险砍容器降级坞头，行内＋加雷 ✕排雷；severity 留库不展示，无编辑=删了重记）──
  const [riskDraft, setRiskDraft] = useState<string | null>(null); // null=未在录入；string=inline 输入中
  const commitRisk = () => {
    const text = (riskDraft ?? '').trim();
    if (text) {
      const risk = newStrategyRisk(account.id, opp.id, 'risk');
      risk.text = text;
      dispatch({ type: 'ADD_STRATEGY_RISK', accId: account.id, oppId: opp.id, risk });
    }
    setRiskDraft(null);
  };
  const deleteRisk = (riskId: string) => dispatch({ type: 'DELETE_STRATEGY_RISK', accId: account.id, riskId });

  // ── AI 顺推/倒推（候选本地暂存，采纳才落库；守"AI 绝不自动写库"红线）──
  const [aiBusy, setAiBusy] = useState<'forward' | 'backward' | null>(null);
  const [aiErr, setAiErr] = useState('');
  const [fwdCands, setFwdCands] = useState<FwdCand[]>([]);
  const [bwdCands, setBwdCands] = useState<BwdCand[]>([]);

  const runSuggest = async (mode: 'forward' | 'backward') => {
    if (aiBusy) return;
    setAiBusy(mode); setAiErr('');
    try {
      const ctx = { ...buildAiContext(account, opp, breakdown), existingCardTitles: cards.map((c) => c.title).filter(Boolean) };
      const r = await api.strategySuggest(opp.id, mode, ctx);
      if (mode === 'forward') setFwdCands(r.candidates || []);
      else setBwdCands(r.candidates || []);
    } catch (e: any) {
      setAiErr(e?.message || 'AI 推演失败');
    } finally { setAiBusy(null); }
  };
  const acceptFwd = (i: number) => {
    const c = fwdCands[i]; if (!c) return;
    const card = newStrategyCard(account.id, opp.id, c.gapItem || '');
    card.title = c.title; card.basis = c.basis; card.origin = 'ai'; card.orderIndex = cards.length;
    dispatch({ type: 'ADD_STRATEGY_CARD', accId: account.id, oppId: opp.id, card });
    setFwdCands((xs) => xs.filter((_, j) => j !== i));
  };
  const acceptBwd = (i: number) => {
    const c = bwdCands[i]; if (!c) return;
    const ms = newMilestone(account.id, opp.id, addDaysYmd(c.offsetDays), 'am');
    ms.title = c.title;
    dispatch({ type: 'ADD_MILESTONE', accId: account.id, oppId: opp.id, milestone: ms });
    setBwdCands((xs) => xs.filter((_, j) => j !== i));
  };

  // ── 视图状态：详情抽屉 ──
  const [drawer, setDrawer] = useState<DrawerState>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 切商机/客户 → 关抽屉、清背离忽略集、丢未落库的雷草稿、清字段来源标记、清引擎候选忽略集
  useEffect(() => { setDrawer(null); setDismissedShifts(new Set()); setRiskDraft(null); setAiMark(null); setDismissedActs(new Set()); }, [opp.id, account.id]);

  // ── what-if 假设推演（复盘台抽屉 · SPEC §7）：沙盘不落库，关抽屉即散；假设=此刻新情报（服务端 age 归零）──
  const [wiBase, setWiBase] = useState<any>(null);      // 基线 + 当前牌局人员表（开抽屉时空 overrides 拉取）
  const [wiRows, setWiRows] = useState<Record<string, { sentiment: string; confidence: string }>>({});
  const [wiResult, setWiResult] = useState<any>(null);
  const [wiBusy, setWiBusy] = useState(false);
  useEffect(() => {
    if (drawer?.kind !== 'whatif') { setWiBase(null); setWiRows({}); setWiResult(null); return; }
    let alive = true;
    api.pdeWhatIf(opp.id, [])
      .then((r) => {
        if (!alive) return;
        setWiBase(r);
        setWiRows(Object.fromEntries(r.stakeholders.map((s) => [s.id, { sentiment: s.sentiment, confidence: s.confidence }])));
      })
      .catch(() => { if (alive) setWiBase(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);
  const wiChanged = wiBase ? wiBase.stakeholders.filter((s: any) => { const r = wiRows[s.id]; return r && (r.sentiment !== s.sentiment || r.confidence !== s.confidence); }) : [];
  const runWhatIf = async () => {
    if (wiBusy || !wiBase || wiChanged.length === 0) return;
    const overrides = wiChanged.map((s: any) => {
      const r = wiRows[s.id]!;
      return { personId: s.id, ...(r.sentiment !== s.sentiment ? { sentiment: r.sentiment } : {}), ...(r.confidence !== s.confidence ? { confidence: r.confidence } : {}) };
    });
    setWiBusy(true);
    try { setWiResult(await api.pdeWhatIf(opp.id, overrides)); } catch { /* 引擎不可用静默 */ } finally { setWiBusy(false); }
  };
  const resetWhatIf = () => {
    if (!wiBase) return;
    setWiRows(Object.fromEntries(wiBase.stakeholders.map((s: any) => [s.id, { sentiment: s.sentiment, confidence: s.confidence }])));
    setWiResult(null);
  };

  // ── 行动清单（PlanAction，承接 DealPlanner 网格退役；勾完成→结果回填录证据，闭合执行→证据→局势飞轮）──
  const [actDraft, setActDraft] = useState<{ title: string; startDate: string; personId?: string; target: string; resources: string; cautions: string; props: string; done: boolean; wasDone: boolean; outcome?: 'up' | 'flat' | 'down' } | null>(null);
  useEffect(() => {
    if (drawer?.kind === 'action') {
      const a = (account.planActions ?? []).find((x) => x.id === drawer.id);
      if (a) {
        setActDraft({ title: a.title || '', startDate: a.startDate || todayYmd(), personId: a.personId, target: a.target || '', resources: a.resources || '', cautions: a.cautions || '', props: a.props || '', done: !!a.done, wasDone: !!a.done });
        // 来源标记按库值校准：补全后未保存就关抽屉的字段（库里为空）清掉标记，避免重开误标 🤖
        setAiMark((m) => {
          if (!m || m.actionId !== drawer.id) return m;
          const fields = { ...m.fields };
          (['target', 'resources', 'cautions', 'props'] as AiFieldKey[]).forEach((k) => { if (!a[k]) delete fields[k]; });
          return { ...m, fields };
        });
      }
    } else setActDraft(null);
    // 仅在切换抽屉对象时初始化草稿；编辑中不因 store 更新而重置（避免清掉未保存输入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);
  // 点画布行动牌 → 展开坞 + 打开该行动编辑抽屉
  useEffect(() => {
    if (openActionId) { setHeight('half'); setDrawer({ kind: 'action', id: openActionId }); onActionOpened?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openActionId]);
  const addAction = () => {
    const pa = newPlanAction(account.id, opp.id, todayYmd(), todayYmd(), 'am');
    pa.title = '';
    pa.draft = true; // 第4刀：坞内手建=草稿，「→ 上桌」才挂画布
    dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
    setActDraft({ title: '', startDate: pa.startDate, personId: undefined, target: '', resources: '', cautions: '', props: '', done: false, wasDone: false });
    setDrawer({ kind: 'action', id: pa.id });
  };
  const deleteAction = (actionId: string) => { dispatch({ type: 'DELETE_PLAN_ACTION', accId: account.id, actionId }); setDrawer(null); };
  // 第4刀 · 上桌=状态跃迁：草稿→作战令挂画布目标人旁（需先关联干系人）；computeInverse 通用 pick 使上桌可撤销
  const stageAction = (actionId: string) => dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId, patch: { draft: false } });

  // M5 · 引擎候选 top3：忽略集 + 正收益 + 已有同名未完成行动过滤（采纳产物 title/personId 同名 → 刷新后自动不再荐，跨会话防重）
  const engCands = (engActs ?? [])
    .filter((a) => !dismissedActs.has(`${a.actionKey}@${a.personId}`))
    .filter((a) => (a.dEV != null ? a.dEV > 0 : a.d_pwin > 0))
    .filter((a) => !planActions.some((p) => !p.done && p.title === a.title && p.personId === a.personId))
    .slice(0, 3);
  const acceptEngine = (a: EngineAction) => {
    const pa = newPlanAction(account.id, opp.id, todayYmd(), todayYmd(), 'am');
    pa.title = a.title;
    pa.personId = a.personId;
    pa.target = a.gist || '';
    pa.origin = 'ai';
    pa.draft = true; // 第4刀语义：采纳=坞内草稿，人微调「→ 上桌」才挂画布
    dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
    setDismissedActs((s) => new Set(s).add(`${a.actionKey}@${a.personId}`));
    setDrawer({ kind: 'action', id: pa.id });
  };
  const saveAction = (actionId: string, andStage = false) => {
    if (!actDraft) return;
    const d = actDraft; const today = todayYmd();
    const title = d.title.trim() || '新行动';
    dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId, patch: { title, startDate: d.startDate, endDate: d.startDate, personId: d.personId, target: d.target, resources: d.resources, cautions: d.cautions, props: d.props, done: d.done, doneAt: d.done ? today : undefined, ...(andStage ? { draft: false } : {}) } });
    // 结果回填：完成且关联干系人、选了态度变化 → 录一条互动证据喂策略引擎 E2（守铁律②：人当场拍板，非机器自动改分）
    if (d.done && !d.wasDone && d.personId && (d.outcome === 'up' || d.outcome === 'down')) {
      const ev = newEvidence(account.id, opp.id, d.personId, d.outcome === 'up' ? 'positive_interaction' : 'negative_interaction', d.outcome === 'up' ? 1 : -1, 'mid');
      ev.rawContent = `行动结果回填：${title}`; ev.occurredAt = today;
      dispatch({ type: 'ADD_EVIDENCE', accId: account.id, oppId: opp.id, evidence: ev });
    }
    setDrawer(null);
  };

  // ── 第3刀：抽屉内「✨ 让引擎补全」——只补空白要素不覆盖已填（human-wins）；字段来源徽章 helpers ──
  const runDrawerPrefill = async () => {
    if (prefillBusy || !actDraft || drawer?.kind !== 'action') return;
    const actionId = drawer.id;
    setPrefillBusy('drawer');
    const a = (account.planActions ?? []).find((x) => x.id === actionId);
    const pf = await fetchPrefill({ title: actDraft.title, basis: a?.scene, gapItem: a?.gapItem }, actDraft.personId);
    setPrefillBusy(null);
    if (!pf) return;
    const next = { ...actDraft };
    const fill: Partial<Record<AiFieldKey, 'ai'>> = {};
    (['target', 'resources', 'cautions', 'props'] as AiFieldKey[]).forEach((k) => {
      if (!next[k].trim() && pf[k]) { next[k] = pf[k]; fill[k] = 'ai'; }
    });
    setActDraft(next);
    setAiMark((m) => ({ actionId, fields: { ...(m?.actionId === actionId ? m.fields : {}), ...fill } }));
  };
  const fieldMark = (k: AiFieldKey) => (drawer?.kind === 'action' && aiMark?.actionId === drawer.id ? aiMark.fields[k] : undefined);
  const markEdited = (k: AiFieldKey) =>
    setAiMark((m) => (m && drawer?.kind === 'action' && m.actionId === drawer.id && m.fields[k] === 'ai' ? { ...m, fields: { ...m.fields, [k]: 'edited' } } : m));
  const srcBadge = (k: AiFieldKey) => {
    const mk = fieldMark(k);
    return mk ? <em className={`sb2-src sb2-src-${mk}`}>{mk === 'ai' ? '🤖 AI 建议' : '✍️ 手改'}</em> : null;
  };

  // 里程碑泳道条目：正式里程碑 + 倒推候选按日期混排（候选虚位出现在它将落的位置上）
  const laneMs: ({ t: 'ms'; date: string; m: (typeof milestones)[number] } | { t: 'cand'; date: string; c: BwdCand; i: number })[] = [
    ...milestones.map((m) => ({ t: 'ms' as const, date: m.startDate || '9999-99-99', m })),
    ...bwdCands.map((c, i) => ({ t: 'cand' as const, date: addDaysYmd(c.offsetDays), c, i })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const drawerCard = drawer?.kind === 'card' ? cards.find((c) => c.id === drawer.id) : null;
  const drawerMs = drawer?.kind === 'milestone' ? milestones.find((m) => m.id === drawer.id) : null;
  const focusName = selectedPersonId ? personById.get(selectedPersonId)?.name : null;

  return (
    <div className={`dock dock-${height}`} onClick={() => setDrawer(null)}>
      {/* ── 坞头：抓手 + 趋赢力 + 聚焦标识 + 三档切换 ── */}
      <div className="dock-head" onClick={(e) => e.stopPropagation()}>
        <button className="dock-grip" title={height === 'collapsed' ? '展开推演坞' : '收起推演坞'}
          onClick={() => setHeight(height === 'collapsed' ? 'half' : 'collapsed')}>{height === 'collapsed' ? '⌃' : '⌄'}</button>
        <span className="sb-band-pill" style={{ color: tone, borderColor: tone }}>● {BAND_LABEL[breakdown.band]} · 趋赢力 {pct}%</span>
        {pde && ACT_LABEL[pde.action] && (
          <span className={`mf-act mf-act-${ACT_LABEL[pde.action]!.cls}`}
            title={`引擎建议（赢面 ${Math.round(pde.pwin * 100)}%${pde.flag ? ` · ${pde.flag.includes('no_pot') ? '未设合同额，金额降级' : '置信偏低，先摸底'}` : ''}）${engCands[0] ? ` · 最优先：${engCands[0].title} → ${engCands[0].personName}（见列④引擎荐）` : ''}`}>
            {ACT_LABEL[pde.action]!.icon} {ACT_LABEL[pde.action]!.text} · 赢面 {Math.round(pde.pwin * 100)}%{pde.flag ? ' ⚠︎' : ''}
          </span>
        )}
        {focusName && (
          <span className="dock-focus-chip">🎯 聚焦 {focusName}
            <button onClick={() => onSelectPerson?.(null)} title="清除聚焦">✕</button>
          </span>
        )}
        <button className="dock-risk-add" title="记一条雷（高危风险，常驻坞头示警）" onClick={() => setRiskDraft('')}>⚠＋</button>
        <span className="dock-seg">
          {(['collapsed', 'half', 'full'] as const).map((h) => (
            <button key={h} className={height === h ? 'on' : ''} onClick={() => setHeight(h)}>{h === 'collapsed' ? '收起' : h === 'half' ? '展开' : '全展开'}</button>
          ))}
        </span>
      </div>

      {/* ── 坞头警示行 · E2 背离提案（证据偏离人审支持度时出现；人审采纳才改 OppRole，守铁律②）── */}
      {shifts.map((sh) => (
        <div className="dock-shift" key={sh.personId} onClick={(e) => e.stopPropagation()}>
          <span className="dock-shift-icon">🔔</span>
          <span className="dock-shift-text">
            <b>{sh.name}</b>：{sh.reason}——建议把支持度从「{SENT_TEXT[sh.fromSentiment]}」改为「{SENT_TEXT[sh.toSentiment]}」
          </span>
          <button className="btn primary xs" onClick={() => acceptShift(sh.personId, sh.toSentiment)}>采纳改分</button>
          <button className="btn ghost xs" onClick={() => setDismissedShifts((s) => new Set(s).add(sh.personId))}>忽略</button>
        </div>
      ))}

      {/* ── 坞头警示行 · 人工雷红条（第6刀：风险砍容器降级至此，与背离黄条同族并列；三档高度均可见）── */}
      {risks.map((r) => (
        <div className="dock-risk" key={r.id} onClick={(e) => e.stopPropagation()}>
          <span className="dock-risk-icon">⚠</span>
          <span className="dock-risk-text">{r.text || <span className="sb2-dim">（空雷 · 点 ✕ 排掉）</span>}</span>
          <button className="dock-risk-del" title="排雷（删除）" onClick={() => deleteRisk(r.id)}>✕</button>
        </div>
      ))}
      {riskDraft !== null && (
        <div className="dock-risk" onClick={(e) => e.stopPropagation()}>
          <span className="dock-risk-icon">⚠</span>
          <input className="dock-risk-input" autoFocus value={riskDraft} placeholder="一句话记雷：这局会出事的点（回车落档 · Esc 放弃）"
            onChange={(e) => setRiskDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitRisk(); else if (e.key === 'Escape') setRiskDraft(null); }}
            onBlur={commitRisk} />
        </div>
      )}

      {height !== 'collapsed' && (
        <div className="dock-scroll">
          {/* ── 第2刀：横向推导流水线 局势 → 策略 → 倒排 → 行动（列间箭头显因果；第6刀后旁支全退，雷在坞头红条）── */}
          <div className="sb2-cols" onClick={(e) => e.stopPropagation()}>

          {/* 列① 局势（EngineBar 退役后唯一详情出口：band + 打法方向 + 姿态解读一句 + 全部缺口）*/}
          <div className="sb2-col">
            <div className="sb2-col-head"><span>① 局势</span></div>
            <div className="sb2-card sb2-anchor" style={{ borderColor: tone }}>
              <div className="sb2-anchor-tag">现状锚 · 来自地图</div>
              <div className="sb2-anchor-band" style={{ color: tone }}>{pct}% {BAND_LABEL[breakdown.band].split(' · ')[0]}</div>
              <div className="sb2-anchor-strat">{BAND_STRATEGY[breakdown.band].split('：')[0]}</div>
              <div className="sb2-anchor-read" title={reading.reasonText ? `依据：${reading.reasonText}` : undefined}>
                <span className={`sb2-anchor-stance tone-${reading.stanceTone}`}>{reading.stanceLabel}</span>
                {reading.jointReading}
              </div>
              <div className="sb2-anchor-gaps">
                {gaps.map((g) => (
                  <div className="sb2-gap-row" key={g.key}>
                    <span className="sb2-gap-name">{ITEM_LABEL[g.key]}</span>
                    <span className="sb2-gap-score">{g.score}/{g.max}</span>
                    {coveredGaps.has(g.key)
                      ? <span className="sb2-gap-cov" title="已有策略卡覆盖">✓</span>
                      : <button className="sb2-gap-add" title="挂一张策略卡" onClick={() => addCard(g.key)}>＋</button>}
                  </div>
                ))}
                {gaps.length === 0 && <div className="sb2-gap-row sb2-dim">无明显缺口 🎉</div>}
              </div>
            </div>
          </div>

          <div className="sb2-arrow" title="局势推导出策略">→</div>

          {/* 列② 策略（正推：现状 → 方向） */}
          <div className="sb2-col">
            <div className="sb2-col-head">
              <span>② 策略 · 正推</span>
              <span className="sb2-lane-acts" onClick={(e) => e.stopPropagation()}>
                {aiErr && <span className="sb2-ai-err">{aiErr}</span>}
                <button className="btn ghost xs" onClick={() => addCard()}>＋</button>
                <button className="btn ghost xs" disabled={aiBusy === 'forward'} onClick={() => runSuggest('forward')}>{aiBusy === 'forward' ? '推演中…' : '✨ 顺推'}</button>
              </span>
            </div>
            {/* 策略卡 */}
            {cards.map((card) => {
              const dispatched = (card.dispatchedActionIds?.length ?? 0) > 0;
              const target = card.personId ? personById.get(card.personId) : null;
              const focused = !!selectedPersonId && card.personId === selectedPersonId;
              return (
                <div key={card.id} className={`sb2-card sb2-strat${dispatched ? ' dispatched' : ''}${drawer?.kind === 'card' && drawer.id === card.id ? ' sel' : ''}${focused ? ' sb2-focus' : ''}`}
                  onClick={() => { setDrawer({ kind: 'card', id: card.id }); if (card.personId) onSelectPerson?.(card.personId); }}>
                  <div className="sb2-card-top">
                    {card.gapItem
                      ? <span className="sb2-chip">{ITEM_LABEL[card.gapItem as ItemKey] || card.gapItem}</span>
                      : <span className="sb2-chip sb2-chip-none">未挂缺口</span>}
                    {dispatched
                      ? <span className="sb2-dispatched">✓ 已派发 {card.dispatchedActionIds!.length}</span>
                      : <button className="sb2-send" disabled={!card.title || !!prefillBusy} title={card.title ? '生成行动（AI 预填四要素初稿，可微调）' : '先填打法标题'}
                          onClick={(e) => { e.stopPropagation(); dispatchToPlanner(card); }}>{prefillBusy === card.id ? '预填中…' : '→ 派发'}</button>}
                  </div>
                  <div className="sb2-card-title">{card.title || <span className="sb2-dim">（未命名打法 · 点击编辑）</span>}</div>
                  <div className="sb2-card-sub">
                    {card.basis ? `依据：${card.basis}` : '依据待补'}
                    {target ? ` · 目标：${target.name}` : ''}
                  </div>
                </div>
              );
            })}

            {/* AI 顺推候选虚位卡 */}
            {fwdCands.map((c, i) => (
              <div key={`fc${i}`} className="sb2-card sb2-cand">
                <div className="sb2-card-top">
                  {c.gapItem && <span className="sb2-chip">{ITEM_LABEL[c.gapItem as ItemKey] || c.gapItem}</span>}
                  <span className="sb2-stamp">待采纳</span>
                </div>
                <div className="sb2-card-title">{c.title}</div>
                <div className="sb2-card-sub">AI 顺推 · {c.basis || '依据见推演'}</div>
                <div className="sb2-cand-acts">
                  <button className="btn primary xs" onClick={() => acceptFwd(i)}>采纳</button>
                  <button className="btn ghost xs" onClick={() => setFwdCands((xs) => xs.filter((_, j) => j !== i))}>忽略</button>
                </div>
              </div>
            ))}
            {cards.length === 0 && fwdCands.length === 0 && (
              <div className="sb2-card sb2-empty-card" onClick={() => addCard()}>还没有策略卡<br /><span>从现状锚缺口点「＋」，或「✨ 顺推」</span></div>
            )}
          </div>

          <div className="sb2-arrow" title="策略按最晚时间倒排成里程碑">→</div>

          {/* 列③ 倒排（终局 → 最晚时间） */}
          <div className="sb2-col">
            <div className="sb2-col-head">
              <span>③ 倒排 · 里程碑</span>
              <span className="sb2-lane-acts" onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost xs" onClick={addMilestone}>＋</button>
                <button className="btn ghost xs" disabled={aiBusy === 'backward' || !opp.expectedSignDate} title={opp.expectedSignDate ? '' : '先在终局锚设置预计签约日'}
                  onClick={() => runSuggest('backward')}>{aiBusy === 'backward' ? '推演中…' : '✨ 倒推'}</button>
              </span>
            </div>
            {laneMs.length === 0 && (
              <div className="sb2-card sb2-empty-card" onClick={addMilestone}>从终局倒排关键节点<br /><span>开标 / 立项评审 / 签约…直接落行动计划时间轴</span></div>
            )}
            {laneMs.map((item) => item.t === 'ms' ? (
              <div key={item.m.id} className={`sb2-card sb2-ms${drawer?.kind === 'milestone' && drawer.id === item.m.id ? ' sel' : ''}`}
                onClick={() => setDrawer({ kind: 'milestone', id: item.m.id })}>
                <div className="sb2-card-top">
                  <span className="sb2-card-title">{item.m.title || <span className="sb2-dim">（未命名）</span>}</span>
                  <span className="sb2-ms-date">最晚 {mmdd(item.m.startDate || '')}</span>
                </div>
                <div className="sb2-card-sub">{item.m.startDate || '日期未定 · 点击设置'}</div>
              </div>
            ) : (
              <div key={`bc${item.i}`} className="sb2-card sb2-cand">
                <div className="sb2-card-top">
                  <span className="sb2-card-title">{item.c.title}</span>
                  <span className="sb2-stamp">待采纳</span>
                </div>
                <div className="sb2-card-sub">AI 倒推 · 约 {item.c.offsetDays} 天后（{mmdd(item.date)}）</div>
                <div className="sb2-cand-acts">
                  <button className="btn primary xs" onClick={() => acceptBwd(item.i)}>采纳</button>
                  <button className="btn ghost xs" onClick={() => setBwdCands((xs) => xs.filter((_, j) => j !== item.i))}>忽略</button>
                </div>
              </div>
            ))}

            {/* 终局锚 */}
            <div className={`sb2-card sb2-goal${drawer?.kind === 'goal' ? ' sel' : ''}`} onClick={() => setDrawer({ kind: 'goal' })}>
              <div className="sb2-anchor-tag">终局锚</div>
              <div className="sb2-goal-name">{opp.singleSalesGoal || <span className="sb2-dim">点击设定单一销售目标</span>}</div>
              {opp.expectedSignDate
                ? <span className="sb2-goal-date">≤ {mmdd(opp.expectedSignDate)}</span>
                : <span className="sb2-goal-date sb2-goal-unset">先设截止日（倒排基准）</span>}
            </div>
          </div>

          <div className="sb2-arrow" title="里程碑落成可执行的行动">→</div>

          {/* 列④ 行动（执行 → 结果回填；调度可视化交企业微信日历） */}
          <div className="sb2-col">
            <div className="sb2-col-head">
              <span>④ 行动 · 执行</span>
              <span className="sb2-lane-acts" onClick={(e) => e.stopPropagation()}>
                <button className="btn ghost xs" onClick={addAction}>＋</button>
              </span>
            </div>
            {/* M5 · 引擎候选（action-ranking ΔEV 降序 top3）：只展示，采纳→草稿开抽屉（铁律②）；pot 缺失降级纯赢面口径 */}
            {engCands.map((a) => (
              <div key={`${a.actionKey}@${a.personId}`} className="sb2-card sb2-cand sb2-eng">
                <div className="sb2-card-top">
                  <span className="sb2-chip sb2-chip-eng">⚙ 引擎荐</span>
                  <span className="sb2-ev" title={a.dEV != null ? `预期增益 ≈${a.dEV} 万（赢面 +${(a.d_pwin * 100).toFixed(1)}pp，成本 ${a.cost} 万）` : `赢面 +${(a.d_pwin * 100).toFixed(1)}pp（未设合同额，只给排序）`}>
                    {a.dEV != null ? `≈+${a.dEV} 万` : `+${(a.d_pwin * 100).toFixed(1)}pp`}
                  </span>
                </div>
                <div className="sb2-card-title">{a.title}</div>
                <div className="sb2-card-sub">目标：{a.personName}{a.dEV != null ? ` · 赢面 +${(a.d_pwin * 100).toFixed(1)}pp` : ''}</div>
                {a.gist && <div className="sb2-eng-gist">{a.gist}</div>}
                <div className="sb2-cand-acts">
                  <button className="btn primary xs" onClick={() => acceptEngine(a)}>采纳成草稿</button>
                  <button className="btn ghost xs" onClick={() => setDismissedActs((s) => new Set(s).add(`${a.actionKey}@${a.personId}`))}>忽略</button>
                </div>
              </div>
            ))}
            {planActions.length === 0 && engCands.length === 0 && (
              <div className="sb2-card sb2-empty-card" onClick={addAction}>还没有行动<br /><span>＋ 加一条，或在策略卡上「→ 派发」生成</span></div>
            )}
            {planActions.map((a) => {
              const overdue = !a.done && (a.endDate || a.startDate) < todayYmd();
              const target = a.personId ? personById.get(a.personId) : null;
              const focused = !!selectedPersonId && a.personId === selectedPersonId;
              return (
                <div key={a.id} className={`sb2-card sb2-action${a.draft ? ' sb2-draft' : ''}${a.done ? ' done' : ''}${drawer?.kind === 'action' && drawer.id === a.id ? ' sel' : ''}${focused ? ' sb2-focus' : ''}`}
                  onClick={() => { setDrawer({ kind: 'action', id: a.id }); if (a.personId) onSelectPerson?.(a.personId); }}>
                  <div className="sb2-card-top">
                    {a.draft ? (
                      <>
                        <span className="sb2-act-status sb2-act-draft">📝 草稿</span>
                        <button className="sb2-send" disabled={!a.personId} title={a.personId ? '上桌：挂到画布目标人旁，成为作战令' : '先关联目标干系人（点卡编辑）'}
                          onClick={(e) => { e.stopPropagation(); stageAction(a.id); }}>→ 上桌</button>
                      </>
                    ) : (
                      <>
                        <span className={`sb2-act-status${a.done ? ' done' : overdue ? ' late' : ''}`}>{a.done ? '✓ 已完成' : overdue ? '✕ 逾期' : '○ 待办'}</span>
                        <span className="sb2-ms-date">{mmdd(a.startDate || '')}</span>
                      </>
                    )}
                  </div>
                  <div className="sb2-card-title">{a.title || <span className="sb2-dim">（未命名行动 · 点击编辑）</span>}</div>
                  <div className="sb2-card-sub">{target ? `目标：${target.name}` : '未关联干系人'}{a.gapItem ? ` · ${ITEM_LABEL[a.gapItem as ItemKey] || a.gapItem}` : ''}</div>
                </div>
              );
            })}
          </div>

          </div>

          {/* ── M5 复盘台（仅 full 档 · 裁决A：DealPokerDashboard 第二级=坞全展开复盘态；双轨分/建议卡/走势，what-if 留下一刀）── */}
          {height === 'full' && pdeFull && (
            <div className="dock-review" onClick={(e) => e.stopPropagation()}>
              <div className="dock-review-head">
                <span className="dock-review-cap">🎰 复盘台 · 引擎全景</span>
                <span className="dock-review-acts">
                  <button className="btn ghost xs" onClick={() => setDrawer({ kind: 'whatif' })} title="假设某人立场变化，赢面会怎样——沙盘推演不落库">🧪 假设推演</button>
                  <button className="btn ghost xs" disabled={snapBusy} onClick={takeSnapshot} title="把当前局面存成快照，积累赢面走势">{snapBusy ? '打点中…' : '📸 打个快照'}</button>
                </span>
              </div>
              {pdeFull.gate && (
                <div className="dock-gate">⚠ 把关人红线触发：关键把关人强烈反对，赢面被强制压制——先排雷再谈推进</div>
              )}
              <div className="dock-review-grid">
                <div className="dock-review-col">
                  <h5>双轨分</h5>
                  <div className="dock-dual">
                    <div className="dock-dual-item"><b>{Math.round(pdeFull.score?.nominal ?? 0)}</b><span>名义分 · 打分表原值</span></div>
                    <div className="dock-dual-item"><b>{Math.round(pdeFull.score?.weighted ?? 0)}</b><span>加权分 · 按证据可信度折扣</span></div>
                  </div>
                  <div className="dock-review-note">差 {Math.round(pdeFull.score?.gap ?? 0)} 分＝情报还没坐实的部分。作战工具，非考核指标。</div>
                </div>
                <div className="dock-review-col">
                  <h5>引擎建议</h5>
                  {ACT_LABEL[pdeFull.recommendation?.action] && (
                    <span className={`mf-act mf-act-${ACT_LABEL[pdeFull.recommendation.action]!.cls}`}>
                      {ACT_LABEL[pdeFull.recommendation.action]!.icon} {ACT_LABEL[pdeFull.recommendation.action]!.text}
                    </span>
                  )}
                  <div className="dock-review-note">{pdeFull.recommendation?.reason || '—'}</div>
                  {(pdeFull.recommendation?.weak_key_stakeholders?.length ?? 0) > 0 && (
                    <div className="dock-review-weak">薄弱关键人：{pdeFull.recommendation.weak_key_stakeholders.map((id: string) => pdeFull.stakeholders?.find((s: any) => s.id === id)?.name ?? id).join('、')}</div>
                  )}
                </div>
                <div className="dock-review-col">
                  <h5>赢面走势</h5>
                  {(snaps?.length ?? 0) >= 2
                    ? <Sparkline snaps={snaps!} />
                    : <div className="dock-review-note">{snaps === null ? '加载中…' : '快照不足两张——每次复盘 📸 打个点，赢面变化就能连成线'}</div>}
                </div>
              </div>
            </div>
          )}

        </div>
      )}

      {/* ── 坞尾 · 和地图对话（第1刀：从左栏收进坞的唯一常驻对话入口；改图直落走 voiceExtract 双轨不变）── */}
      {height !== 'collapsed' && (
        <div className="dock-chat" onClick={(e) => e.stopPropagation()}>
          <ChatPanel account={account} opp={opp} onDone={onChatDone ?? (() => {})} height={height === 'full' ? 200 : 150} />
        </div>
      )}

      {/* ── 详情抽屉（点卡热切换 · Esc/空白关闭）── */}
      {drawer && (
        <div className="drawer sb2-drawer" onClick={(e) => e.stopPropagation()}>
          {drawerCard && (
            <>
              <div className="drawer-head">
                <span className="t">♟️ 策略卡</span>
                <button className="x-btn" onClick={() => setDrawer(null)}>✕</button>
              </div>
              <div className="sb2-drawer-body">
                <label className="sb-field"><span>挂靠缺口</span>
                  <select value={drawerCard.gapItem || ''} onChange={(e) => updateCard(drawerCard.id, { gapItem: e.target.value })}>
                    <option value="">（不挂缺口）</option>
                    {GROUPS.map((grp) => (
                      <optgroup key={grp} label={grp}>
                        {itemKeys.filter((k) => ITEM_GROUP[k] === grp).map((k) => <option key={k} value={k}>{ITEM_LABEL[k]}（{breakdown.items[k]}/{ITEM_MAX[k]}）</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="sb-field"><span>打法标题</span>
                  <input defaultValue={drawerCard.title} key={`t${drawerCard.id}`} placeholder="如：借标杆案例撬动 D"
                    onBlur={(e) => e.target.value !== drawerCard.title && updateCard(drawerCard.id, { title: e.target.value })} />
                </label>
                <label className="sb-field"><span>依据 / 说明</span>
                  <textarea defaultValue={drawerCard.basis ?? ''} key={`b${drawerCard.id}`} rows={3} placeholder="为什么这么打"
                    onBlur={(e) => e.target.value !== (drawerCard.basis ?? '') && updateCard(drawerCard.id, { basis: e.target.value })} />
                </label>
                <label className="sb-field"><span>备选打法</span>
                  <textarea defaultValue={drawerCard.alternatives ?? ''} key={`a${drawerCard.id}`} rows={2} placeholder="此路不通时的 B 计划"
                    onBlur={(e) => e.target.value !== (drawerCard.alternatives ?? '') && updateCard(drawerCard.id, { alternatives: e.target.value })} />
                </label>
                <label className="sb-field"><span>目标干系人</span>
                  <select value={drawerCard.personId || ''} onChange={(e) => updateCard(drawerCard.id, { personId: e.target.value || undefined })}>
                    <option value="">（可选）</option>
                    {account.persons.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}
                  </select>
                </label>
                <div className="sb2-drawer-acts">
                  {(drawerCard.dispatchedActionIds?.length ?? 0) > 0
                    ? <span className="sb2-dispatched">✓ 已派发 {drawerCard.dispatchedActionIds!.length} 个行动（见行动计划）</span>
                    : <button className="btn primary sm" disabled={!drawerCard.title || !!prefillBusy} onClick={() => dispatchToPlanner(drawerCard)}>{prefillBusy === drawerCard.id ? '✨ 预填中…' : '📤 送行动策划'}</button>}
                </div>
                {drawerCard.origin === 'ai' && <div className="sb2-origin">来源：AI 顺推（人审采纳）</div>}
                <button className="sb2-drawer-del" onClick={() => deleteCard(drawerCard.id)}>🗑 删除该策略卡</button>
              </div>
            </>
          )}
          {drawerMs && (
            <>
              <div className="drawer-head">
                <span className="t">🚩 里程碑</span>
                <button className="x-btn" onClick={() => setDrawer(null)}>✕</button>
              </div>
              <div className="sb2-drawer-body">
                <label className="sb-field"><span>里程碑名称</span>
                  <input defaultValue={drawerMs.title} key={`m${drawerMs.id}`} placeholder="如：立项评审 / 开标"
                    onBlur={(e) => e.target.value !== drawerMs.title && updateMilestone(drawerMs.id, { title: e.target.value })} />
                </label>
                <label className="sb-field"><span>最晚时间（倒排 deadline）</span>
                  <input type="date" defaultValue={drawerMs.startDate || ''} key={`d${drawerMs.id}`}
                    onChange={(e) => updateMilestone(drawerMs.id, { startDate: e.target.value, endDate: e.target.value })} />
                </label>
                <div className="sb2-origin">里程碑与「行动计划」时间轴共享，两边同步。</div>
                <button className="sb2-drawer-del" onClick={() => deleteMilestone(drawerMs.id)}>🗑 删除该里程碑</button>
              </div>
            </>
          )}
          {drawer.kind === 'goal' && (
            <>
              <div className="drawer-head">
                <span className="t">🎯 终局 · 目标</span>
                <button className="x-btn" onClick={() => setDrawer(null)}>✕</button>
              </div>
              <div className="sb2-drawer-body">
                <label className="sb-field"><span>单一销售目标</span>
                  <textarea defaultValue={opp.singleSalesGoal} key={`g${opp.id}`} rows={3} placeholder="本商机要拿下的明确结果"
                    onBlur={(e) => e.target.value !== opp.singleSalesGoal && updateGoal({ singleSalesGoal: e.target.value })} />
                </label>
                <label className="sb-field"><span>预计签约日（倒排基准）</span>
                  <input type="date" defaultValue={opp.expectedSignDate || ''} key={`gd${opp.id}`}
                    onChange={(e) => updateGoal({ expectedSignDate: e.target.value })} />
                </label>
                <div className="sb2-origin">设定截止日后，「✨ AI 倒推」可从终局反推里程碑。</div>
              </div>
            </>
          )}
          {drawer.kind === 'action' && actDraft && (
            <>
              <div className="drawer-head">
                <span className="t">🎯 行动</span>
                <button className="x-btn" onClick={() => setDrawer(null)}>✕</button>
              </div>
              <div className="sb2-drawer-body">
                <label className="sb-field"><span>行动标题</span>
                  <input value={actDraft.title} placeholder="如：拜访钱大钧 · 摸招标参数" onChange={(e) => setActDraft({ ...actDraft, title: e.target.value })} />
                </label>
                <label className="sb-field"><span>日期</span>
                  <input type="date" value={actDraft.startDate} onChange={(e) => setActDraft({ ...actDraft, startDate: e.target.value })} />
                </label>
                <label className="sb-field"><span>目标干系人</span>
                  <select value={actDraft.personId || ''} onChange={(e) => setActDraft({ ...actDraft, personId: e.target.value || undefined })}>
                    <option value="">（可选 · 关联后可回填态度）</option>
                    {account.persons.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}
                  </select>
                </label>
                <div className="sb2-prefill-row">
                  <button className="btn ghost xs" disabled={!!prefillBusy} onClick={runDrawerPrefill}>{prefillBusy === 'drawer' ? '✨ 补全中…' : '✨ 让引擎补全'}</button>
                  <span className="sb2-prefill-hint">只补空白要素，不覆盖已填</span>
                </div>
                <label className="sb-field"><span>目的{srcBadge('target')}</span>
                  <input value={actDraft.target} placeholder="这一手要达成什么" onChange={(e) => { markEdited('target'); setActDraft({ ...actDraft, target: e.target.value }); }} />
                </label>
                <label className="sb-field"><span>所需资源{srcBadge('resources')}</span>
                  <input value={actDraft.resources} placeholder="人 / 预算 / 内部支持…" onChange={(e) => { markEdited('resources'); setActDraft({ ...actDraft, resources: e.target.value }); }} />
                </label>
                <label className="sb-field"><span>注意要点{srcBadge('cautions')}</span>
                  <input value={actDraft.cautions} placeholder="风险 / 红线 / 话术提示" onChange={(e) => { markEdited('cautions'); setActDraft({ ...actDraft, cautions: e.target.value }); }} />
                </label>
                <label className="sb-field"><span>道具{srcBadge('props')}</span>
                  <input value={actDraft.props} placeholder="方案 / POC / 报告 / 会议大纲…（后续可交 WorkBuddy 生产）" onChange={(e) => { markEdited('props'); setActDraft({ ...actDraft, props: e.target.value }); }} />
                </label>
                <label className="dp-done"><input type="checkbox" checked={actDraft.done} onChange={(e) => setActDraft({ ...actDraft, done: e.target.checked })} /> 标记为已完成</label>
                {actDraft.done && !actDraft.wasDone && actDraft.personId && (
                  <div className="dp-outcome">
                    <span className="dp-outcome-q">这次接触后，{personById.get(actDraft.personId)?.name ?? '对方'}的态度：</span>
                    <div className="dp-pick">
                      <button className={actDraft.outcome === 'up' ? 'on up' : ''} onClick={() => setActDraft({ ...actDraft, outcome: 'up' })}>↑ 更积极</button>
                      <button className={actDraft.outcome === 'flat' ? 'on' : ''} onClick={() => setActDraft({ ...actDraft, outcome: 'flat' })}>— 没变化</button>
                      <button className={actDraft.outcome === 'down' ? 'on down' : ''} onClick={() => setActDraft({ ...actDraft, outcome: 'down' })}>↓ 更消极</button>
                    </div>
                    {(actDraft.outcome === 'up' || actDraft.outcome === 'down') && <p className="dp-outcome-hint">将作为一条证据喂入策略引擎，更新局势分布</p>}
                  </div>
                )}
                <div className="sb2-drawer-acts">
                  <button className="btn primary sm" onClick={() => saveAction(drawer.id)}>保存</button>
                  {(account.planActions ?? []).find((x) => x.id === drawer.id)?.draft && (
                    <button className="btn primary sm" disabled={!actDraft.personId} title={actDraft.personId ? '保存并挂到画布目标人旁' : '先选目标干系人'}
                      onClick={() => saveAction(drawer.id, true)}>📌 保存并上桌</button>
                  )}
                </div>
                <button className="sb2-drawer-del" onClick={() => deleteAction(drawer.id)}>🗑 删除该行动</button>
              </div>
            </>
          )}
          {drawer.kind === 'whatif' && (
            <>
              <div className="drawer-head">
                <span className="t">🧪 假设推演 · 沙盘不落库</span>
                <button className="x-btn" onClick={() => setDrawer(null)}>✕</button>
              </div>
              <div className="sb2-drawer-body">
                {!wiBase && <div className="sb2-dim">引擎加载中…（无关键干系人或引擎不可用时无法推演）</div>}
                {wiBase && (
                  <>
                    <div className="wi-hint">调任意人的立场 / 可信度假设 → 推演赢面变化。纯沙盘：不写库不改分，建议动作以实际局面为准。</div>
                    {wiBase.stakeholders.map((s: any) => {
                      const r = wiRows[s.id];
                      if (!r) return null;
                      const changed = r.sentiment !== s.sentiment || r.confidence !== s.confidence;
                      return (
                        <div className={`wi-row${changed ? ' changed' : ''}`} key={s.id}>
                          <span className="wi-name" title={s.name}>{s.name}</span>
                          <select value={r.sentiment} onChange={(e) => setWiRows({ ...wiRows, [s.id]: { ...r, sentiment: e.target.value } })}>
                            {(Object.keys(SENT_TEXT) as Sentiment[]).map((k) => <option key={k} value={k}>{SENT_TEXT[k]}</option>)}
                          </select>
                          <select value={r.confidence} onChange={(e) => setWiRows({ ...wiRows, [s.id]: { ...r, confidence: e.target.value } })}>
                            {['共识', '明确', '推理', '不清'].map((cnf) => <option key={cnf} value={cnf}>{cnf}</option>)}
                          </select>
                        </div>
                      );
                    })}
                    <div className="sb2-drawer-acts wi-acts">
                      <button className="btn primary sm" disabled={wiBusy || wiChanged.length === 0} title={wiChanged.length ? '' : '先调整至少一人的假设'}
                        onClick={runWhatIf}>{wiBusy ? '推演中…' : `🧪 推演（改 ${wiChanged.length} 人）`}</button>
                      <button className="btn ghost sm" onClick={resetWhatIf}>重置</button>
                    </div>
                    {wiResult && (
                      <div className="wi-result">
                        <div className="wi-pwin">
                          赢面 {Math.round(wiResult.base.pwin * 100)}% → <b>{Math.round(wiResult.hypo.pwin * 100)}%</b>
                          <span className={`wi-delta ${wiResult.dPwin > 0 ? 'up' : wiResult.dPwin < 0 ? 'down' : ''}`}>
                            {wiResult.dPwin > 0 ? '↑' : wiResult.dPwin < 0 ? '↓' : '—'}{Math.abs(Math.round(wiResult.dPwin * 100))}pp
                          </span>
                        </div>
                        {wiResult.base.gate !== wiResult.hypo.gate && (
                          <div className="wi-gate">{wiResult.hypo.gate ? '⚠ 该假设会触发把关人红线（赢面被强制压制）' : '✓ 该假设解除了把关人红线'}</div>
                        )}
                        {wiResult.base.ev_continue != null && wiResult.hypo.ev_continue != null && (
                          <div className="wi-ev">预期回报 {wiResult.base.ev_continue} → {wiResult.hypo.ev_continue} 万</div>
                        )}
                        <div className="sb2-origin">沙盘结果不落库。要坐实假设，去实际拜访拿证据，回来更新支持度。</div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
