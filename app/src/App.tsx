import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Layer, Role, CustomerType, Edge, Person } from './types';
import { LAYER_LABEL } from './types';
import { reducer, computeInverse, injectBaseVersion, newAccount, newPerson, uid, type Action } from './store';
import { api, type AuthResult, type Suggestion, type PersonSuggestion, type InboxRel, type InboxPerson, type InboxProposal } from './api';
import { scoreFromDomain } from './lib/g64111';
import { usePersistentState, useTheme, useViewport } from './ui';
import { Auth } from './components/Auth';
import { CustomerHub } from './components/CustomerHub';
import { Sidebar } from './components/Sidebar';
import { LayerTabs } from './components/LayerTabs';
import { Canvas } from './components/Canvas';
import { type CustomerView } from './components/ViewTabs';
import { DeliberationDock } from './components/DeliberationDock';
import { DetailDrawer } from './components/DetailDrawer';
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
import { SuggestionPanel } from './components/SuggestionPanel';
import { InboxPanel } from './components/InboxPanel';
import { ReportPanel } from './components/ReportPanel';
import { HelpManual } from './components/HelpManual';
import { McpAccess } from './components/McpAccess';
import { OverflowMenu } from './components/OverflowMenu';
import { OrientationGate } from './components/OrientationGate';
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
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [personSuggs, setPersonSuggs] = useState<PersonSuggestion[]>([]);
  const [generating, setGenerating] = useState(false);
  // 审核收件箱（Hub 级聚合，全租户 pending 候选）
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inbox, setInbox] = useState<{ rels: InboxRel[]; persons: InboxPerson[]; proposals: InboxProposal[]; total: number }>({ rels: [], persons: [], proposals: [], total: 0 });
  const [gapsOpen, setGapsOpen] = useState(false); // M3 缺口刷卡补分（enrichOpen 随重构删 EnrichPanel 移除）
  const [reportOpen, setReportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mcpAccessOpen, setMcpAccessOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState('jianghu.sidebarCollapsed', false);
  const [view, setView] = usePersistentState<CustomerView>('jianghu.customerView', 'wall'); // 客户级镜头：关系地图 / 行动计划
  const [theme, toggleTheme] = useTheme();
  // 画布选中模型：单击=选中(节点出锚点/连线出控制点)，双击=打开右侧栏
  const [drawerPersonId, setDrawerPersonId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [drawerEdgeId, setDrawerEdgeId] = useState<string | null>(null);
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

  // 进入某客户时加载候选干系人（外部 agent 经 MCP 提议，pending）
  useEffect(() => {
    if (!accId) { setPersonSuggs([]); return; }
    api.personSuggestList(accId).then((r) => setPersonSuggs(r.suggestions)).catch(() => setPersonSuggs([]));
  }, [accId]);

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
  const selectPerson = (id: string | null) => { setSelectedId(id); setSelectedEdgeId(null); if (id && (drawerPersonId || drawerEdgeId)) { setDrawerEdgeId(null); setDrawerPersonId(id); } };
  const openPerson = (id: string) => { setSelectedId(id); setSelectedEdgeId(null); setDrawerEdgeId(null); setDrawerPersonId(id); };
  const selectEdge = (id: string | null) => { setSelectedEdgeId(id); setSelectedId(null); if (id && (drawerPersonId || drawerEdgeId)) { setDrawerPersonId(null); setDrawerEdgeId(id); } };
  const openEdge = (id: string) => { setDrawerPersonId(null); setDrawerEdgeId(id); };
  // 切客户/商机时清空一切选中
  useEffect(() => { setSelectedId(null); setSelectedEdgeId(null); setDrawerPersonId(null); setDrawerEdgeId(null); }, [accId, oppId]);
  // 策略沙盘并入地图推演坞、行动计划网格退役：旧持久态（sandbox/planner）一律归一到关系地图
  useEffect(() => { if (view !== 'wall') setView('wall'); }, [view, setView]);

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
    setDrawerPersonId((d) => (d === id ? null : d));
  };

  // ── AI 关系推断 ──
  const generateSuggestions = async () => {
    if (!opp) return;
    setGenerating(true);
    try { const r = await api.suggestGenerate(opp.id); setSuggestions(r.suggestions); }
    catch (e: any) { setSyncErr('关系推断失败：' + e.message); }
    finally { setGenerating(false); }
  };
  const acceptSuggestion = async (id: string) => {
    if (!account || !opp) return;
    try {
      const { edge, createdPersons } = await api.suggestAccept(id);
      // 级联：若端点是候选人物，服务端已建正式 Person，本地须先 ADD_PERSON 再 ADD_EDGE（否则画布找不到端点）
      for (const p of createdPersons ?? []) {
        dispatch({ type: 'ADD_PERSON', accId: account.id, person: p });
        if (opp.memberScoped) dispatch({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opp.id, personId: p.id }); // 服务端已加成员，本地同步
      }
      dispatch({ type: 'ADD_EDGE', accId: account.id, oppId: opp.id, edge }); // 服务端已建，本地直接加避免重复写
      setSuggestions((s) => s.filter((x) => x.id !== id));
    } catch (e: any) { setSyncErr('采纳失败：' + e.message); }
  };

  // ── 候选干系人（外部 agent 经 MCP 提议，待人审）──
  const loadPersonSuggestions = async (accId: string) => {
    try { const r = await api.personSuggestList(accId); setPersonSuggs(r.suggestions); }
    catch { setPersonSuggs([]); }
  };
  const acceptPersonSugg = async (id: string) => {
    if (!account) return;
    try {
      const { person } = await api.personSuggestAccept(id);
      if (person) {
        dispatch({ type: 'ADD_PERSON', accId: account.id, person });
        if (opp?.memberScoped) dispatch({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opp.id, personId: person.id }); // 服务端已加成员，本地同步
      }
      setPersonSuggs((s) => s.filter((x) => x.id !== id));
    } catch (e: any) { setSyncErr('采纳干系人失败：' + e.message); }
  };
  const rejectPersonSugg = async (id: string) => {
    try { await api.personSuggestReject(id); setPersonSuggs((s) => s.filter((x) => x.id !== id)); }
    catch (e: any) { setSyncErr('忽略失败：' + e.message); }
  };
  const rejectSuggestion = async (id: string) => {
    try { await api.suggestReject(id); setSuggestions((s) => s.filter((x) => x.id !== id)); }
    catch (e: any) { setSyncErr('忽略失败：' + e.message); }
  };

  // ── 审核收件箱（Hub 级）：复用既有候选采纳/驳回链路；采纳会改对应客户的树 → getState 重拉整树保证跨客户一致 ──
  const loadInbox = async () => { try { setInbox(await api.inboxList()); } catch { /* 角标失败忽略 */ } };
  const refreshAfterAccept = async () => {
    try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 重拉失败下次同步 */ }
    await loadInbox();
  };
  const inboxAcceptRel = async (id: string) => { try { await api.suggestAccept(id); await refreshAfterAccept(); } catch (e: any) { setSyncErr('采纳失败：' + e.message); } };
  const inboxRejectRel = async (id: string) => { try { await api.suggestReject(id); await loadInbox(); } catch (e: any) { setSyncErr('忽略失败：' + e.message); } };
  const inboxAcceptPerson = async (id: string) => { try { await api.personSuggestAccept(id); await refreshAfterAccept(); } catch (e: any) { setSyncErr('采纳失败：' + e.message); } };
  const inboxRejectPerson = async (id: string) => { try { await api.personSuggestReject(id); await loadInbox(); } catch (e: any) { setSyncErr('忽略失败：' + e.message); } };
  const inboxAcceptProposal = async (id: string, overrideValue?: string) => { try { await api.proposalAccept(id, overrideValue); await refreshAfterAccept(); } catch (e: any) { setSyncErr('采纳失败：' + e.message); } };
  const inboxRejectProposal = async (id: string) => { try { await api.proposalReject(id); await loadInbox(); } catch (e: any) { setSyncErr('忽略失败：' + e.message); } };

  if (booting) return <div className="boot">加载中…</div>;
  if (!auth) return <Auth onAuthed={onAuthed} />;

  // ── Hub ──
  if (!account) {
    return (
      <>
        <CustomerHub
          accounts={state.accounts} onOpen={openAccount} onCreate={createAccount} onLoadDemo={loadDemo}
          onDeleteAccount={(id) => act({ type: 'DELETE_ACCOUNT', accId: id })}
          tenantName={auth.tenant.name} userName={auth.user.name} plan={auth.tenant.plan}
          onOpenTeam={() => setTeamOpen(true)} onLogout={logout} onOpenAiSettings={() => setAiSettingsOpen(true)}
          theme={theme} onToggleTheme={toggleTheme} onOpenHelp={() => setHelpOpen(true)}
          onOpenMcpAccess={() => setMcpAccessOpen(true)}
          onOpenIntel={() => setIntelOpen(true)}
          onOpenInbox={() => setInboxOpen(true)} inboxCount={inbox.total}
        />
        {syncErr && <div className="sync-toast">{syncErr}</div>}
        {inboxOpen && <InboxPanel rels={inbox.rels} persons={inbox.persons} proposals={inbox.proposals} accounts={state.accounts} onAccept={inboxAcceptRel} onReject={inboxRejectRel} onAcceptPerson={inboxAcceptPerson} onRejectPerson={inboxRejectPerson} onAcceptProposal={inboxAcceptProposal} onRejectProposal={inboxRejectProposal} onClose={() => setInboxOpen(false)} />}
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
        {helpOpen && <HelpManual onClose={() => setHelpOpen(false)} />}
        {mcpAccessOpen && <McpAccess onClose={() => setMcpAccessOpen(false)} />}
        <Footer />
      </>
    );
  }

  const drawerPerson = account.persons.find((p) => p.id === drawerPersonId) ?? null;
  const drawerRole = opp?.roles.find((r) => r.personId === drawerPersonId);
  const drawerBis = opp?.bis.filter((b) => b.personId === drawerPersonId) ?? [];
  const drawerUcvs = (opp?.ucvs ?? []).filter((u) => drawerBis.some((b) => b.id === u.targetBiId));
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
      {view === 'wall' && !immersive && (isMobile ? (
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
            {view === 'wall' && !immersive && (
              <div className="module-top wall-top">
                {!isMobile && <LayerTabs visible={visibleLayers} onToggle={toggleLayer} />}
                {!isMobile && (<>
                  <button className="btn ghost xs" onClick={() => setMdDocOpen(true)} title="客户档案 / 商机档案 / 拜访记录（.md 文档）">📋 作战档案</button>
                  <button className="btn ghost xs" onClick={() => setSuggestOpen(true)}>📥 收件箱{suggestions.length + personSuggs.length > 0 ? ` (${suggestions.length + personSuggs.length})` : ''}</button>
                  <button className="btn ghost xs" onClick={() => setReportOpen(true)}>📊 报表</button>
                  <button className="btn ghost xs" onClick={() => setHelpOpen(true)}>❓ 帮助</button>
                  <span className="mt-heartbeat" style={{ marginLeft: 'auto' }} title="AI 后台持续监测：荐关系 / 局势 / 缺口">● 监测中</span>
                </>)}
                {isMobile && (<>
                  <OverflowMenu align="left" label={`▾ 层级 (${visibleLayers.size})`}
                    items={(['L1', 'L2', 'L3', 'L4'] as Layer[]).map((l) => ({ label: LAYER_LABEL[l], active: visibleLayers.has(l), onClick: () => toggleLayer(l) }))} />
                  <OverflowMenu align="left" label="⋯ 操作" items={[
                    { label: '📋 作战档案', onClick: () => setMdDocOpen(true) },
                    { label: '📥 收件箱', badge: suggestions.length + personSuggs.length > 0 ? String(suggestions.length + personSuggs.length) : undefined, onClick: () => setSuggestOpen(true) },
                    { label: '📊 报表', onClick: () => setReportOpen(true) },
                    { label: '❓ 帮助', onClick: () => setHelpOpen(true) },
                  ]} />
                </>)}
                <button className="theme-toggle mt-theme" onClick={toggleTheme} title={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}>{theme === 'dark' ? '☀️' : '🌙'}</button>
              </div>
            )}
            <>
            <Canvas account={account} opp={opp} visibleLayers={visibleLayers}
              selectedId={selectedId} selectedEdgeId={selectedEdgeId}
              onSelectPerson={selectPerson} onSelectEdge={selectEdge}
              onOpenPerson={openPerson} onOpenEdge={openEdge}
              onMovePerson={(id, x, y) => act({ type: 'MOVE_PERSON', accId: account.id, personId: id, x, y })}
              onAddPersonAt={addPersonAt} onAddConnectedNode={addConnectedNode} onConnect={connectNodes}
              onUpdateEdge={updateEdge} onDeleteEdge={deleteEdgeById}
              onUpdatePerson={updatePerson} onDeletePerson={deletePerson}
              immersive={immersive} onToggleImmersive={toggleImmersive} secondTapOpens={true}
              suggestions={suggestions} />
            {!immersive && breakdown && (
              <DeliberationDock account={account} opp={opp} breakdown={breakdown} dispatch={act}
                selectedPersonId={selectedId} onSelectPerson={selectPerson} />
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

      {drawerPerson && opp && (
        <DetailDrawer accId={account.id} oppId={opp.id} person={drawerPerson} oppRole={drawerRole}
          bis={drawerBis} ucvs={drawerUcvs} dispatch={act} onClose={() => setDrawerPersonId(null)} />
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
      {intelOpen && (
        <IntelCapture account={account} opportunity={opp}
          onClose={() => setIntelOpen(false)}
          onDone={async () => { try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 静默：保存已成功，仅刷新失败 */ } }} />
      )}
      {personFormOpen && <PersonForm onCreate={addPerson} onClose={() => setPersonFormOpen(false)} />}
      {teamOpen && <TeamBilling role={auth.user.role} onClose={() => setTeamOpen(false)} />}
      {aiSettingsOpen && <AiSettings role={auth.user.role} onClose={() => setAiSettingsOpen(false)} />}
      {reportOpen && opp && (
        <ReportPanel account={account} opp={opp} onClose={() => setReportOpen(false)} />
      )}
      {helpOpen && <HelpManual onClose={() => setHelpOpen(false)} />}
      {mcpAccessOpen && <McpAccess onClose={() => setMcpAccessOpen(false)} />}
      {gapsOpen && account && opp && breakdown && (
        <GapCards account={account} opp={opp} dispatch={act} onClose={() => setGapsOpen(false)} />
      )}
      {suggestOpen && (
        <SuggestionPanel suggestions={suggestions} generating={generating}
          onRegenerate={generateSuggestions} onAccept={acceptSuggestion} onReject={rejectSuggestion}
          personSuggs={personSuggs} onAcceptPerson={acceptPersonSugg} onRejectPerson={rejectPersonSugg}
          onClose={() => setSuggestOpen(false)} />
      )}
      {syncErr && <div className="sync-toast">{syncErr}</div>}
      {undoHint && <div className="undo-toast">{undoHint}</div>}
    </div>
  );
}
