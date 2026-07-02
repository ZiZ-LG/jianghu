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
type DrawerState = null | { kind: 'card'; id: string } | { kind: 'milestone'; id: string } | { kind: 'goal' } | { kind: 'action'; id: string };
type DockHeight = 'collapsed' | 'half' | 'full';

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
  const [pde, setPde] = useState<{ action: string; pwin: number; flag: string } | null>(null);
  useEffect(() => {
    let alive = true;
    api.pdeEv(opp.id)
      .then((r) => { if (alive) setPde({ action: r.recommendation?.action ?? '', pwin: r.pwin ?? 0, flag: r.confidenceFlag ?? '' }); })
      .catch(() => { if (alive) setPde(null); });
    return () => { alive = false; };
  }, [opp.id, breakdown]);

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

  // ── 派发：策略卡 → 行动策划（生成 PlanAction 快照，落行动计划时间轴）──
  const dispatchToPlanner = (card: StrategyCard) => {
    const d0 = todayYmd();
    const pa = newPlanAction(account.id, opp.id, d0, d0, 'am');
    pa.title = card.title;
    pa.gapItem = card.gapItem || '';
    if (card.personId) pa.personId = card.personId;
    if (card.basis) pa.scene = card.basis;
    pa.origin = 'ai';
    dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
    updateCard(card.id, { dispatchedActionIds: [...(card.dispatchedActionIds ?? []), pa.id] });
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
  // 切商机/客户 → 关抽屉、清背离忽略集、丢未落库的雷草稿
  useEffect(() => { setDrawer(null); setDismissedShifts(new Set()); setRiskDraft(null); }, [opp.id, account.id]);

  // ── 行动清单（PlanAction，承接 DealPlanner 网格退役；勾完成→结果回填录证据，闭合执行→证据→局势飞轮）──
  const [actDraft, setActDraft] = useState<{ title: string; startDate: string; personId?: string; target: string; resources: string; cautions: string; props: string; done: boolean; wasDone: boolean; outcome?: 'up' | 'flat' | 'down' } | null>(null);
  useEffect(() => {
    if (drawer?.kind === 'action') {
      const a = (account.planActions ?? []).find((x) => x.id === drawer.id);
      if (a) setActDraft({ title: a.title || '', startDate: a.startDate || todayYmd(), personId: a.personId, target: a.target || '', resources: a.resources || '', cautions: a.cautions || '', props: a.props || '', done: !!a.done, wasDone: !!a.done });
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
    dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
    setActDraft({ title: '', startDate: pa.startDate, personId: undefined, target: '', resources: '', cautions: '', props: '', done: false, wasDone: false });
    setDrawer({ kind: 'action', id: pa.id });
  };
  const deleteAction = (actionId: string) => { dispatch({ type: 'DELETE_PLAN_ACTION', accId: account.id, actionId }); setDrawer(null); };
  const saveAction = (actionId: string) => {
    if (!actDraft) return;
    const d = actDraft; const today = todayYmd();
    const title = d.title.trim() || '新行动';
    dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId, patch: { title, startDate: d.startDate, endDate: d.startDate, personId: d.personId, target: d.target, resources: d.resources, cautions: d.cautions, props: d.props, done: d.done, doneAt: d.done ? today : undefined } });
    // 结果回填：完成且关联干系人、选了态度变化 → 录一条互动证据喂策略引擎 E2（守铁律②：人当场拍板，非机器自动改分）
    if (d.done && !d.wasDone && d.personId && (d.outcome === 'up' || d.outcome === 'down')) {
      const ev = newEvidence(account.id, opp.id, d.personId, d.outcome === 'up' ? 'positive_interaction' : 'negative_interaction', d.outcome === 'up' ? 1 : -1, 'mid');
      ev.rawContent = `行动结果回填：${title}`; ev.occurredAt = today;
      dispatch({ type: 'ADD_EVIDENCE', accId: account.id, oppId: opp.id, evidence: ev });
    }
    setDrawer(null);
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
            title={`引擎建议（赢面 ${Math.round(pde.pwin * 100)}%${pde.flag ? ` · ${pde.flag.includes('no_pot') ? '未设合同额，金额降级' : '置信偏低，先摸底'}` : ''}）`}>
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
                      : <button className="sb2-send" disabled={!card.title} title={card.title ? '生成行动，落到行动计划时间轴' : '先填打法标题'}
                          onClick={(e) => { e.stopPropagation(); dispatchToPlanner(card); }}>→ 派发</button>}
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
            {planActions.length === 0 && (
              <div className="sb2-card sb2-empty-card" onClick={addAction}>还没有行动<br /><span>＋ 加一条，或在策略卡上「→ 派发」生成</span></div>
            )}
            {planActions.map((a) => {
              const overdue = !a.done && (a.endDate || a.startDate) < todayYmd();
              const target = a.personId ? personById.get(a.personId) : null;
              const focused = !!selectedPersonId && a.personId === selectedPersonId;
              return (
                <div key={a.id} className={`sb2-card sb2-action${a.done ? ' done' : ''}${drawer?.kind === 'action' && drawer.id === a.id ? ' sel' : ''}${focused ? ' sb2-focus' : ''}`}
                  onClick={() => { setDrawer({ kind: 'action', id: a.id }); if (a.personId) onSelectPerson?.(a.personId); }}>
                  <div className="sb2-card-top">
                    <span className={`sb2-act-status${a.done ? ' done' : overdue ? ' late' : ''}`}>{a.done ? '✓ 已完成' : overdue ? '✕ 逾期' : '○ 待办'}</span>
                    <span className="sb2-ms-date">{mmdd(a.startDate || '')}</span>
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
                    : <button className="btn primary sm" disabled={!drawerCard.title} onClick={() => dispatchToPlanner(drawerCard)}>📤 送行动策划</button>}
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
                <label className="sb-field"><span>目的</span>
                  <input value={actDraft.target} placeholder="这一手要达成什么" onChange={(e) => setActDraft({ ...actDraft, target: e.target.value })} />
                </label>
                <label className="sb-field"><span>所需资源</span>
                  <input value={actDraft.resources} placeholder="人 / 预算 / 内部支持…" onChange={(e) => setActDraft({ ...actDraft, resources: e.target.value })} />
                </label>
                <label className="sb-field"><span>注意要点</span>
                  <input value={actDraft.cautions} placeholder="风险 / 红线 / 话术提示" onChange={(e) => setActDraft({ ...actDraft, cautions: e.target.value })} />
                </label>
                <label className="sb-field"><span>道具</span>
                  <input value={actDraft.props} placeholder="方案 / POC / 报告 / 会议大纲…（后续可交 WorkBuddy 生产）" onChange={(e) => setActDraft({ ...actDraft, props: e.target.value })} />
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
                </div>
                <button className="sb2-drawer-del" onClick={() => deleteAction(drawer.id)}>🗑 删除该行动</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
