import { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import type { Layer, Role, CustomerType, Edge, Person } from './types';
import { LAYER_LABEL } from './types';
import { reducer, newAccount, newPerson, uid, type Action } from './store';
import { api, type AuthResult, type Suggestion, type PersonSuggestion } from './api';
import { scoreFromDomain } from './lib/g64111';
import { usePersistentState, useTheme, useViewport } from './ui';
import { Auth } from './components/Auth';
import { CustomerHub } from './components/CustomerHub';
import { Sidebar } from './components/Sidebar';
import { LayerTabs } from './components/LayerTabs';
import { Canvas } from './components/Canvas';
import { ViewTabs, type CustomerView } from './components/ViewTabs';
import { DealPlanner } from './components/DealPlanner';
import { DetailDrawer } from './components/DetailDrawer';
import { EdgeDrawer } from './components/EdgeDrawer';
import { WinTendencyPanel } from './components/WinTendencyPanel';
import { OpportunityForm } from './components/OpportunityForm';
import { CustomerProfile } from './components/CustomerProfile';
import { IntelCapture } from './components/IntelCapture';
import { NewOpportunityDialog } from './components/NewOpportunityDialog';
import { nextFreeSlot } from './lib/layout';
import { PersonForm } from './components/PersonForm';
import { TeamBilling } from './components/TeamBilling';
import { AiSettings } from './components/AiSettings';
import { StrategyConsole } from './components/StrategyConsole';
import { SuggestionPanel } from './components/SuggestionPanel';
import { EnrichPanel } from './components/EnrichPanel';
import { ReportPanel } from './components/ReportPanel';
import { HelpManual } from './components/HelpManual';
import { McpAccess } from './components/McpAccess';
import { OverflowMenu } from './components/OverflowMenu';
import { Footer } from './components/Footer';

export default function App() {
  const [state, dispatch] = useReducer(reducer, { accounts: [] });
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [booting, setBooting] = useState(true);
  const [syncErr, setSyncErr] = useState('');

  const [accId, setAccId] = useState<string | null>(null);
  const [oppId, setOppId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [layer, setLayer] = useState<Layer>('L1');
  const [oppFormOpen, setOppFormOpen] = useState(false);
  const [personFormOpen, setPersonFormOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [intelOpen, setIntelOpen] = useState(false);
  const [newOppOpen, setNewOppOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [personSuggs, setPersonSuggs] = useState<PersonSuggestion[]>([]);
  const [generating, setGenerating] = useState(false);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [mcpAccessOpen, setMcpAccessOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState('jianghu.sidebarCollapsed', false);
  const [winCollapsed, setWinCollapsed] = usePersistentState('jianghu.winCollapsed', false);
  const [view, setView] = usePersistentState<CustomerView>('jianghu.customerView', 'wall'); // 客户级镜头：关系地图 / 商机策划
  const [theme, toggleTheme] = useTheme();
  // 画布选中模型：单击=选中(节点出锚点/连线出控制点)，双击=打开右侧栏
  const [drawerPersonId, setDrawerPersonId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [drawerEdgeId, setDrawerEdgeId] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [winMobileCollapsed, setWinMobileCollapsed] = usePersistentState('jianghu.winMobileCollapsed', true);
  const [immersive, setImmersive] = useState(false);
  const { isMobile } = useViewport();

  // 全屏「只看白板」：隐藏所有 UI + 调用原生 Fullscreen（隐藏浏览器栏，桌面/安卓支持；iOS Safari 非视频不支持，则仅隐藏本应用 UI）
  const toggleImmersive = useCallback(() => {
    setImmersive((cur) => {
      const next = !cur;
      try {
        if (next) document.documentElement.requestFullscreen?.();
        else if (document.fullscreenElement) document.exitFullscreen?.();
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
      } catch { api.setToken(null); } finally { setBooting(false); }
    })();
  }, []);

  const onAuthed = async (res: AuthResult) => {
    const st = await api.getState();
    dispatch({ type: 'HYDRATE', accounts: st.accounts });
    setAuth(res);
  };
  const logout = () => { api.setToken(null); setAuth(null); setAccId(null); setSelectedId(null); dispatch({ type: 'HYDRATE', accounts: [] }); };

  // 乐观本地更新 + 云端持久化
  const act = useCallback(async (action: Action) => {
    dispatch(action);
    try { await api.mutate(action); setSyncErr(''); }
    catch (e: any) { setSyncErr('云端保存失败：' + e.message); }
  }, []);

  const account = state.accounts.find((a) => a.id === accId) ?? null;
  const opp = account?.opportunities.find((o) => o.id === oppId) ?? null;
  const breakdown = useMemo(() => (account && opp ? scoreFromDomain(account, opp) : null), [account, opp]);
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
    setAccId(id); setOppId(a?.opportunities[0]?.id ?? null); setSelectedId(null); setLayer('L1');
  };
  const createAccount = (name: string, ctype: CustomerType) => {
    const a = newAccount(name, ctype);
    act({ type: 'ADD_ACCOUNT', account: a });
    setAccId(a.id); setOppId(null); setSelectedId(null); setLayer('L1');
  };
  const loadDemo = async () => {
    setSyncErr('');
    const prev = new Set(state.accounts.map((a) => a.id));
    try {
      await api.demo();
      const st = await api.getState();
      dispatch({ type: 'HYDRATE', accounts: st.accounts });
      const added = st.accounts.find((a) => !prev.has(a.id)) ?? st.accounts[st.accounts.length - 1];
      if (added) { setAccId(added.id); setOppId(added.opportunities[0]?.id ?? null); setSelectedId(null); setLayer('L1'); }
    } catch (e: any) { setSyncErr('载入示例失败：' + e.message); }
  };
  const addOpp = () => { if (account) setNewOppOpen(true); };
  const createOpportunity = async (params: { name: string; fromOppId?: string; personIds: string[]; withEdges: boolean }) => {
    if (!account) return;
    setNewOppOpen(false);
    try {
      const { opportunityId } = await api.cloneOpportunity({ accountId: account.id, ...params });
      const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts });
      setOppId(opportunityId); setSelectedId(null); setLayer('L1');
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
  const selectPerson = (id: string | null) => { setSelectedId(id); setSelectedEdgeId(null); };
  const openPerson = (id: string) => { setSelectedId(id); setSelectedEdgeId(null); setDrawerEdgeId(null); setDrawerPersonId(id); };
  const selectEdge = (id: string | null) => { setSelectedEdgeId(id); setSelectedId(null); };
  const openEdge = (id: string) => { setDrawerPersonId(null); setDrawerEdgeId(id); };
  // 切客户/商机时清空一切选中
  useEffect(() => { setSelectedId(null); setSelectedEdgeId(null); setDrawerPersonId(null); setDrawerEdgeId(null); }, [accId, oppId]);

  const addPersonAt = (x: number, y: number): string => {
    if (!account) return '';
    const p = newPerson('新成员', '', x, y, false);
    act({ type: 'ADD_PERSON', accId: account.id, person: p });
    if (opp?.memberScoped) act({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opp.id, personId: p.id });
    setSelectedId(p.id); setSelectedEdgeId(null);
    return p.id;
  };
  const makeEdge = (source: string, target: string): Edge => ({
    id: uid('e'), source, target, layer, label: '', color: '#94a3b8', style: 'solid', directed: true, origin: 'manual',
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

  // ── 企查查自动建图：导入发现的关键人为节点（带溯源日志，待验证）──
  const importPersons = (persons: { name: string; title: string; source: string }[]) => {
    if (!account) return;
    const occupied = account.persons.filter((p) => !p.isCompetitor).map((p) => ({ x: p.x, y: p.y }));
    const today = new Date().toISOString().slice(0, 10);
    const label = (src: string) => (src === 'qcc' ? '企查查导入' : src === 'web' ? '🔍 搜索引擎·待核实' : src === 'ai' ? 'AI 推测·待核实' : '角色待补齐');
    for (const dp of persons) {
      const { x, y } = nextFreeSlot(occupied); occupied.push({ x, y });
      const p = newPerson(dp.name, dp.title, x, y, false);
      p.logs = [{ date: today, content: `📥 ${label(dp.source)}（${account.name}）`, visibility: 'team' }];
      act({ type: 'ADD_PERSON', accId: account.id, person: p });
      if (opp?.memberScoped) act({ type: 'ADD_OPP_MEMBER', accId: account.id, oppId: opp.id, personId: p.id });
    }
  };

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
        />
        {syncErr && <div className="sync-toast">{syncErr}</div>}
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
                setAccId(id); setOppId(a?.opportunities[0]?.id ?? null); setSelectedId(null); setLayer('L1');
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
      account={account} currentOppId={oppId} onSelectOpp={(id) => { setOppId(id); selectPerson(null); setMobileNavOpen(false); }}
      selectedPersonId={selectedId} onSelectPerson={(id) => { openPerson(id); setMobileNavOpen(false); }}
      onBack={() => { setAccId(null); selectPerson(null); }} onAddOpp={addOpp} onDeleteOpp={deleteOpp}
      onAddPerson={() => setPersonFormOpen(true)} roleByPerson={roleByPerson}
      onCollapse={() => (isMobile ? setMobileNavOpen(false) : setSidebarCollapsed(true))}
      theme={theme} onToggleTheme={toggleTheme}
    />
  );

  return (
    <div className={`app-shell${isMobile ? ' mobile' : ''}${immersive ? ' immersive' : ''}`}>
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
            {!immersive && <div className="canvas-top">
              {/* 桌面：操作栏在上、层级切换在下（移动端二者 CSS 隐藏，改用下方两个下拉） */}
              <div className="maintoolbar">
                <span className="mt-name">{opp.name}</span>
                <ViewTabs view={view} onChange={setView} />
                <button className="btn cta xs" onClick={() => setIntelOpen(true)}>🎙️ 录入情报</button>
                <button className="btn ghost xs" onClick={() => setOppFormOpen(true)}>编辑商机</button>
                <button className="btn ghost xs" onClick={() => setProfileOpen(true)}>📇 客户档案</button>
                <button className="btn ghost xs" onClick={() => setEnrichOpen(true)}>🔍 搜索情报</button>
                <button className="btn ghost xs" onClick={() => setSuggestOpen(true)}>🔮 荐关系{suggestions.length + personSuggs.length > 0 ? ` (${suggestions.length + personSuggs.length})` : ''}</button>
                <button className="btn ghost xs" onClick={() => setReportOpen(true)}>📊 报表</button>
                <button className="btn ghost xs" onClick={() => setMcpAccessOpen(true)}>🔌 接入 AI</button>
                <button className="btn ghost xs" onClick={() => setHelpOpen(true)}>❓ 帮助</button>
                <button className="btn primary xs" onClick={() => setConsoleOpen(true)}>🧠 AI 推演</button>
              </div>
              {view === 'wall' && <LayerTabs layer={layer} onChange={setLayer} />}
              {/* 移动端：层级下拉（左）+ ⋯操作下拉（右），一行 */}
              {view === 'wall' && isMobile && (
                <OverflowMenu align="left" label={`▾ ${LAYER_LABEL[layer]}`}
                  items={(['L1', 'L2', 'L3', 'L4'] as Layer[]).map((l) => ({ label: LAYER_LABEL[l], active: l === layer, onClick: () => setLayer(l) }))} />
              )}
              {isMobile && (
                <OverflowMenu align="left" label="⋯ 操作" items={[
                  { label: '🧠 AI 推演', primary: true, onClick: () => setConsoleOpen(true) },
                  { label: '🎙️ 录入情报', primary: true, onClick: () => setIntelOpen(true) },
                  { label: '✏️ 编辑商机', onClick: () => setOppFormOpen(true) },
                  { label: '📇 客户档案', onClick: () => setProfileOpen(true) },
                  { label: '🔍 搜索情报', onClick: () => setEnrichOpen(true) },
                  { label: '🔮 荐关系', badge: suggestions.length + personSuggs.length > 0 ? String(suggestions.length + personSuggs.length) : undefined, onClick: () => setSuggestOpen(true) },
                  { label: '📊 报表', onClick: () => setReportOpen(true) },
                  { label: '🔌 接入 AI', onClick: () => setMcpAccessOpen(true) },
                  { label: '❓ 帮助', onClick: () => setHelpOpen(true) },
                ]} />
              )}
            </div>}
            {view === 'wall' ? (
            <>
            <Canvas account={account} opp={opp} layer={layer}
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
              (isMobile ? winMobileCollapsed : winCollapsed) ? (
                <button className="win-fab" onClick={() => (isMobile ? setWinMobileCollapsed(false) : setWinCollapsed(false))} title="展开趋赢力" aria-label="展开趋赢力">
                  <span className="wf-arr">⌃</span>
                  <span className="wf-pct" style={{ color: breakdown.total < 0 ? '#f87171' : undefined }}>{Math.round(breakdown.percent * 100)}%</span>
                  <span className="wf-label">趋赢力</span>
                </button>
              ) : (
                <WinTendencyPanel breakdown={breakdown} collapsed={false} grabber
                  onToggle={() => (isMobile ? setWinMobileCollapsed(true) : setWinCollapsed(true))} />
              )
            )}
            </>
            ) : (
              <DealPlanner account={account} dispatch={act} />
            )}
          </>
        ) : (
          <div className="no-opp">
            <div className="no-opp-emoji">🎯</div>
            <div className="no-opp-t">这个客户还没有商机</div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn primary" onClick={addOpp}>＋ 新建商机</button>
              <button className="btn ghost" onClick={() => setProfileOpen(true)}>📇 客户档案</button>
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
          onSave={(patch) => act({ type: 'UPDATE_ACCOUNT', accId: account.id, patch })} />
      )}
      {intelOpen && (
        <IntelCapture account={account} opportunity={opp}
          onClose={() => setIntelOpen(false)}
          onDone={async () => { try { const st = await api.getState(); dispatch({ type: 'HYDRATE', accounts: st.accounts }); } catch { /* 静默：保存已成功，仅刷新失败 */ } }} />
      )}
      {personFormOpen && <PersonForm onCreate={addPerson} onClose={() => setPersonFormOpen(false)} />}
      {teamOpen && <TeamBilling role={auth.user.role} onClose={() => setTeamOpen(false)} />}
      {consoleOpen && opp && breakdown && (
        <StrategyConsole account={account} opp={opp} breakdown={breakdown}
          onClose={() => setConsoleOpen(false)} onOpenSettings={() => setAiSettingsOpen(true)} />
      )}
      {aiSettingsOpen && <AiSettings role={auth.user.role} onClose={() => setAiSettingsOpen(false)} />}
      {enrichOpen && account && (
        <EnrichPanel accountName={account.name} role={auth.user.role} onImport={importPersons} onClose={() => setEnrichOpen(false)} />
      )}
      {reportOpen && opp && (
        <ReportPanel account={account} opp={opp} onClose={() => setReportOpen(false)} />
      )}
      {helpOpen && <HelpManual onClose={() => setHelpOpen(false)} />}
      {mcpAccessOpen && <McpAccess onClose={() => setMcpAccessOpen(false)} />}
      {suggestOpen && (
        <SuggestionPanel suggestions={suggestions} generating={generating}
          onRegenerate={generateSuggestions} onAccept={acceptSuggestion} onReject={rejectSuggestion}
          personSuggs={personSuggs} onAcceptPerson={acceptPersonSugg} onRejectPerson={rejectPersonSugg}
          onClose={() => setSuggestOpen(false)} />
      )}
      {syncErr && <div className="sync-toast">{syncErr}</div>}
    </div>
  );
}
