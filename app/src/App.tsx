import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Layer, Role, CustomerType, Edge, Person } from './types';
import { LAYER_LABEL } from './types';
import { reducer, computeInverse, injectBaseVersion, newAccount, newPerson, newEvidence, uid, type Action } from './store';
import { api, type AuthResult, type Suggestion, type InboxRel, type InboxPerson, type InboxProposal, type InboxReminder } from './api';
import { scoreFromDomain } from './lib/g64111';
import { usePersistentState, useTheme, useViewport } from './ui';
import { Auth } from './components/Auth';
import { CustomerHub } from './components/CustomerHub';
import { Sidebar } from './components/Sidebar';
import { LayerTabs } from './components/LayerTabs';
import { Canvas } from './components/Canvas';
import { DeliberationDock } from './components/DeliberationDock';
import { FocusPanel } from './components/FocusPanel';
import { EdgeDrawer } from './components/EdgeDrawer';
import { OpportunityForm } from './components/OpportunityForm';
import { CustomerProfile } from './components/CustomerProfile';
import { MdDocPanel } from './components/MdDocPanel';
import { IntelCapture } from './components/IntelCapture';
import { NewOpportunityDialog } from './components/NewOpportunityDialog';
import { layoutSkeleton, type SkeletonRole } from './data/skeletons';
import { computeGaps } from './lib/gaps';
import { GapCards } from './components/GapCards';
import { nextFreeSlot } from './lib/layout';
import { PersonForm } from './components/PersonForm';
import { TeamBilling } from './components/TeamBilling';
import { AiSettings } from './components/AiSettings';
import { WeComSettings } from './components/WeComSettings';
import { InboxPanel } from './components/InboxPanel';
import { AddIntel } from './components/AddIntel';
import { HelpManual } from './components/HelpManual';
import { McpAccess } from './components/McpAccess';
import { OverflowMenu } from './components/OverflowMenu';
import { OrientationGate } from './components/OrientationGate';
import { MomentFlow } from './components/MomentFlow';
import { Footer } from './components/Footer';

export default function App() {
  const [state, dispatch] = useReducer(reducer, { accounts: [] });
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [booting, setBooting] = useState(true);
  const [syncErr, setSyncErr] = useState('');
  const [undoHint, setUndoHint] = useState('');

  const [accId, setAccId] = useState<string | null>(null);
  const [oppId, setOppId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Set<Layer>>(() => new Set<Layer>(['L1'])); // 关系层级=点亮/熄灭多选(可层叠)
  const toggleLayer = (l: Layer) => setVisibleLayers((s) => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); if (n.size === 0) n.add(l); return n; });
  const [oppFormOpen, setOppFormOpen] = useState(false);
  const [personFormOpen, setPersonFormOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mdDocOpen, setMdDocOpen] = useState(false);
  const [intelOpen, setIntelOpen] = useState(false);
  const [newOppOpen, setNewOppOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [wecomSettingsOpen, setWecomSettingsOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]); // 当前商机的关系候选 → 喂 Canvas 画灰虚线候选边；审核统一走收件箱
  // 审核收件箱（Hub 级聚合，全租户 pending 候选）
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inbox, setInbox] = useState<{ rels: InboxRel[]; persons: InboxPerson[]; proposals: InboxProposal[]; reminders: InboxReminder[]; total: number }>({ rels: [], persons: [], proposals: [], reminders: [], total: 0 });
  const [gapsOpen, setGapsOpen] = useState(false); // M3 缺口刷卡补分（enrichOpen 随重构删 EnrichPanel 移除）
  const [selfComputeBusy, setSelfComputeBusy] = useState(false); // 江湖自算·补全干系人 进行中
  const [addIntelOpen, setAddIntelOpen] = useState(false); // ＋添加情报 单入口（口述 / 录音 / 对话 三合一）
  const [helpOpen, setHelpOpen] = useState(false);
  const [mcpAccessOpen, setMcpAccessOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState('jianghu.sidebarCollapsed', false);
  const [forceDesktop, setForceDesktop] = usePersistentState('jianghu.forceDesktop', false); // 手机竖屏默认时刻流；true=强制完整版
  const [theme, toggleTheme] = useTheme();
  // 画布选中模型：单击=选中(节点出锚点/连线出控制点)，双击=打开右侧栏
  const [focusTab, setFocusTab] = useState<'profile' | 'dynamic' | 'advisor'>('advisor'); // 焦点面板 tab：单击→参谋、双击→档案
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [drawerEdgeId, setDrawerEdgeId] = useState<string | null>(null);
  const [openActionId, setOpenActionId] = useState<string | null>(null); // 点画布行动牌 → 通知坞开编辑抽屉
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const { isMobile, isLandscape } = useViewport();

  // 全屏「只看白板」：隐藏所有 UI + 调用原生 Fullscreen（隐藏浏览器栏，桌面/安卓支持；iOS Safari 非视频不支持，则仅隐藏本应用 UI）
  const toggleImmersive = useCallback(() => {
    setImmersive((cur) => {
      const next = !cur;
      try {
        if (next) {
          // 全屏后尝试锁横屏（Android 生效；iOS Safari 不支持则静默忽略，退出全屏自动解锁）
          const fs = document.documentElement.requestFullscreen?.();
          (fs as Promise<void> | undefined)?.then?.(() => (screen.orientation as unknown as { lock?: (o: string) => Promise<void> })?.lock?.('landscape'))?.catch?.(() => { /* 不支持 */ });
        } else if (document.fullscreenElement) document.exitFullscreen?.();
      } catch { /* 不支持则仅 CSS 沉浸 */ }
      return next;
    });
  }, []);
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setImmersive(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // 启动：有 token 则恢复会话 + 拉取云端数据
  useEffect(() => {
    (async () => {
      if (!api.getToken()) { setBooting(false); return; }
      try {
        const me = await api.me();
        const st = await api.getState();
        dispatch({ type: 'HYDRATE', accounts: st.accounts });
        setAuth({ token: api.getToken()!, user: me.user, tenant: me.tenant });
        api.inboxList().then(setInbox).catch(() => { /* 收件箱角标，失败忽略 */ });
      } catch { api.setToken(null); } finally { setBooting(false); }
    })();
  }, []);

  const onAuthed = async (res: AuthResult) => {
    const st = await api.getState();
    dispatch({ type: 'HYDRATE', accounts: st.accounts });
    setAuth(res);
    api.inboxList().then(setInbox).catch(() => { /* 收件箱角标 */ });
  };
  const logout = () => { api.setToken(null); setAuth(null); setAccId(null); setSelectedId(null); dispatch({ type: 'HYDRATE', accounts: [] }); };

  // 最新 state 镜像：供 computeInverse 取旧值 + 乐观锁注入 baseVersion
  const stateRef = useRef(state);
  stateRef.current = state;
  // 底层落地：乐观本地 + 云端持久化（乐观锁注入 baseVersion；409 冲突重拉整树覆盖本地；普通操作与 undo/redo 共用）
  const applyRaw = useCallback(async (action: Action) => {
    const a = injectBaseVersion(stateRef.current, action);
    dispatch(a);
    try { await api.mutate(a); setSyncErr(''); }
    catch (e: any) {
      if (e?.status === 409) {
        setSyncErr('⚠️ 该数据刚被其他成员修改，已为你刷新到最新——你这步未保存，请在最新内容上重做。');
        try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 重拉失败：下次操作再同步 */ }
      } else {
        setSyncErr('云端保存失败：' + e.message);
      }
    }
  }, []);
  const undoStack = useRef<{ redo: Action[]; undo: Action[] }[]>([]);
  const redoStack = useRef<{ redo: Action[]; undo: Action[] }[]>([]);
  // 用户操作：先算逆 action 入撤销栈（前后各 10 次），再落地
  const act = useCallback((action: Action) => {
    const inv = computeInverse(action, stateRef.current);
    if (inv && inv.length) {
      undoStack.current.push({ redo: [action], undo: inv });
      if (undoStack.current.length > 10) undoStack.current.shift();
      redoStack.current = [];
    }
    applyRaw(action);
  }, [applyRaw]);
  const undo = useCallback(() => {
    const item = undoStack.current.pop();
    if (!item) { setUndoHint('⊘ 没有可撤销的操作'); return; }
    item.undo.forEach((x) => applyRaw(x));
    redoStack.current.push(item);
    if (redoStack.current.length > 10) redoStack.current.shift();
    setUndoHint(`↶ 已撤销 · 还可撤销 ${undoStack.current.length} 步`);
  }, [applyRaw]);
  const redo = useCallback(() => {
    const item = redoStack.current.pop();
    if (!item) { setUndoHint('⊘ 没有可重做的操作'); return; }
    item.redo.forEach((x) => applyRaw(x));
    undoStack.current.push(item);
    if (undoStack.current.length > 10) undoStack.current.shift();
    setUndoHint(`↷ 已重做 · 还可重做 ${redoStack.current.length} 步`);
  }, [applyRaw]);
  // 全局快捷键：Ctrl/Cmd+Z 撤销 · Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做（输入框内不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);
  useEffect(() => { if (!undoHint) return; const t = setTimeout(() => setUndoHint(''), 1600); return () => clearTimeout(t); }, [undoHint]);

  const account = state.accounts.find((a) => a.id === accId) ?? null;
  const opp = account?.opportunities.find((o) => o.id === oppId) ?? null;
  const breakdown = useMemo(() => (account && opp ? scoreFromDomain(account, opp) : null), [account, opp]);
  const gaps = useMemo(() => (account && opp ? computeGaps(account, opp) : []), [account, opp]);
  const roleByPerson = useMemo(() => {
    const m = new Map<string, Role>();
    if (opp) for (const r of opp.roles) m.set(r.personId, r.role);
    return m;
  }, [opp]);

  // 进入某商机时加载已有的 AI 候选关系（pending）
  useEffect(() => {
    if (!opp) { setSuggestions([]); return; }
    api.suggestList(opp.id).then((r) => setSuggestions(r.suggestions)).catch(() => setSuggestions([]));
  }, [opp?.id]);

  const openAccount = (id: string) => {
    const a = state.accounts.find((x) => x.id === id);
    setAccId(id); setOppId(a?.opportunities[0]?.id ?? null); setSelectedId(null); setVisibleLayers(new Set(['L1']));
  };
  const createAccount = (name: string, ctype: CustomerType) => {
    const a = newAccount(name, ctype);
    act({ type: 'ADD_ACCOUNT', account: a });
    setAccId(a.id); setOppId(null); setSelectedId(null); setVisibleLayers(new Set(['L1']));
  };
  const loadDemo = async () => {
    setSyncErr('');
    const prev = new Set(state.accounts.map((a) => a.id));
    try {
      await api.demo();
      const st = await api.getState();
      dispatch({ type: 'HYDRATE', accounts: st.accounts });
      const added = st.accounts.find((a) => !prev.has(a.id)) ?? st.accounts[st.accounts.length - 1];
      if (added) { setAccId(added.id); setOppId(added.opportunities[0]?.id ?? null); setSelectedId(null); setVisibleLayers(new Set(['L1'])); }
    } catch (e: any) { setSyncErr('载入示例失败：' + e.message); }
  };
  const addOpp = () => { if (account) setNewOppOpen(true); };
  const createOpportunity = async (params: { name: string; fromOppId?: string; personIds: string[]; withEdges: boolean; skeleton?: SkeletonRole[] }) => {
    if (!account) return;
    setNewOppOpen(false);
    try {
      const { opportunityId } = await api.cloneOpportunity({ accountId: account.id, name: params.name, fromOppId: params.fromOppId, personIds: params.personIds, withEdges: params.withEdges });
      // M2 骨架预填：clone 建的新商机 memberScoped=true，占位人物须 ADD_OPP_MEMBER 才在画布可见，再 SET_ROLE 设角色（占位支持度=未知，待认领）。
      if (params.skeleton?.length) {
        for (const sk of layoutSkeleton(params.skeleton)) {
          const p = newPerson(sk.title, sk.title, sk.x, sk.y, false);
          p.orgLevel = sk.orgLevel;
          await api.mutate({ type: 'ADD_PERSON', accId: account.id, person: p });
          await api.mutate({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opportunityId, personId: p.id });
          await api.mutate({ type: 'SET_ROLE', accId: account.id, oppId: opportunityId, personId: p.id, patch: { role: sk.role, sentiment: 'unknown', confidence: '不清' } });
        }
      }
      const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts });
      setOppId(opportunityId); setSelectedId(null); setVisibleLayers(new Set(['L1']));
    } catch (e: any) { setSyncErr('新建商机失败：' + e.message); }
  };
  const deleteOpp = (id: string) => {
    if (!account) return;
    act({ type: 'DELETE_OPP', accId: account.id, oppId: id });
    if (oppId === id) setOppId(account.opportunities.find((o) => o.id !== id)?.id ?? null);
  };
  const addPerson = (name: string, title: string, isCompetitor: boolean) => {
    if (!account) return;
    const occupied = account.persons.filter((p) => !p.isCompetitor).map((p) => ({ x: p.x, y: p.y }));
    const { x, y } = isCompetitor ? { x: 90, y: 440 } : nextFreeSlot(occupied);
    const p = newPerson(name, title, x, y, isCompetitor);
    act({ type: 'ADD_PERSON', accId: account.id, person: p });
    if (opp?.memberScoped) act({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opp.id, personId: p.id }); // memberScoped 商机内建人 → 加入成员，否则被过滤看不见
    setSelectedId(p.id);
  };

  // ── 画布交互：选中 / 打开右侧栏 / 飞书式建点连线 ──
  const selectPerson = (id: string | null) => { setSelectedId(id); setSelectedEdgeId(null); if (id) setFocusTab('advisor'); }; // 单击=选中→焦点面板「参谋」
  const openPerson = (id: string) => { setSelectedId(id); setSelectedEdgeId(null); setDrawerEdgeId(null); setFocusTab('profile'); }; // 双击=选中→焦点面板「档案」
  const selectEdge = (id: string | null) => { setSelectedEdgeId(id); setSelectedId(null); if (id && drawerEdgeId) setDrawerEdgeId(id); };
  const openEdge = (id: string) => { setSelectedId(null); setDrawerEdgeId(id); };
  // 画布行动牌就地反馈：标完成 + 态度↑↓ → 录一条互动证据喂策略引擎（复用坞的结果回填飞轮，守铁律②：人当场拍板）
  const actionFeedback = (actionId: string, outcome: 'up' | 'flat' | 'down') => {
    if (!account || !opp) return;
    const a = (account.planActions ?? []).find((x) => x.id === actionId);
    if (!a) return;
    const today = new Date().toISOString().slice(0, 10);
    act({ type: 'TOGGLE_PLAN_ACTION', accId: account.id, actionId, done: true, doneAt: today });
    if (a.personId && (outcome === 'up' || outcome === 'down')) {
      const ev = newEvidence(account.id, opp.id, a.personId, outcome === 'up' ? 'positive_interaction' : 'negative_interaction', outcome === 'up' ? 1 : -1, 'mid');
      ev.rawContent = `行动结果回填：${a.title || '行动'}`; ev.occurredAt = today;
      act({ type: 'ADD_EVIDENCE', accId: account.id, oppId: opp.id, evidence: ev });
    }
  };
  // 切客户/商机时清空一切选中
  useEffect(() => { setSelectedId(null); setSelectedEdgeId(null); setDrawerEdgeId(null); }, [accId, oppId]);

  const addPersonAt = (x: number, y: number): string => {
    if (!account) return '';
    const p = newPerson('新成员', '', x, y, false);
    act({ type: 'ADD_PERSON', accId: account.id, person: p });
    if (opp?.memberScoped) act({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opp.id, personId: p.id });
    setSelectedId(p.id); setSelectedEdgeId(null);
    return p.id;
  };
  const makeEdge = (source: string, target: string): Edge => ({
    id: uid('e'), source, target, layer: [...visibleLayers][0] ?? 'L1', label: '', color: '#94a3b8', style: 'solid', directed: true, origin: 'manual',
  });
  const connectNodes = (source: string, target: string) => {
    if (!account || !opp || source === target) return;
    const e = makeEdge(source, target);
    act({ type: 'ADD_EDGE', accId: account.id, oppId: opp.id, edge: e });
    setSelectedId(null); setSelectedEdgeId(e.id);
  };
  const addConnectedNode = (source: string, x: number, y: number): string => {
    if (!account || !opp) return '';
    const p = newPerson('新成员', '', x, y, false);
    act({ type: 'ADD_PERSON', accId: account.id, person: p });
    if (opp.memberScoped) act({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opp.id, personId: p.id });
    act({ type: 'ADD_EDGE', accId: account.id, oppId: opp.id, edge: makeEdge(source, p.id) });
    setSelectedId(p.id); setSelectedEdgeId(null);
    return p.id;
  };
  const updateEdge = (edgeId: string, patch: Partial<Edge>) => {
    if (!account || !opp) return;
    act({ type: 'UPDATE_EDGE', accId: account.id, oppId: opp.id, edgeId, patch });
  };
  const deleteEdgeById = (edgeId: string) => {
    if (!account || !opp) return;
    act({ type: 'DELETE_EDGE', accId: account.id, oppId: opp.id, edgeId });
  };
  const updatePerson = (id: string, patch: Partial<Person>) => {
    if (!account) return;
    act({ type: 'UPDATE_PERSON', accId: account.id, personId: id, patch });
  };
  const deletePerson = (id: string) => {
    if (!account) return;
    act({ type: 'DELETE_PERSON', accId: account.id, personId: id });
    setSelectedId(null);
  };

  // AI 关系/人物候选的【生成】= selfCompute（自算补全，异步入队，见下）；【审核】统一走收件箱（inbox* 系列）。

  // ── 江湖自算·补全：后台入队 enrich(客户·发现干系人) + suggest_relations(当前商机·推断关系) → 轮询 → 刷新候选。产物走人审，铁律② ──
  const selfCompute = async () => {
    if (!account || selfComputeBusy) return;
    setSelfComputeBusy(true);
    try {
      const tasks: string[] = [];
      const er = await api.enrichEnqueue(account.id, 'auto');
      tasks.push(er.enqueued ? '发现干系人' : '发现干系人(进行中)');
      if (opp) {
        const sr = await api.suggestEnqueue(opp.id);
        tasks.push(sr.enqueued ? '推断关系' : '推断关系(进行中)');
      }
      setSyncErr(`🔍 已启动自算·${tasks.join(' + ')}，完成后进收件箱…`);
      // 轮询：等该客户名下所有任务跑完（worker 每 5s 一次，最多 ~50s）
      for (let i = 0; i < 25; i++) {
        await new Promise((s) => setTimeout(s, 2000));
        const { jobs } = await api.enrichJobs(account.id);
        const active = jobs.filter((j) => j.status === 'pending' || j.status === 'processing');
        if (active.length) continue;
        // 全部终态：汇总结果并刷新候选
        let persons = 0, rels = 0, onlyMock = true;
        for (const j of jobs.slice(0, 4)) {
          try {
            const res = JSON.parse(j.result || '{}');
            if (j.type === 'enrich_account') { persons += res.created ?? 0; if (res.source && res.source !== 'mock') onlyMock = false; }
            if (j.type === 'suggest_relations') { rels += res.added ?? 0; onlyMock = false; }
          } catch { /* 摘要解析失败忽略 */ }
        }
        if (opp) { try { setSuggestions((await api.suggestList(opp.id)).suggestions); } catch { /* 下次同步 */ } }
        await loadInbox();
        setSyncErr(onlyMock && persons === 0 && rels === 0
          ? '🔍 自算完成：未配置企查查 MCP / AI 模型，暂无可发现内容（可在设置里配置数据源）。'
          : `🔍 自算完成：发现 ${persons} 位候选干系人 + ${rels} 条候选关系，请到收件箱人审。`);
        break;
      }
    } catch (e: any) { setSyncErr('自算失败：' + (e?.message || e)); }
    finally { setSelfComputeBusy(false); }
  };

  // ── 审核收件箱（Hub 级）：复用既有候选采纳/驳回链路；采纳会改对应客户的树 → getState 重拉整树保证跨客户一致 ──
  const loadInbox = async () => { try { setInbox(await api.inboxList()); } catch { /* 角标失败忽略 */ } };
  const refreshAfterAccept = async () => {
    try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 重拉失败下次同步 */ }
    if (opp) { try { setSuggestions((await api.suggestList(opp.id)).suggestions); } catch { /* 下次同步 */ } } // 采纳/忽略关系候选后刷新画布灰虚线候选边
    await loadInbox();
  };
  const inboxAcceptRel = async (id: string) => { try { await api.suggestAccept(id); await refreshAfterAccept(); } catch (e: any) { setSyncErr('采纳失败：' + e.message); } };
  const inboxRejectRel = async (id: string) => { try { await api.suggestReject(id); await loadInbox(); } catch (e: any) { setSyncErr('忽略失败：' + e.message); } };
  const inboxAcceptPerson = async (id: string) => { try { await api.personSuggestAccept(id); await refreshAfterAccept(); } catch (e: any) { setSyncErr('采纳失败：' + e.message); } };
  const inboxRejectPerson = async (id: string) => { try { await api.personSuggestReject(id); await loadInbox(); } catch (e: any) { setSyncErr('忽略失败：' + e.message); } };
  const inboxAcceptProposal = async (id: string, overrideValue?: string) => { try { await api.proposalAccept(id, overrideValue); await refreshAfterAccept(); } catch (e: any) { setSyncErr('采纳失败：' + e.message); } };
  const inboxRejectProposal = async (id: string) => { try { await api.proposalReject(id); await loadInbox(); } catch (e: any) { setSyncErr('忽略失败：' + e.message); } };
  const inboxDismissReminder = async (id: string) => { try { await api.reminderDismiss(id); await loadInbox(); } catch (e: any) { setSyncErr('忽略失败：' + e.message); } };

  if (booting) return <div className="boot">加载中…</div>;
  if (!auth) return <Auth onAuthed={onAuthed} />;

  // ── Hub / 手机竖屏时刻流（场景 A：竖屏默认=时刻流，横屏提示只在进作战室后）──
  const phonePortrait = isMobile && !isLandscape;
  if (!account) {
    return (
      <>
        {phonePortrait && !forceDesktop ? (
          <MomentFlow
            accounts={state.accounts} inbox={inbox} userName={auth.user.name}
            theme={theme} onToggleTheme={toggleTheme}
            onOpenIntel={() => setIntelOpen(true)}
            onEnterAccount={(aId, oId) => { const a = state.accounts.find((x) => x.id === aId); setAccId(aId); setOppId(oId ?? a?.opportunities[0]?.id ?? null); setSelectedId(null); }}
            onExitToDesktop={() => setForceDesktop(true)}
            onLogout={logout}
            onAcceptProposal={inboxAcceptProposal} onRejectProposal={inboxRejectProposal}
            onAcceptPerson={inboxAcceptPerson} onRejectPerson={inboxRejectPerson}
            onAcceptRel={inboxAcceptRel} onRejectRel={inboxRejectRel}
            onDismissReminder={inboxDismissReminder}
          />
        ) : (
        <CustomerHub
          accounts={state.accounts} onOpen={openAccount} onCreate={createAccount} onLoadDemo={loadDemo}
          onDeleteAccount={(id) => act({ type: 'DELETE_ACCOUNT', accId: id })}
          tenantName={auth.tenant.name} userName={auth.user.name} plan={auth.tenant.plan}
          onOpenTeam={() => setTeamOpen(true)} onLogout={logout} onOpenAiSettings={() => setAiSettingsOpen(true)} onOpenWecom={() => setWecomSettingsOpen(true)}
          theme={theme} onToggleTheme={toggleTheme} onOpenHelp={() => setHelpOpen(true)}
          onOpenMcpAccess={() => setMcpAccessOpen(true)}
          onOpenIntel={() => setIntelOpen(true)}
          onOpenInbox={() => setInboxOpen(true)} inboxCount={inbox.total}
        />
        )}
        {phonePortrait && forceDesktop && <button className="mf-exit-desktop" onClick={() => setForceDesktop(false)}>📱 回手机版</button>}
        {syncErr && <div className="sync-toast">{syncErr}</div>}
        {inboxOpen && <InboxPanel rels={inbox.rels} persons={inbox.persons} proposals={inbox.proposals} accounts={state.accounts} onAccept={inboxAcceptRel} onReject={inboxRejectRel} onAcceptPerson={inboxAcceptPerson} onRejectPerson={inboxRejectPerson} onAcceptProposal={inboxAcceptProposal} onRejectProposal={inboxRejectProposal} reminders={inbox.reminders} onDismissReminder={inboxDismissReminder} onClose={() => setInboxOpen(false)} />}
        {intelOpen && (
          <IntelCapture
            onClose={() => setIntelOpen(false)}
            onDone={async () => { try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 静默：保存已成功，仅刷新失败 */ } }}
            onEnterAccount={async (id) => {
              setIntelOpen(false);
              try {
                const st = await api.getState();
                dispatch({ type: 'HYDRATE', accounts: st.accounts });
                const a = st.accounts.find((x) => x.id === id);
                setAccId(id); setOppId(a?.opportunities[0]?.id ?? null); setSelectedId(null); setVisibleLayers(new Set(['L1']));
              } catch { setAccId(id); }
            }}
          />
        )}
        {teamOpen && <TeamBilling role={auth.user.role} onClose={() => setTeamOpen(false)} />}
        {aiSettingsOpen && <AiSettings role={auth.user.role} onClose={() => setAiSettingsOpen(false)} />}
        {wecomSettingsOpen && <WeComSettings role={auth.user.role} onClose={() => setWecomSettingsOpen(false)} />}
        {helpOpen && <HelpManual onClose={() => setHelpOpen(false)} />}
        {mcpAccessOpen && <McpAccess onClose={() => setMcpAccessOpen(false)} />}
        <Footer />
      </>
    );
  }

  const selectedPerson = account.persons.find((p) => p.id === selectedId) ?? null;
  const selectedRole = opp?.roles.find((r) => r.personId === selectedId);
  const selectedBis = opp?.bis.filter((b) => b.personId === selectedId) ?? [];
  const selectedUcvs = (opp?.ucvs ?? []).filter((u) => selectedBis.some((b) => b.id === u.targetBiId));
  const drawerEdge = drawerEdgeId
    ? [...account.baseEdges, ...account.opportunities.flatMap((o) => o.edges)].find((e) => e.id === drawerEdgeId) ?? null
    : null;
  const sidebarEl = (
    <Sidebar
      account={account} opp={opp} breakdown={breakdown}
      onSelectOpp={(id) => { setOppId(id); selectPerson(null); setMobileNavOpen(false); }}
      onAddOpp={addOpp}
      onBack={() => { setAccId(null); selectPerson(null); }}
      onCollapse={() => (isMobile ? setMobileNavOpen(false) : setSidebarCollapsed(true))}
      onChatDone={async () => { try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 静默：保存已成功，仅刷新失败 */ } }}
      gapCount={gaps.length} onOpenGaps={() => setGapsOpen(true)}
    />
  );

  return (
    <div className={`app-shell${isMobile ? ' mobile' : ''}${immersive ? ' immersive' : ''}`}>
      {isMobile && !isLandscape && <OrientationGate />}
      {!immersive && (isMobile ? (
        <>
          {!mobileNavOpen && <button className="edge-arrow edge-left" onClick={() => setMobileNavOpen(true)} title="展开侧边栏" aria-label="展开侧边栏">›</button>}
          {mobileNavOpen && <div className="mobile-backdrop" onClick={() => setMobileNavOpen(false)} />}
          <div className={`mobile-drawer${mobileNavOpen ? ' open' : ''}`}>
            {sidebarEl}
            {mobileNavOpen && <button className="edge-arrow edge-close" onClick={() => setMobileNavOpen(false)} title="收起侧边栏" aria-label="收起侧边栏">‹</button>}
          </div>
        </>
      ) : sidebarCollapsed ? (
        <button className="edge-arrow edge-left" onClick={() => setSidebarCollapsed(false)} title="展开侧边栏" aria-label="展开侧边栏">›</button>
      ) : (
        <div className="sidebar-dock">
          {sidebarEl}
          <button className="edge-arrow edge-close" onClick={() => setSidebarCollapsed(true)} title="收起侧边栏" aria-label="收起侧边栏">‹</button>
        </div>
      ))}

      <main className="main">
        {opp ? (
          <>
            {!immersive && (
              <div className="module-top wall-top">
                {!isMobile && <LayerTabs visible={visibleLayers} onToggle={toggleLayer} />}
                {!isMobile && (<>
                  <button className="btn cta xs" onClick={() => setAddIntelOpen(true)} title="添加情报：口述录入 / 录音转写 / 和地图对话——把手上的线索喂进江湖">＋ 添加情报</button>
                  <button className="btn ghost xs" onClick={() => setMdDocOpen(true)} title="客户档案 / 商机档案 / 拜访记录（.md 文档）">📋 作战档案</button>
                  <button className="btn ghost xs" onClick={selfCompute} disabled={selfComputeBusy} title="江湖自算：后台用企查查/AI 发现关键干系人 + 推断当前商机内关系，候选进收件箱待人审">{selfComputeBusy ? '⏳ 自算中…' : '🔍 自算补全'}</button>
                  <button className="btn ghost xs" onClick={() => setInboxOpen(true)}>📥 收件箱{inbox.total > 0 ? ` (${inbox.total})` : ''}</button>
                  <span style={{ marginLeft: 'auto' }}>
                    <OverflowMenu align="right" label="⚙️" items={[
                      { label: '❓ 帮助', onClick: () => setHelpOpen(true) },
                      { label: theme === 'dark' ? '☀️ 白天模式' : '🌙 黑夜模式', onClick: toggleTheme },
                    ]} />
                  </span>
                </>)}
                {isMobile && (<>
                  <OverflowMenu align="left" label={`▾ 层级 (${visibleLayers.size})`}
                    items={(['L1', 'L2', 'L3', 'L4'] as Layer[]).map((l) => ({ label: LAYER_LABEL[l], active: visibleLayers.has(l), onClick: () => toggleLayer(l) }))} />
                  <OverflowMenu align="left" label="⋯ 操作" items={[
                    { label: '＋ 添加情报', primary: true, onClick: () => setAddIntelOpen(true) },
                    { label: '📋 作战档案', onClick: () => setMdDocOpen(true) },
                    { label: selfComputeBusy ? '⏳ 自算中…' : '🔍 自算补全', onClick: selfCompute },
                    { label: '📥 收件箱', badge: inbox.total > 0 ? String(inbox.total) : undefined, onClick: () => setInboxOpen(true) },
                    { label: '❓ 帮助', onClick: () => setHelpOpen(true) },
                    { label: theme === 'dark' ? '☀️ 白天模式' : '🌙 黑夜模式', onClick: toggleTheme },
                  ]} />
                </>)}
              </div>
            )}
            <>
            <Canvas account={account} opp={opp} visibleLayers={visibleLayers}
              selectedId={selectedId} selectedEdgeId={selectedEdgeId}
              onSelectPerson={selectPerson} onSelectEdge={selectEdge}
              onOpenPerson={openPerson} onOpenEdge={openEdge} onOpenAction={setOpenActionId} onActionFeedback={actionFeedback}
              onMovePerson={(id, x, y) => act({ type: 'MOVE_PERSON', accId: account.id, personId: id, x, y })}
              onAddPersonAt={addPersonAt} onAddConnectedNode={addConnectedNode} onConnect={connectNodes}
              onUpdateEdge={updateEdge} onDeleteEdge={deleteEdgeById}
              onUpdatePerson={updatePerson} onDeletePerson={deletePerson}
              immersive={immersive} onToggleImmersive={toggleImmersive} secondTapOpens={true}
              suggestions={suggestions} planActions={account.planActions ?? []} />
            {!immersive && breakdown && (
              <DeliberationDock account={account} opp={opp} breakdown={breakdown} dispatch={act}
                selectedPersonId={selectedId} onSelectPerson={selectPerson}
                openActionId={openActionId} onActionOpened={() => setOpenActionId(null)} />
            )}
            </>
          </>
        ) : (
          <div className="no-opp">
            <div className="no-opp-emoji">🎯</div>
            <div className="no-opp-t">这个客户还没有商机</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn primary" onClick={addOpp}>＋ 新建商机</button>
              <button className="btn ghost" onClick={() => setMdDocOpen(true)}>📋 作战档案</button>
            </div>
          </div>
        )}
      </main>

      {selectedPerson && opp && breakdown && (
        <FocusPanel accId={account.id} oppId={opp.id} account={account} opp={opp} breakdown={breakdown}
          person={selectedPerson} oppRole={selectedRole} bis={selectedBis} ucvs={selectedUcvs}
          visitNotes={account.visitNotes ?? []} tab={focusTab} onTabChange={setFocusTab} dispatch={act}
          onRefresh={async () => { try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 静默：改图已成功，仅刷新失败 */ } }}
          onClose={() => setSelectedId(null)} />
      )}
      {drawerEdge && (
        <EdgeDrawer edge={drawerEdge} persons={account.persons}
          onUpdate={(patch) => updateEdge(drawerEdge.id, patch)}
          onDelete={() => { deleteEdgeById(drawerEdge.id); setDrawerEdgeId(null); setSelectedEdgeId(null); }}
          onClose={() => setDrawerEdgeId(null)} />
      )}

      {oppFormOpen && opp && (
        <OpportunityForm opp={opp} onClose={() => setOppFormOpen(false)}
          onSave={(patch) => act({ type: 'UPDATE_OPP', accId: account.id, oppId: opp.id, patch })} />
      )}
      {newOppOpen && (
        <NewOpportunityDialog account={account} onClose={() => setNewOppOpen(false)} onCreate={createOpportunity} />
      )}
      {profileOpen && (
        <CustomerProfile account={account} onClose={() => setProfileOpen(false)}
          onSave={(patch) => act({ type: 'UPDATE_ACCOUNT', accId: account.id, patch })}
          onDone={async () => { try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 静默：保存已成功，仅刷新失败 */ } }} />
      )}
      {mdDocOpen && <MdDocPanel account={account} dispatch={act} onClose={() => setMdDocOpen(false)} />}
      {addIntelOpen && (
        <AddIntel account={account} opp={opp} role={auth.user.role}
          onClose={() => setAddIntelOpen(false)}
          onDone={async () => { try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); await loadInbox(); } catch { /* 静默：保存已成功，仅刷新失败 */ } }} />
      )}
      {personFormOpen && <PersonForm onCreate={addPerson} onClose={() => setPersonFormOpen(false)} />}
      {teamOpen && <TeamBilling role={auth.user.role} onClose={() => setTeamOpen(false)} />}
      {aiSettingsOpen && <AiSettings role={auth.user.role} onClose={() => setAiSettingsOpen(false)} />}
      {helpOpen && <HelpManual onClose={() => setHelpOpen(false)} />}
      {mcpAccessOpen && <McpAccess onClose={() => setMcpAccessOpen(false)} />}
      {gapsOpen && account && opp && breakdown && (
        <GapCards account={account} opp={opp} dispatch={act} onClose={() => setGapsOpen(false)} />
      )}
      {inboxOpen && <InboxPanel rels={inbox.rels} persons={inbox.persons} proposals={inbox.proposals} accounts={state.accounts} onAccept={inboxAcceptRel} onReject={inboxRejectRel} onAcceptPerson={inboxAcceptPerson} onRejectPerson={inboxRejectPerson} onAcceptProposal={inboxAcceptProposal} onRejectProposal={inboxRejectProposal} reminders={inbox.reminders} onDismissReminder={inboxDismissReminder} onClose={() => setInboxOpen(false)} />}
      {syncErr && <div className="sync-toast">{syncErr}</div>}
      {undoHint && <div className="undo-toast">{undoHint}</div>}
    </div>
  );
}
