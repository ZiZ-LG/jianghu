// 推演坞 · 关系地图底部可上拉的策略推演区（在策略沙盘逻辑上增量改造，作为地图的纯增量）。
// 第6刀旁支退役后坞真三层：坞头（PDE 徽章=唯一赢面出口 + 741 药丸 + 警示区：🔔机器背离黄条 · ⚠人工雷红条）/ 四列流水线 / 坞底对话。
// 风险砍容器降级红条（无 severity 分档、无管理窗口——坞头空间即数量约束）；假设/弹药 UI 全退、存量留库（Action 契约零改动）。
// 三档高度：收起(仅坞头+警示区) / 展开 / 全展开(四列更高)；画布始终在上方可见。
// 画布↔坞双向联动：selectedPersonId 高亮挂靠该人的策略卡；点策略卡 → onSelectPerson 回高亮画布目标。
// 老 PDE 适配层（lib/pde）在坞内只剩两职能：列① 姿态解读一句 + E2 背离提案（EngineBar 已退役，EV/赢面老口径废弃）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Opportunity, Sentiment, StrategyCard } from '../types';
import type { Action } from '../store';
import { newStrategyCard, newStrategyRisk, newPlanAction, newMilestone, newEvidence } from '../store';
import type { ScoreBreakdown, ItemKey, Band741 } from '../lib/g64111';
import { ITEM_MAX, ITEM_LABEL, ITEM_GROUP, BAND_LABEL, BAND_STRATEGY } from '../lib/g64111';
import { analyzeDeal } from '../lib/pde';
import { ChatPanel } from './ChatPanel';
import { usePersistentState } from '../ui';
import { api, type PatrolInfo } from '../api';
import { EnginePulse } from './EnginePulse';
import {
  aiOperationIdentityKey,
  aiRequestScopeKey,
  createAiOperationIdentity,
  createAiRequestScope,
  DEFAULT_AI_CONTEXT_OPTIONS,
  isAiOperationCurrent,
  isAiRequestScopeCurrent,
  type AiContextOptions,
  type AiOperationIdentity,
  type AiRequestScope,
  type ContextManifest,
} from '../aiContext';
import { ACT_LABEL } from '../lib/pdeUi';
import { AiContextDisclosure } from './AiContextDisclosure';
import {
  actionCompletionBusinessDates,
  addBusinessDaysYmd,
  deliberationBusinessYmd,
  isBusinessActionOverdue,
} from '../lib/deliberationDates';

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
const todayYmd = () => deliberationBusinessYmd();
const addDaysYmd = (n: number, baseYmd = todayYmd()) => addBusinessDaysYmd(baseYmd, n);
const mmdd = (ymd: string) => (ymd && ymd.length >= 10 ? `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}` : '未定');

interface FwdCand { gapItem: string; title: string; basis: string; }
interface BwdCand { title: string; offsetDays: number; why?: string; } // why=排期依据（P4：倒推候选标注依据）
type DrawerState = null | { kind: 'card'; id: string } | { kind: 'milestone'; id: string } | { kind: 'goal' } | { kind: 'action'; id: string } | { kind: 'whatif' } | { kind: 'engine' };
type DockHeight = 'collapsed' | 'half' | 'full';
// 第3刀：AI 可预填的行动四要素（title/personId 由策略卡携带，不在此列）
type AiFieldKey = 'target' | 'resources' | 'cautions' | 'props';
type Prefill = Record<AiFieldKey, string>;
type PrefillResult = { current: true; prefill: Prefill | null } | { current: false };
type ActionDraft = { title: string; startDate: string; personId?: string; target: string; resources: string; cautions: string; props: string; done: boolean; wasDone: boolean; outcome?: 'up' | 'flat' | 'down' };
type OperationRevision = { baseKey: string; nonce: number };

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
  account, opp, breakdown, dispatch, patrol, pdeFull, openEngineSignal, selectedPersonId, onSelectPerson, openActionId, onActionOpened, onChatDone,
}: {
  account: Account;
  opp: Opportunity;
  breakdown: ScoreBreakdown;
  dispatch: (a: Action) => void;
  patrol?: PatrolInfo | null; // P2 引擎心跳（坞头一行，collapsed 也可见）
  pdeFull?: any; // 第7刀：PDE 完整评估由 App 层一次 fetch 下发（左栏加权分共用），坞不再自拉
  openEngineSignal?: number; // 第8刀：左栏徽章点击 → 开「引擎详解」抽屉（counter 信号，照 openActionId 模式）
  selectedPersonId?: string | null;
  onSelectPerson?: (id: string | null) => void;
  openActionId?: string | null; // 点画布行动牌 → 打开该行动的编辑抽屉
  onActionOpened?: () => void;
  onChatDone?: () => void; // 坞尾「和地图对话」落库后刷新（第1刀：对话从左栏收进坞，一处入口）
}) {
  const itemKeys = Object.keys(ITEM_MAX) as ItemKey[];
  const personById = new Map(account.persons.map((p) => [p.id, p]));
  const [height, setHeight] = usePersistentState<DockHeight>('jianghu.dockHeight', 'half');
  const [chatOpen, setChatOpen] = usePersistentState('jianghu.dockChatOpen', false); // 第7刀：对话默认单行，点开才展开
  const [contextOptions, setContextOptions] = useState<AiContextOptions>(DEFAULT_AI_CONTEXT_OPTIONS);
  const [contextManifest, setContextManifest] = useState<ContextManifest | null>(null);
  const [contextManifestToken, setContextManifestToken] = useState('');
  const [contextManifestError, setContextManifestError] = useState('');
  const [contextManifestLoading, setContextManifestLoading] = useState(false);
  const [contextManifestRevision, setContextManifestRevision] = useState(0);
  const currentAiRequestScopeRef = useRef<AiRequestScope | null>(null);
  const cardOperationRevisionsRef = useRef(new Map<string, OperationRevision>());
  const milestoneOperationRevisionsRef = useRef(new Map<string, OperationRevision>());
  const currentDrawerOperationRef = useRef<AiOperationIdentity | null>(null);
  const drawerOperationBaseKeyRef = useRef('__closed__');
  const drawerOperationNonceRef = useRef(0);
  const drawerRef = useRef<DrawerState>(null);
  const actDraftRef = useRef<ActionDraft | null>(null);
  const actDraftActionIdRef = useRef<string | null>(null);
  const prefillBusyOperationRef = useRef<AiOperationIdentity | null>(null);
  const msBusyOperationRef = useRef<AiOperationIdentity | null>(null);
  const renderAiRequestScope = createAiRequestScope({
    accountId: account.id,
    opportunityId: opp.id,
    manifestToken: contextManifestToken,
    options: contextOptions,
    generation: 0,
  });
  if (!currentAiRequestScopeRef.current
    || aiRequestScopeKey(currentAiRequestScopeRef.current) !== aiRequestScopeKey(renderAiRequestScope)) {
    renderAiRequestScope.generation = (currentAiRequestScopeRef.current?.generation ?? 0) + 1;
    currentAiRequestScopeRef.current = renderAiRequestScope;
  }
  const requestIsCurrent = (requestScope: AiRequestScope) =>
    !!currentAiRequestScopeRef.current && isAiRequestScopeCurrent(requestScope, currentAiRequestScopeRef.current);
  useEffect(() => {
    let alive = true;
    setContextManifest(null);
    setContextManifestToken('');
    setContextManifestError('');
    setContextManifestLoading(true);
    api.aiContextManifest(opp.id, contextOptions)
      .then((result) => { if (alive) { setContextManifest(result.manifest); setContextManifestToken(result.manifestToken); } })
      .catch((error: any) => { if (alive) setContextManifestError(error?.message || '无法确认数据范围'); })
      .finally(() => { if (alive) setContextManifestLoading(false); });
    return () => { alive = false; };
  }, [opp.id, contextOptions, contextManifestRevision]);
  const contextReady = !!contextManifest && !!contextManifestToken && !contextManifestLoading;
  const refreshContextManifestAfterScopeChange = (error: any) => {
    if (error?.status === 409) setContextManifestRevision((revision) => revision + 1);
  };

  // 第8刀：四动作徽章收编左栏（坞头药丸/徽章退役——坞全宽后列①在左栏正下方，局势信息一处不重复）。
  // pdeFull 仍由 App 下发（引擎详解抽屉/gate 红条用）；左栏徽章点击经 openEngineSignal 开抽屉。

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

  // 引擎详解抽屉的赢面走势：打开抽屉才懒拉（第7刀：📸 手动打点已砍——审证据/推阶段自动落快照，走势自己生长）
  const [snaps, setSnaps] = useState<any[] | null>(null);

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
  const cardsRef = useRef(cards);
  const milestonesRef = useRef(milestones);
  cardsRef.current = cards;
  milestonesRef.current = milestones;

  const cardOperationBase = (card: StrategyCard) => createAiOperationIdentity({
    kind: 'card-dispatch', targetId: card.id, personId: card.personId,
    inputs: [card.title, card.basis, card.gapItem, card.status], nonce: 0,
  });
  const milestoneOperationBase = (milestone: (typeof milestones)[number]) => createAiOperationIdentity({
    kind: 'milestone-plan', targetId: milestone.id,
    inputs: [milestone.title, milestone.startDate, milestone.endDate], nonce: 0,
  });
  const liveCardIds = new Set(cards.map((card) => card.id));
  for (const card of cards) {
    const baseKey = aiOperationIdentityKey(cardOperationBase(card));
    const previous = cardOperationRevisionsRef.current.get(card.id);
    if (!previous || previous.baseKey !== baseKey) {
      cardOperationRevisionsRef.current.set(card.id, { baseKey, nonce: (previous?.nonce ?? 0) + 1 });
    }
  }
  for (const [cardId, revision] of cardOperationRevisionsRef.current) {
    if (!liveCardIds.has(cardId) && revision.baseKey !== '__missing__') {
      cardOperationRevisionsRef.current.set(cardId, { baseKey: '__missing__', nonce: revision.nonce + 1 });
    }
  }
  const liveMilestoneIds = new Set(milestones.map((milestone) => milestone.id));
  for (const milestone of milestones) {
    const baseKey = aiOperationIdentityKey(milestoneOperationBase(milestone));
    const previous = milestoneOperationRevisionsRef.current.get(milestone.id);
    if (!previous || previous.baseKey !== baseKey) {
      milestoneOperationRevisionsRef.current.set(milestone.id, { baseKey, nonce: (previous?.nonce ?? 0) + 1 });
    }
  }
  for (const [milestoneId, revision] of milestoneOperationRevisionsRef.current) {
    if (!liveMilestoneIds.has(milestoneId) && revision.baseKey !== '__missing__') {
      milestoneOperationRevisionsRef.current.set(milestoneId, { baseKey: '__missing__', nonce: revision.nonce + 1 });
    }
  }
  const currentCardOperation = (cardId: string): AiOperationIdentity | null => {
    const card = cardsRef.current.find((candidate) => candidate.id === cardId && candidate.status !== 'dismissed');
    const revision = cardOperationRevisionsRef.current.get(cardId);
    if (!card || !revision || revision.baseKey !== aiOperationIdentityKey(cardOperationBase(card))) return null;
    return { ...cardOperationBase(card), nonce: revision.nonce };
  };
  const currentMilestoneOperation = (milestoneId: string): AiOperationIdentity | null => {
    const milestone = milestonesRef.current.find((candidate) => candidate.id === milestoneId);
    const revision = milestoneOperationRevisionsRef.current.get(milestoneId);
    if (!milestone || !revision || revision.baseKey !== aiOperationIdentityKey(milestoneOperationBase(milestone))) return null;
    return { ...milestoneOperationBase(milestone), nonce: revision.nonce };
  };
  const currentDrawerOperation = (): AiOperationIdentity | null => currentDrawerOperationRef.current;
  const operationIsCurrent = (requestOperation: AiOperationIdentity): boolean => {
    const current = requestOperation.kind === 'card-dispatch'
      ? currentCardOperation(requestOperation.targetId)
      : requestOperation.kind === 'milestone-plan'
        ? currentMilestoneOperation(requestOperation.targetId)
        : currentDrawerOperation();
    return isAiOperationCurrent(requestOperation, current);
  };
  const invalidateCardOperation = (cardId: string) => {
    const previous = cardOperationRevisionsRef.current.get(cardId);
    cardOperationRevisionsRef.current.set(cardId, { baseKey: '__invalidated__', nonce: (previous?.nonce ?? 0) + 1 });
  };
  const invalidateMilestoneOperation = (milestoneId: string) => {
    const previous = milestoneOperationRevisionsRef.current.get(milestoneId);
    milestoneOperationRevisionsRef.current.set(milestoneId, { baseKey: '__invalidated__', nonce: (previous?.nonce ?? 0) + 1 });
  };

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
  const updateCard = (cardId: string, patch: Partial<StrategyCard>) => {
    invalidateCardOperation(cardId);
    dispatch({ type: 'UPDATE_STRATEGY_CARD', accId: account.id, cardId, patch });
  };
  const deleteCard = (cardId: string) => { invalidateCardOperation(cardId); dispatch({ type: 'DELETE_STRATEGY_CARD', accId: account.id, cardId }); setDrawer(null); };

  // ── 派发：策略卡 → 行动牌（第3刀：AI 预填四要素初稿 → 落草稿 origin=ai → 开抽屉人微调，人保存才定稿守铁律②）──
  // aiMark = 字段来源前端态（🤖AI建议/✍️手改，不落库）；prefillBusy = 预填中的 cardId 或 'drawer'（抽屉内补全）
  const [aiMark, setAiMark] = useState<{ actionId: string; fields: Partial<Record<AiFieldKey, 'ai' | 'edited'>> } | null>(null);
  const [prefillBusy, setPrefillBusy] = useState<string | null>(null);
  const fetchPrefill = async (
    card: { title?: string; basis?: string; gapItem?: string },
    personId: string | undefined,
    requestScope: AiRequestScope,
  ): Promise<PrefillResult> => {
    if (!contextReady || !requestIsCurrent(requestScope)) return { current: false };
    try {
      const r = await api.strategyPrefill(
        requestScope.opportunityId, card, personId, requestScope.options, requestScope.manifestToken,
      );
      if (!requestIsCurrent(requestScope)) return { current: false };
      return { current: true, prefill: r.prefill };
    } catch (error: any) {
      if (!requestIsCurrent(requestScope)) return { current: false };
      refreshContextManifestAfterScopeChange(error);
      return error?.status === 409 ? { current: false } : { current: true, prefill: null };
    } // 普通预填失败降级：无初稿开抽屉手填；409 必须重新核对范围
  };
  const dispatchToPlanner = async (card: StrategyCard) => {
    if (prefillBusy || !contextReady) return;
    const requestScope = currentAiRequestScopeRef.current!;
    const requestOperation = currentCardOperation(card.id);
    if (!requestOperation) return;
    const requestCard = cardsRef.current.find((candidate) => candidate.id === card.id)!;
    prefillBusyOperationRef.current = requestOperation;
    setPrefillBusy(card.id);
    const result = await fetchPrefill(
      { title: requestCard.title, basis: requestCard.basis, gapItem: requestCard.gapItem },
      requestCard.personId, requestScope,
    );
    if (!result.current || !requestIsCurrent(requestScope) || !operationIsCurrent(requestOperation)) return;
    const currentCard = cardsRef.current.find((candidate) => candidate.id === requestOperation.targetId && candidate.status !== 'dismissed');
    if (!currentCard) return;
    if (isAiOperationCurrent(requestOperation, prefillBusyOperationRef.current)) prefillBusyOperationRef.current = null;
    setPrefillBusy(null);
    const pf = result.prefill;
    const d0 = todayYmd();
    const pa = newPlanAction(requestScope.accountId, requestScope.opportunityId, d0, d0, 'am');
    pa.title = currentCard.title;
    pa.gapItem = currentCard.gapItem || '';
    if (currentCard.personId) pa.personId = currentCard.personId;
    if (currentCard.basis) pa.scene = currentCard.basis;
    pa.origin = 'ai';
    pa.draft = true; // 第4刀：派发产物=坞内草稿，人微调后「→ 上桌」才挂画布
    if (pf) { pa.target = pf.target; pa.resources = pf.resources; pa.cautions = pf.cautions; pa.props = pf.props; }
    dispatch({ type: 'ADD_PLAN_ACTION', accId: requestScope.accountId, oppId: requestScope.opportunityId, planAction: pa });
    updateCard(currentCard.id, { dispatchedActionIds: [...(currentCard.dispatchedActionIds ?? []), pa.id] });
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
  const updateMilestone = (milestoneId: string, patch: { title?: string; startDate?: string; endDate?: string }) => {
    invalidateMilestoneOperation(milestoneId);
    dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId, patch });
  };
  const deleteMilestone = (milestoneId: string) => { invalidateMilestoneOperation(milestoneId); dispatch({ type: 'DELETE_MILESTONE', accId: account.id, milestoneId }); setDrawer(null); };

  // ── P6 里程碑「→ 排行动」（列③→④焊缝）：AI 拆 2-3 个行动候选 → 各落一张 draft 草稿（origin=ai）进列④人审，
  // endDate 锚定里程碑日（最晚完成）、startDate=里程碑前一周（不早于今天）。msArranged=会话级「✓ 已排 N」反馈。──
  const [msBusy, setMsBusy] = useState<string | null>(null);
  const [msArranged, setMsArranged] = useState<Record<string, number>>({});
  const planFromMilestone = async (ms: { id: string; title: string; startDate?: string }) => {
    if (msBusy || !contextReady) return;
    const requestScope = currentAiRequestScopeRef.current!;
    const requestOperation = currentMilestoneOperation(ms.id);
    if (!requestOperation) return;
    const requestMilestone = milestonesRef.current.find((candidate) => candidate.id === ms.id)!;
    msBusyOperationRef.current = requestOperation;
    setMsBusy(ms.id);
    try {
      const existing = planActions.map((a) => a.title).filter(Boolean);
      const r = await api.milestoneActions(
        requestScope.opportunityId, { title: requestMilestone.title, date: requestMilestone.startDate || undefined },
        requestScope.options, requestScope.manifestToken, existing,
      );
      if (!requestIsCurrent(requestScope) || !operationIsCurrent(requestOperation)) return;
      const currentMilestone = milestonesRef.current.find((candidate) => candidate.id === requestOperation.targetId);
      if (!currentMilestone) return;
      const today = todayYmd();
      const msDate = currentMilestone.startDate && currentMilestone.startDate >= today ? currentMilestone.startDate : today; // 里程碑已过/未定 → 锚今天
      const start = addDaysYmd(-7, msDate) >= today ? addDaysYmd(-7, msDate) : today;
      let n = 0;
      for (const c of (r.candidates || []).slice(0, 3)) {
        const pa = newPlanAction(requestScope.accountId, requestScope.opportunityId, start, msDate, 'am');
        pa.title = c.title; pa.target = c.target; pa.cautions = c.cautions;
        pa.scene = `为达成里程碑「${currentMilestone.title}」${currentMilestone.startDate ? `（最晚 ${currentMilestone.startDate}）` : ''}`;
        pa.origin = 'ai'; pa.draft = true;
        dispatch({ type: 'ADD_PLAN_ACTION', accId: requestScope.accountId, oppId: requestScope.opportunityId, planAction: pa });
        n++;
      }
      if (n > 0) setMsArranged((m) => ({ ...m, [currentMilestone.id]: (m[currentMilestone.id] ?? 0) + n }));
      else setAiErr(`「${currentMilestone.title}」的标准动作已在行动列，没有新的可排`); // existingTitles 防重后空产出
    } catch (e: any) {
      if (!requestIsCurrent(requestScope) || !operationIsCurrent(requestOperation)) return;
      refreshContextManifestAfterScopeChange(e);
      setAiErr(e?.message || '排行动失败');
    } finally {
      if (requestIsCurrent(requestScope)
        && operationIsCurrent(requestOperation)
        && isAiOperationCurrent(requestOperation, msBusyOperationRef.current)) {
        msBusyOperationRef.current = null;
        setMsBusy(null);
      }
    }
  };

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
  const fwdCandidateScopeRef = useRef<AiRequestScope | null>(null);
  const bwdCandidateScopeRef = useRef<AiRequestScope | null>(null);
  const visibleFwdCands = fwdCandidateScopeRef.current && requestIsCurrent(fwdCandidateScopeRef.current) ? fwdCands : [];
  const visibleBwdCands = bwdCandidateScopeRef.current && requestIsCurrent(bwdCandidateScopeRef.current) ? bwdCands : [];

  useEffect(() => {
    setFwdCands([]); setBwdCands([]);
    fwdCandidateScopeRef.current = null; bwdCandidateScopeRef.current = null;
    prefillBusyOperationRef.current = null; msBusyOperationRef.current = null;
    setAiBusy(null); setAiErr(''); setMsBusy(null); setMsArranged({}); setPrefillBusy(null);
  }, [account.id, opp.id, contextManifestToken, contextOptions.includeRawLogs, contextOptions.includeForm]);

  const col2Ref = useRef<HTMLDivElement>(null); // P0：顺推出候选后滚回列②顶部（候选置顶渲染，保证在视野内）
  const runSuggest = async (mode: 'forward' | 'backward') => {
    if (aiBusy || !contextReady) return;
    const requestScope = currentAiRequestScopeRef.current!;
    setAiBusy(mode); setAiErr('');
    try {
      const r = await api.strategySuggest(requestScope.opportunityId, mode, requestScope.options, requestScope.manifestToken);
      if (!requestIsCurrent(requestScope)) return;
      if (mode === 'forward') {
        fwdCandidateScopeRef.current = requestScope;
        setFwdCands(() => requestIsCurrent(requestScope) ? (r.candidates || []) : []);
        requestAnimationFrame(() => { if (requestIsCurrent(requestScope) && col2Ref.current) col2Ref.current.scrollTop = 0; });
      } else {
        bwdCandidateScopeRef.current = requestScope;
        setBwdCands(() => requestIsCurrent(requestScope) ? (r.candidates || []) : []);
      }
    } catch (e: any) {
      if (!requestIsCurrent(requestScope)) return;
      refreshContextManifestAfterScopeChange(e);
      setAiErr(e?.message || 'AI 推演失败');
    } finally { if (requestIsCurrent(requestScope)) setAiBusy(null); }
  };
  const acceptFwd = (i: number) => {
    if (!fwdCandidateScopeRef.current || !requestIsCurrent(fwdCandidateScopeRef.current)) { setFwdCands([]); fwdCandidateScopeRef.current = null; return; }
    const c = visibleFwdCands[i]; if (!c) return;
    const card = newStrategyCard(account.id, opp.id, c.gapItem || '');
    card.title = c.title; card.basis = c.basis; card.origin = 'ai'; card.orderIndex = cards.length;
    dispatch({ type: 'ADD_STRATEGY_CARD', accId: account.id, oppId: opp.id, card });
    setFwdCands((xs) => xs.filter((_, j) => j !== i));
  };
  const acceptBwd = (i: number) => {
    if (!bwdCandidateScopeRef.current || !requestIsCurrent(bwdCandidateScopeRef.current)) { setBwdCands([]); bwdCandidateScopeRef.current = null; return; }
    const c = visibleBwdCands[i]; if (!c) return;
    const ms = newMilestone(account.id, opp.id, addDaysYmd(c.offsetDays), 'am');
    ms.title = c.title;
    dispatch({ type: 'ADD_MILESTONE', accId: account.id, oppId: opp.id, milestone: ms });
    setBwdCands((xs) => xs.filter((_, j) => j !== i));
  };

  // ── 视图状态：详情抽屉 ──
  const [drawer, setDrawerState] = useState<DrawerState>(null);
  drawerRef.current = drawer;
  const setDrawer = (next: DrawerState) => {
    const previousKey = JSON.stringify(drawerRef.current);
    const nextKey = JSON.stringify(next);
    if (previousKey !== nextKey) {
      drawerOperationNonceRef.current += 1;
      drawerOperationBaseKeyRef.current = '__invalidated__';
      currentDrawerOperationRef.current = null;
    }
    drawerRef.current = next;
    setDrawerState(next);
  };
  useEffect(() => {
    // Esc 关抽屉前先 blur：抽屉字段走 defaultValue+onBlur 保存，直接卸载会丢正在输入的值（P4③ 空卡治理会误删刚起名的卡）
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { (document.activeElement as HTMLElement | null)?.blur?.(); setDrawer(null); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // P4③ 误操作治理：从「＋/缺口＋」进来开了抽屉又直接关掉（点空白/Esc/✕/切别的卡）→ 留下的空卡自动删除。
  // 挂在 drawer 变化上统一拦截所有关闭路径；正常删除路径下卡已不在列表，find 不到自然跳过。
  const prevDrawer = useRef<DrawerState>(null);
  useEffect(() => {
    const prev = prevDrawer.current;
    prevDrawer.current = drawer;
    if (!prev || (drawer && drawer.kind === prev.kind && (drawer as any).id === (prev as any).id)) return;
    if (prev.kind === 'card') {
      const c = cards.find((x) => x.id === prev.id);
      if (c && !c.title.trim() && !(c.basis ?? '').trim()) dispatch({ type: 'DELETE_STRATEGY_CARD', accId: account.id, cardId: c.id });
    } else if (prev.kind === 'milestone') {
      const m = milestones.find((x) => x.id === prev.id);
      if (m && !m.title.trim()) dispatch({ type: 'DELETE_MILESTONE', accId: account.id, milestoneId: m.id });
    } else if (prev.kind === 'action') {
      const a = planActions.find((x) => x.id === prev.id);
      if (a && a.draft && !a.title.trim() && !(a.target ?? '').trim()) dispatch({ type: 'DELETE_PLAN_ACTION', accId: account.id, actionId: a.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);
  // 切商机/客户 → 关抽屉、清背离忽略集、丢未落库的雷草稿、清字段来源标记、清引擎候选忽略集
  useEffect(() => { setDrawer(null); setDismissedShifts(new Set()); setRiskDraft(null); setAiMark(null); setDismissedActs(new Set()); }, [opp.id, account.id]);

  // 引擎详解抽屉打开时才懒拉走势快照（同商机会话内缓存，切商机由下方 useEffect 清）
  useEffect(() => {
    if (drawer?.kind !== 'engine' || snaps !== null) return;
    let alive = true;
    api.pdeSnapshots(opp.id).then((r) => { if (alive) setSnaps(r.snapshots ?? []); }).catch(() => { if (alive) setSnaps([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);
  useEffect(() => { setSnaps(null); }, [opp.id]);

  // ── what-if 假设推演（引擎详解的子抽屉 · SPEC §7）：沙盘不落库，关抽屉即散；假设=此刻新情报（服务端 age 归零）──
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
  const [actDraft, setActDraftState] = useState<ActionDraft | null>(null);
  actDraftRef.current = actDraft;
  const setActDraft = (next: ActionDraft | null) => {
    actDraftRef.current = next;
    setActDraftState(next);
  };
  const editActDraft = (next: ActionDraft) => {
    drawerOperationNonceRef.current += 1;
    drawerOperationBaseKeyRef.current = '__invalidated__';
    currentDrawerOperationRef.current = null;
    setActDraft(next);
  };
  useEffect(() => {
    if (drawer?.kind === 'action') {
      const a = (account.planActions ?? []).find((x) => x.id === drawer.id);
      if (a) {
        actDraftActionIdRef.current = drawer.id;
        setActDraft({ title: a.title || '', startDate: a.startDate || todayYmd(), personId: a.personId, target: a.target || '', resources: a.resources || '', cautions: a.cautions || '', props: a.props || '', done: !!a.done, wasDone: !!a.done });
        // 来源标记按库值校准：补全后未保存就关抽屉的字段（库里为空）清掉标记，避免重开误标 🤖
        setAiMark((m) => {
          if (!m || m.actionId !== drawer.id) return m;
          const fields = { ...m.fields };
          (['target', 'resources', 'cautions', 'props'] as AiFieldKey[]).forEach((k) => { if (!a[k]) delete fields[k]; });
          return { ...m, fields };
        });
      }
    } else { actDraftActionIdRef.current = null; setActDraft(null); }
    // 仅在切换抽屉对象时初始化草稿；编辑中不因 store 更新而重置（避免清掉未保存输入）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);
  const drawerPlanAction = drawer?.kind === 'action'
    ? planActions.find((candidate) => candidate.id === drawer.id)
    : undefined;
  const drawerOperationBase = drawer?.kind === 'action'
    && actDraft
    && actDraftActionIdRef.current === drawer.id
    && drawerPlanAction
    ? createAiOperationIdentity({
      kind: 'drawer-prefill', targetId: drawer.id, personId: actDraft.personId,
      inputs: [
        actDraft.title, actDraft.startDate, actDraft.target, actDraft.resources, actDraft.cautions, actDraft.props,
        actDraft.done, actDraft.outcome, drawerPlanAction.scene, drawerPlanAction.gapItem,
      ],
      nonce: 0,
    })
    : null;
  if (!drawerOperationBase) {
    currentDrawerOperationRef.current = null;
  } else {
    const baseKey = aiOperationIdentityKey(drawerOperationBase);
    if (drawerOperationBaseKeyRef.current !== baseKey) {
      drawerOperationNonceRef.current += 1;
      drawerOperationBaseKeyRef.current = baseKey;
    }
    currentDrawerOperationRef.current = { ...drawerOperationBase, nonce: drawerOperationNonceRef.current };
  }
  useEffect(() => {
    const prefillOperation = prefillBusyOperationRef.current;
    if (prefillOperation && !operationIsCurrent(prefillOperation)) {
      prefillBusyOperationRef.current = null;
      setPrefillBusy(null);
    }
    const milestoneOperation = msBusyOperationRef.current;
    if (milestoneOperation && !operationIsCurrent(milestoneOperation)) {
      msBusyOperationRef.current = null;
      setMsBusy(null);
    }
  });
  // 点画布行动牌 → 展开坞 + 打开该行动编辑抽屉
  useEffect(() => {
    if (openActionId) { setHeight('half'); setDrawer({ kind: 'action', id: openActionId }); onActionOpened?.(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openActionId]);
  // 第8刀：左栏徽章点击 → 展开坞 + 开「引擎详解」抽屉
  useEffect(() => {
    if (openEngineSignal) { if (height === 'collapsed') setHeight('half'); setDrawer({ kind: 'engine' }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openEngineSignal]);
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
    const d = actDraft;
    const { doneAt, evidenceOccurredAt } = actionCompletionBusinessDates();
    const title = d.title.trim() || '新行动';
    dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId, patch: { title, startDate: d.startDate, endDate: d.startDate, personId: d.personId, target: d.target, resources: d.resources, cautions: d.cautions, props: d.props, done: d.done, doneAt: d.done ? doneAt : undefined, ...(andStage ? { draft: false } : {}) } });
    // 结果回填：完成且关联干系人、选了态度变化 → 录一条互动证据喂策略引擎 E2（守铁律②：人当场拍板，非机器自动改分）
    if (d.done && !d.wasDone && d.personId && (d.outcome === 'up' || d.outcome === 'down')) {
      const ev = newEvidence(account.id, opp.id, d.personId, d.outcome === 'up' ? 'positive_interaction' : 'negative_interaction', d.outcome === 'up' ? 1 : -1, 'mid');
      ev.rawContent = `行动结果回填：${title}`; ev.occurredAt = evidenceOccurredAt;
      dispatch({ type: 'ADD_EVIDENCE', accId: account.id, oppId: opp.id, evidence: ev });
    }
    setDrawer(null);
  };

  // ── 第3刀：抽屉内「✨ 让引擎补全」——只补空白要素不覆盖已填（human-wins）；字段来源徽章 helpers ──
  const runDrawerPrefill = async () => {
    if (prefillBusy || !actDraft || drawer?.kind !== 'action' || !contextReady) return;
    const requestScope = currentAiRequestScopeRef.current!;
    const requestOperation = currentDrawerOperation();
    if (!requestOperation) return;
    const actionId = requestOperation.targetId;
    const requestDraft = actDraftRef.current!;
    const requestAction = planActions.find((candidate) => candidate.id === actionId);
    if (!requestAction) return;
    prefillBusyOperationRef.current = requestOperation;
    setPrefillBusy('drawer');
    const result = await fetchPrefill(
      { title: requestDraft.title, basis: requestAction.scene, gapItem: requestAction.gapItem },
      requestDraft.personId, requestScope,
    );
    if (!result.current || !requestIsCurrent(requestScope) || !operationIsCurrent(requestOperation)) return;
    const currentDraft = actDraftRef.current;
    if (!currentDraft || drawerRef.current?.kind !== 'action' || drawerRef.current.id !== actionId) return;
    if (isAiOperationCurrent(requestOperation, prefillBusyOperationRef.current)) prefillBusyOperationRef.current = null;
    setPrefillBusy(null);
    const pf = result.prefill;
    if (!pf) return;
    const next = { ...currentDraft };
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
    ...visibleBwdCands.map((c, i) => ({ t: 'cand' as const, date: addDaysYmd(c.offsetDays), c, i })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  const drawerCard = drawer?.kind === 'card' ? cards.find((c) => c.id === drawer.id) : null;
  const drawerMs = drawer?.kind === 'milestone' ? milestones.find((m) => m.id === drawer.id) : null;
  const focusName = selectedPersonId ? personById.get(selectedPersonId)?.name : null;

  return (
    <div className={`dock dock-${height}`} onClick={() => setDrawer(null)}>
      {/* ── 坞头：聚焦标识 + ⚠＋行内加雷 + 三档切换（第8刀收编局势信息；P4：抓手删除——与三档「收起」重复，雷输入行内展开不再另起一行）── */}
      <div className="dock-head" onClick={(e) => e.stopPropagation()}>
        <span className="dock-head-cap">♟️ 推演坞</span>
        <EnginePulse patrol={patrol} />
        {focusName && (
          <span className="dock-focus-chip">🎯 聚焦 {focusName}
            <button onClick={() => onSelectPerson?.(null)} title="清除聚焦">✕</button>
          </span>
        )}
        {riskDraft === null
          ? <button className="dock-risk-add" title="记一条雷（高危风险，常驻坞头示警）" onClick={() => setRiskDraft('')}>⚠＋</button>
          : <input className="dock-risk-inline" autoFocus value={riskDraft} placeholder="一句话记雷（回车落档 · Esc 放弃）"
              onChange={(e) => setRiskDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRisk(); else if (e.key === 'Escape') setRiskDraft(null); }}
              onBlur={commitRisk} />}
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

      {/* ── 坞头警示行 · gate 把关人红线（第7刀自复盘台迁入：机器强警示，触发才出现；与背离黄条/人工雷同族）── */}
      {pdeFull?.gate && (
        <div className="dock-gate" onClick={(e) => e.stopPropagation()}>
          ⚠ 把关人红线触发：关键把关人强烈反对，赢面被强制压制——先排雷再谈推进
        </div>
      )}

      {/* ── 坞头警示行 · 人工雷红条（第6刀：风险砍容器降级至此，与背离黄条同族并列；三档高度均可见）── */}
      {risks.map((r) => (
        <div className="dock-risk" key={r.id} onClick={(e) => e.stopPropagation()}>
          <span className="dock-risk-icon">⚠</span>
          <span className="dock-risk-text">{r.text || <span className="sb2-dim">（空雷 · 点 ✕ 排掉）</span>}</span>
          <button className="dock-risk-del" title="排雷（删除）" onClick={() => deleteRisk(r.id)}>✕</button>
        </div>
      ))}
      {height !== 'collapsed' && (
        <div className="dock-scroll">
          <div onClick={(event) => event.stopPropagation()}>
            <AiContextDisclosure
              manifest={contextManifest}
              options={contextOptions}
              onChange={setContextOptions}
              loading={contextManifestLoading}
              error={contextManifestError}
            />
          </div>
          {/* ── 第2刀：横向推导流水线 局势 → 策略 → 倒排 → 行动（列间箭头显因果；第6刀后旁支全退，雷在坞头红条）
               第9刀：抽屉打开时 drawer-open 让位——四列 minmax 下限触发横滚，被盖住的列可拖出来看 ── */}
          <div className={`sb2-cols${drawer ? ' drawer-open' : ''}`} onClick={(e) => e.stopPropagation()}>

          {/* 列① 局势（EngineBar 退役后唯一详情出口：band + 打法方向 + 姿态解读一句 + 全部缺口）*/}
          <div className="sb2-col">
            <div className="sb2-col-head"><span>① 局势</span></div>
            <div className="sb2-card sb2-anchor" style={{ borderColor: tone }}>
              {/* 第7刀：band 大字行删——坞头药丸就在头顶（三连显收敛为二：左栏本尊+收起态药丸） */}
              <div className="sb2-anchor-tag">现状锚 · 来自地图</div>
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
                      ? <button className="sb2-gap-cov" title="已有策略卡覆盖 · 点击打开那张卡"
                          onClick={() => { const c = cards.find((x) => x.gapItem === g.key); if (c) setDrawer({ kind: 'card', id: c.id }); }}>✓</button>
                      : <button className="sb2-gap-add" title="挂一张策略卡" onClick={() => addCard(g.key)}>＋</button>}
                  </div>
                ))}
                {gaps.length === 0 && <div className="sb2-gap-row sb2-dim">无明显缺口 🎉</div>}
              </div>
            </div>
          </div>

          <div className="sb2-arrow" title="局势推导出策略">→</div>

          {/* 列② 策略（正推：现状 → 方向） */}
          <div className="sb2-col" ref={col2Ref}>
            <div className="sb2-col-head">
              <span>② 策略 · 正推</span>
              <span className="sb2-lane-acts" onClick={(e) => e.stopPropagation()}>
                {aiErr && <span className="sb2-ai-err">{aiErr}</span>}
                <button className="btn ghost xs" onClick={() => addCard()}>＋</button>
                <button className="btn ghost xs" disabled={aiBusy === 'forward' || !contextReady} onClick={() => runSuggest('forward')}>{aiBusy === 'forward' ? '推演中…' : '✨ 顺推'}</button>
              </span>
            </div>
            {/* AI 顺推候选虚位卡（P0：置顶渲染——此前排在存量卡之后，列内容一长就出生在视野外=「点了没反应」；对齐列④引擎荐置顶惯例） */}
            {visibleFwdCands.map((c, i) => (
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
                      : <button className="sb2-send" disabled={!card.title || !!prefillBusy || !contextReady} title={card.title ? '生成行动（AI 预填四要素初稿，可微调）' : '先填打法标题'}
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

            {cards.length === 0 && visibleFwdCands.length === 0 && (
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
                <button className="btn ghost xs" disabled={aiBusy === 'backward' || !opp.expectedSignDate || !contextReady} title={opp.expectedSignDate ? '' : '先在终局锚设置预计签约日'}
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
                <div className="sb2-card-top" style={{ marginTop: 4 }}>
                  {msArranged[item.m.id]
                    ? <span className="sb2-dispatched">✓ 已排 {msArranged[item.m.id]} 张草稿（列④微调后上桌）</span>
                    : <button className="sb2-send" disabled={!item.m.title || !!msBusy || !contextReady} title={item.m.title ? 'AI 拆解达成该里程碑的 2-3 个行动，落草稿到行动列人审' : '先给里程碑起名'}
                        onClick={(e) => { e.stopPropagation(); planFromMilestone(item.m); }}>{msBusy === item.m.id ? '拆解中…' : '→ 排行动'}</button>}
                </div>
              </div>
            ) : (
              <div key={`bc${item.i}`} className="sb2-card sb2-cand">
                <div className="sb2-card-top">
                  <span className="sb2-card-title">{item.c.title}</span>
                  <span className="sb2-stamp">待采纳</span>
                </div>
                <div className="sb2-card-sub">AI 倒推 · 约 {item.c.offsetDays} 天后（{mmdd(item.date)}）{item.c.why && <><br />依据：{item.c.why}</>}</div>
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
              const overdue = isBusinessActionOverdue(a);
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

        </div>
      )}

      {/* ── 坞尾 · 和地图对话（第1刀收进坞；第7刀压成单行——对话是输入工具不是展示内容，常驻只留一行入口，点开才展开对话流）── */}
      {height !== 'collapsed' && (
        chatOpen ? (
          <div className="dock-chat" onClick={(e) => e.stopPropagation()}>
            <ChatPanel account={account} opp={opp} onDone={onChatDone ?? (() => {})} height={height === 'full' ? 200 : 150}
              onCollapse={() => setChatOpen(false)} />
          </div>
        ) : (
          <button className="dock-chat-line" onClick={(e) => { e.stopPropagation(); setChatOpen(true); }}>
            💬 和地图对话：说情报 / 改图 / 粘拜访口述…（落库 · 点击展开）
          </button>
        )
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
                    : <button className="btn primary sm" disabled={!drawerCard.title || !!prefillBusy || !contextReady} onClick={() => dispatchToPlanner(drawerCard)}>{prefillBusy === drawerCard.id ? '✨ 预填中…' : '📤 送行动策划'}</button>}
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
                  <input value={actDraft.title} placeholder="如：拜访钱大钧 · 摸招标参数" onChange={(e) => editActDraft({ ...actDraft, title: e.target.value })} />
                </label>
                <label className="sb-field"><span>日期</span>
                  <input type="date" value={actDraft.startDate} onChange={(e) => editActDraft({ ...actDraft, startDate: e.target.value })} />
                </label>
                <label className="sb-field"><span>目标干系人</span>
                  <select value={actDraft.personId || ''} onChange={(e) => editActDraft({ ...actDraft, personId: e.target.value || undefined })}>
                    <option value="">（可选 · 关联后可回填态度）</option>
                    {account.persons.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}
                  </select>
                </label>
                <div className="sb2-prefill-row">
                  <button className="btn ghost xs" disabled={!!prefillBusy || !contextReady} onClick={runDrawerPrefill}>{prefillBusy === 'drawer' ? '✨ 补全中…' : '✨ 让引擎补全'}</button>
                  <span className="sb2-prefill-hint">只补空白要素，不覆盖已填</span>
                </div>
                <label className="sb-field"><span>目的{srcBadge('target')}</span>
                  <input value={actDraft.target} placeholder="这一手要达成什么" onChange={(e) => { markEdited('target'); editActDraft({ ...actDraft, target: e.target.value }); }} />
                </label>
                <label className="sb-field"><span>所需资源{srcBadge('resources')}</span>
                  <input value={actDraft.resources} placeholder="人 / 预算 / 内部支持…" onChange={(e) => { markEdited('resources'); editActDraft({ ...actDraft, resources: e.target.value }); }} />
                </label>
                <label className="sb-field"><span>注意要点{srcBadge('cautions')}</span>
                  <input value={actDraft.cautions} placeholder="风险 / 红线 / 话术提示" onChange={(e) => { markEdited('cautions'); editActDraft({ ...actDraft, cautions: e.target.value }); }} />
                </label>
                <label className="sb-field"><span>道具{srcBadge('props')}</span>
                  <input value={actDraft.props} placeholder="方案 / POC / 报告 / 会议大纲…（后续可交 WorkBuddy 生产）" onChange={(e) => { markEdited('props'); editActDraft({ ...actDraft, props: e.target.value }); }} />
                </label>
                <label className="dp-done"><input type="checkbox" checked={actDraft.done} onChange={(e) => editActDraft({ ...actDraft, done: e.target.checked })} /> 标记为已完成</label>
                {actDraft.done && !actDraft.wasDone && actDraft.personId && (
                  <div className="dp-outcome">
                    <span className="dp-outcome-q">这次接触后，{personById.get(actDraft.personId)?.name ?? '对方'}的态度：</span>
                    <div className="dp-pick">
                      <button className={actDraft.outcome === 'up' ? 'on up' : ''} onClick={() => editActDraft({ ...actDraft, outcome: 'up' })}>↑ 更积极</button>
                      <button className={actDraft.outcome === 'flat' ? 'on' : ''} onClick={() => editActDraft({ ...actDraft, outcome: 'flat' })}>— 没变化</button>
                      <button className={actDraft.outcome === 'down' ? 'on down' : ''} onClick={() => editActDraft({ ...actDraft, outcome: 'down' })}>↓ 更消极</button>
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
          {drawer.kind === 'engine' && pdeFull && (
            <>
              <div className="drawer-head">
                <span className="t">⚙️ 引擎详解 · 这个建议怎么来的</span>
                <button className="x-btn" onClick={() => setDrawer(null)}>✕</button>
              </div>
              <div className="sb2-drawer-body">
                {ACT_LABEL[pdeFull.recommendation?.action] && (
                  <div className="eng-verdict">
                    <span className={`mf-act mf-act-${ACT_LABEL[pdeFull.recommendation.action]!.cls}`}>
                      {ACT_LABEL[pdeFull.recommendation.action]!.icon} {ACT_LABEL[pdeFull.recommendation.action]!.text} · 赢面 {Math.round((pdeFull.pwin ?? 0) * 100)}%
                    </span>
                    {pdeFull.confidenceFlag && <span className="eng-flag">{pdeFull.confidenceFlag.includes('no_pot') ? '未设合同额，金额类降级为纯排序' : '置信偏低，建议先摸底再下重注'}</span>}
                  </div>
                )}
                <div className="eng-reason"><b>理由</b>{pdeFull.recommendation?.reason || '—'}</div>
                {(pdeFull.recommendation?.weak_key_stakeholders?.length ?? 0) > 0 && (
                  <div className="eng-reason"><b>薄弱关键人</b>{pdeFull.recommendation.weak_key_stakeholders.map((id: string) => pdeFull.stakeholders?.find((s: any) => s.id === id)?.name ?? id).join('、')}</div>
                )}
                <div className="eng-trend">
                  <h5>赢面走势</h5>
                  {(snaps?.length ?? 0) >= 2
                    ? <Sparkline snaps={snaps!} />
                    : <div className="sb2-origin">{snaps === null ? '加载中…' : '记录还不够连成线——审核证据、推进阶段时系统会自动记一笔，用一阵子就有了。'}</div>}
                </div>
                <div className="sb2-drawer-acts">
                  <button className="btn primary sm" onClick={() => setDrawer({ kind: 'whatif' })}>🧪 假设推演：搞定某人，赢面会怎样</button>
                </div>
                <div className="sb2-origin">名义 / 加权双轨分在左栏趋赢力处（加权＝按证据可信度折扣）。</div>
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
