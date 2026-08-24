import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Layer, Role, CustomerType, Edge, Person } from './types';
import { LAYER_LABEL } from './types';
import {
  reducer, computeInverse, injectBaseVersion, alignVersionAfterRetry, invalidateHistory, transitionHistory,
  newAccount, newPerson, uid, type Action, type HistoryItem, type HistoryTransitionLock,
} from './store';
import { api, ApiError, isConfirmedAuthFailure, newIdempotencyKey, toApiError, type AuthResult, type Suggestion } from './api';
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
import { MdDocPanel } from './components/MdDocPanel';
import { NewOpportunityDialog } from './components/NewOpportunityDialog';
import { layoutSkeleton, type SkeletonRole } from './data/skeletons';
import { parsePath, buildPath, resolveRoute, type RouteTarget } from './lib/router';
import { computeGaps } from './lib/gaps';
import { needsYouByAccount } from './lib/today';
import { computeG64111Today } from './lib/g64111Today';
import { GapCards } from './components/GapCards';
import { nextFreeSlot } from './lib/layout';
import type { InboxBatchItem } from './components/InboxPanel';
import { RecordingPanel } from './components/RecordingPanel';
import { OverflowMenu } from './components/OverflowMenu';
import { OrientationGate } from './components/OrientationGate';
import { Footer } from './components/Footer';
import { SyncStatus } from './components/SyncStatus';
import { createCommitScheduler } from './lib/sync/commitScheduler';
import { createMutationCoordinator, createMutationExecutionGate, entityKeyForAction } from './lib/sync/mutationCoordinator';
import { localYmd } from './lib/dateYmd';
import { clearStableBatchItemKey, runBatchWithProgress, stableBatchItemKey, type StableBatchKeyCache } from './lib/reviewBatch';
import { capabilityPolicyAllows, type ProductAccess } from '@jianghu/domain-contracts';
import { GlobalDialogs, type GlobalInboxProps } from './components/GlobalDialogs';
import { CommercialShell } from './components/CommercialShell';
import { CRM_CONTEXT_REFRESH_INTERVAL_MS, type CrmContextPanelState } from './components/CrmContextPages';
import { InternalRootAdapter } from './components/InternalRootAdapter';
import { resolveProductRoute } from './lib/productRoutes';
import { selectAppRootSurface, shouldLoadLegacyState } from './lib/appProductShell';
import {
  appShellUiReducer,
  createInitialAppShellUiState,
  type SettableGlobalDialog,
  type RepairTarget,
} from './lib/appShellUi';
import {
  clearSessionUi,
  beginLatestSessionRequest,
  commitSessionValue,
  createLatestRequestGuard,
  createSessionGuard,
  createSessionLease,
  emptyInbox,
  runSessionRequest,
  type SessionInbox,
  type SessionTicket,
} from './lib/sessionLifecycle';

const INVALID_PRODUCT_CONFIGURATION_MESSAGE = '产品能力配置无效，请联系部署管理员。';

export default function App() {
  const [state, dispatch] = useReducer(reducer, { accounts: [] });
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [commercialContextState, setCommercialContextState] = useState<CrmContextPanelState>({ status: 'loading' });
  const [commercialPath, setCommercialPath] = useState(window.location.pathname);
  const [booting, setBooting] = useState(true);
  const [syncErr, setSyncErr] = useState('');
  const [undoHint, setUndoHint] = useState('');
  const [cloudDiscardRevisions, setCloudDiscardRevisions] = useState<Record<string, number>>({});
  const coordinatorResetRef = useRef<() => void>(() => undefined);
  const executionGateResetRef = useRef<() => void>(() => undefined);
  const schedulerResetRef = useRef<() => void>(() => undefined);
  const schedulerCancelRef = useRef<(entityKey: string) => void>(() => undefined);
  const stateRef = useRef(state);
  const undoStack = useRef<HistoryItem[]>([]);
  const redoStack = useRef<HistoryItem[]>([]);
  const historyLock = useRef<HistoryTransitionLock>({ busy: false });
  const historyRevision = useRef(0);
  const historyRecovery = useRef<'refreshed' | 'refresh-failed'>('refreshed');
  const inboxBatchKeys = useRef<StableBatchKeyCache>(new Map());
  const sessionGuard = useRef(createSessionGuard());
  const crmContextRequestGuard = useRef(createLatestRequestGuard());
  const [appShellUi, appShellUiDispatch] = useReducer(appShellUiReducer, undefined, createInitialAppShellUiState);
  const resetCommercialContext = useCallback(() => {
    crmContextRequestGuard.current.invalidate();
    setCommercialContextState({ status: 'loading' });
  }, []);
  const setGlobalDialogOpen = useCallback((dialog: SettableGlobalDialog, open: boolean) => {
    appShellUiDispatch({ type: 'SET_DIALOG', dialog, open });
  }, []);
  const setRepairTarget = useCallback((target: RepairTarget | null) => {
    appShellUiDispatch({ type: 'SET_REPAIR_TARGET', target });
  }, []);
  stateRef.current = state;
  // viewer 角色 = 只读投影（契约 v1.0 §二-1）：编辑/录入控件一律不渲染（非置灰）；视图交互全保留
  const readonly = auth?.user.role === 'viewer';
  const salesWorkspaceEnabled = capabilityPolicyAllows(auth?.product.policy, { entitlement: 'sales.workspace' });
  const g64111Enabled = capabilityPolicyAllows(auth?.product.policy, { entitlement: 'methodology.g64111' });
  const pdeEnabled = capabilityPolicyAllows(auth?.product.policy, { entitlement: 'decision.pde' });

  const [accId, setAccId] = useState<string | null>(null);
  const [oppId, setOppId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleLayers, setVisibleLayers] = useState<Set<Layer>>(() => new Set<Layer>(['L1'])); // 关系层级=点亮/熄灭多选(可层叠)
  const toggleLayer = (l: Layer) => setVisibleLayers((s) => { const n = new Set(s); n.has(l) ? n.delete(l) : n.add(l); if (n.size === 0) n.add(l); return n; });
  const [oppFormOpen, setOppFormOpen] = useState(false);
  const [mdDocOpen, setMdDocOpen] = useState(false);
  const [newOppOpen, setNewOppOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]); // 当前商机的关系候选 → 喂 Canvas 画灰虚线候选边；审核统一走收件箱
  // 审核收件箱（Hub 级聚合，全租户 pending 候选）
  const [inbox, setInbox] = useState<SessionInbox>(emptyInbox);
  const loadInbox = useCallback(async (ticket: SessionTicket) => {
    try {
      await commitSessionValue(sessionGuard.current, ticket, api.inboxList, api.getToken, setInbox);
    } catch { /* 角标失败忽略；下次刷新重试 */ }
  }, []);
  const [gapsOpen, setGapsOpen] = useState(false); // M3 缺口刷卡补分（enrichOpen 随重构删 EnrichPanel 移除）
  // P5 Hub 今日一屏：三源聚合「今日三件事」+ 客户卡「需要你」角标（纯前端零 schema）
  const hubTodayYmd = localYmd(new Date());
  const hubToday = useMemo(
    () => g64111Enabled ? computeG64111Today(state.accounts, inbox.reminders, hubTodayYmd) : [],
    [g64111Enabled, state.accounts, inbox.reminders, hubTodayYmd],
  );
  const hubNeedsYou = useMemo(() => needsYouByAccount(state.accounts, inbox, hubTodayYmd), [state.accounts, inbox, hubTodayYmd]);
  const [selfComputeBusy, setSelfComputeBusy] = useState(false); // 江湖自算·补全干系人 进行中
  const [addIntelOpen, setAddIntelOpen] = useState(false); // 🎧 接入录音（P3 文本入口收敛：口述/对话归坞尾「和地图对话」，AddIntel 容器退役）
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState('jianghu.sidebarCollapsed', false);
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

  // ── Deep link 页面级直链（契约 v1.0 §三-③）：/account/{id}[/opp/{id}]，id 兼容江湖 id / 销售包 externalRef ──
  // 打开时记下目标段；等登录 + 整树 HYDRATE 后再解析落位——未登录先登录、登录后不丢目标（§三-③ 验收）。
  const pendingRoute = useRef<RouteTarget | null>(parsePath(window.location.pathname));
  const applyRoute = useCallback((accounts: { id: string; externalRef?: string; opportunities: { id: string; externalRef?: string }[] }[]) => {
    const t = pendingRoute.current;
    if (!t) return;
    pendingRoute.current = null;
    const r = resolveRoute(accounts as any, t);
    if (r) {
      window.history.replaceState(null, '', buildPath(r.accId, r.oppId)); // 规范化为江湖 id 形式
      setAccId(r.accId); setOppId(r.oppId); setSelectedId(null); setVisibleLayers(new Set(['L1']));
    } else {
      // 数据隔离（§四）：viewer 名下不含该客户时与"不存在"同响应——链接互发打不开
      setSyncErr('🔗 链接指向的客户不存在，或你没有查看权限');
      window.history.replaceState(null, '', '/');
    }
  }, []);

  const applyAuthenticatedRoute = useCallback((product: ProductAccess, accounts: { id: string; externalRef?: string; opportunities: { id: string; externalRef?: string }[] }[]) => {
    if (!product.valid) {
      pendingRoute.current = null;
      setCommercialPath('/today');
      setAccId(null); setOppId(null); setSelectedId(null);
      setSyncErr(INVALID_PRODUCT_CONFIGURATION_MESSAGE);
      return;
    }
    if (product.shell === 'internal_legacy') {
      applyRoute(accounts);
      return;
    }

    if (pendingRoute.current) {
      if (capabilityPolicyAllows(product.policy, { entitlement: 'sales.workspace' })) {
        applyRoute(accounts);
        return;
      }
      pendingRoute.current = null;
      setSyncErr('当前版本未启用复杂销售工作台');
    }

    const route = resolveProductRoute(window.location.pathname, product);
    if (route.denied) setSyncErr('当前版本未启用该能力');
    setCommercialPath(route.canonicalPath);
    if (window.location.pathname !== route.canonicalPath) window.history.replaceState(null, '', route.canonicalPath);
    setAccId(null); setOppId(null); setSelectedId(null);
  }, [applyRoute]);

  const refreshState = useCallback(async (ticket: SessionTicket = sessionGuard.current.capture()) => {
    const result = await runSessionRequest(sessionGuard.current, ticket, api.getState, api.getToken);
    if (!result.current) return null;
    stateRef.current = result.value;
    dispatch({ type: 'HYDRATE', accounts: result.value.accounts });
    return result.value;
  }, []);
  const refreshCrmContext = useCallback(async (ticket: SessionTicket = sessionGuard.current.capture()) => {
    const request = beginLatestSessionRequest(
      sessionGuard.current,
      ticket,
      api.getToken,
      crmContextRequestGuard.current,
    );
    if (request === null) return null;
    setCommercialContextState((current) => current.status === 'ready'
      ? { ...current, refreshing: true, refreshError: null }
      : { status: 'loading' });
    try {
      const result = await runSessionRequest(sessionGuard.current, ticket, api.crmContext, api.getToken);
      if (!result.current || !crmContextRequestGuard.current.isCurrent(request)) return null;
      setCommercialContextState({ status: 'ready', snapshot: result.value, refreshing: false, refreshError: null });
      return result.value;
    } catch (cause) {
      if (!sessionGuard.current.isCurrent(ticket, api.getToken())
        || !crmContextRequestGuard.current.isCurrent(request)) return null;
      const message = toApiError(cause).message;
      setCommercialContextState((current) => current.status === 'ready'
        ? { ...current, refreshing: false, refreshError: message }
        : { status: 'error', message });
      throw cause;
    }
  }, []);
  const loadProductData = useCallback(async (product: ProductAccess, ticket: SessionTicket) => {
    if (!product.valid) {
      if (!sessionGuard.current.isCurrent(ticket, api.getToken())) return null;
      stateRef.current = { accounts: [] };
      dispatch({ type: 'HYDRATE', accounts: [] });
      resetCommercialContext();
      return { accounts: [] };
    }
    const needsLegacyState = shouldLoadLegacyState(product);
    const [legacyState] = await Promise.all([
      needsLegacyState ? refreshState(ticket) : Promise.resolve({ accounts: [] }),
      product.shell === 'commercial' ? refreshCrmContext(ticket) : Promise.resolve(null),
    ]);
    if (!sessionGuard.current.isCurrent(ticket, api.getToken())) return null;
    if (needsLegacyState && !legacyState) return null;
    if (!needsLegacyState) {
      stateRef.current = { accounts: [] };
      dispatch({ type: 'HYDRATE', accounts: [] });
    }
    if (product.shell !== 'commercial') resetCommercialContext();
    return legacyState;
  }, [refreshCrmContext, refreshState, resetCommercialContext]);
  const renderedSessionTicket = sessionGuard.current.capture();
  const sessionLease = useMemo(
    () => createSessionLease(sessionGuard.current, renderedSessionTicket, api.getToken),
    [renderedSessionTicket.generation, renderedSessionTicket.token],
  );
  const refreshRenderedState = useCallback(() => {
    if (!sessionLease.isCurrent()) return Promise.resolve(null);
    return refreshState(renderedSessionTicket);
  }, [refreshState, renderedSessionTicket, sessionLease]);

  const restoreSession = useCallback(async () => {
    const token = api.getToken();
    if (!token) {
      sessionGuard.current.begin(null);
      setInbox(emptyInbox);
      resetCommercialContext();
      setBooting(false);
      return;
    }
    const sessionTicket = sessionGuard.current.begin(token);
    setInbox(emptyInbox);
    setBooting(true);
    setSyncErr('');
    try {
      const meResult = await runSessionRequest(sessionGuard.current, sessionTicket, api.me, api.getToken);
      if (!meResult.current) return;
      const st = await loadProductData(meResult.value.product, sessionTicket);
      if (!st) return;
      const me = meResult.value;
      setAuth({ token, user: me.user, tenant: me.tenant, product: me.product });
      applyAuthenticatedRoute(me.product, st.accounts);
      if (me.user.role !== 'viewer' && capabilityPolicyAllows(me.product.policy, { entitlement: 'sales.workspace' })) void loadInbox(sessionTicket);
    } catch (error) {
      if (!sessionGuard.current.isCurrent(sessionTicket, api.getToken())) return;
      if (isConfirmedAuthFailure(error)) {
        api.setToken(null);
        sessionGuard.current.begin(null);
        setInbox(emptyInbox);
        setAuth(null);
        resetCommercialContext();
        stateRef.current = { accounts: [] };
        dispatch({ type: 'HYDRATE', accounts: [] });
        setBooting(false);
      } else {
        setSyncErr('暂时无法连接云端，已保留登录状态，请稍后重试。');
      }
    } finally {
      if (sessionGuard.current.isCurrent(sessionTicket, api.getToken())) setBooting(false);
    }
  }, [applyAuthenticatedRoute, loadInbox, loadProductData, resetCommercialContext]);
  // 启动：有 token 则恢复会话 + 拉取云端数据
  useEffect(() => { void restoreSession(); }, [restoreSession]);

  useEffect(() => {
    if (!auth?.product.valid || auth.product.shell !== 'commercial') return;
    const refresh = () => {
      const ticket = sessionGuard.current.capture();
      void refreshCrmContext(ticket).then((snapshot) => {
        if (snapshot && sessionGuard.current.isCurrent(ticket, api.getToken())) {
          setSyncErr((current) => current.startsWith('客户与事项刷新失败：') ? '' : current);
        }
      }).catch((cause) => {
        if (sessionGuard.current.isCurrent(ticket, api.getToken())) {
          setSyncErr(`客户与事项刷新失败：${toApiError(cause).message}`);
        }
      });
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, CRM_CONTEXT_REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [auth?.product.shell, auth?.product.valid, auth?.token, refreshCrmContext]);

  const onAuthed = async (res: AuthResult) => {
    const sessionTicket = sessionGuard.current.begin(res.token);
    setInbox(emptyInbox);
    const st = await loadProductData(res.product, sessionTicket);
    if (!st) return;
    setAuth(res);
    applyAuthenticatedRoute(res.product, st.accounts);
    if (res.user.role !== 'viewer' && capabilityPolicyAllows(res.product.policy, { entitlement: 'sales.workspace' })) void loadInbox(sessionTicket);
  };
  const logout = useCallback(() => {
    coordinatorResetRef.current();
    executionGateResetRef.current();
    schedulerResetRef.current();
    invalidateHistory(undoStack.current, redoStack.current);
    historyRevision.current += 1;
    historyRecovery.current = 'refreshed';
    const clearedUi = clearSessionUi(inboxBatchKeys.current);
    sessionGuard.current.begin(null);
    appShellUiDispatch({ type: 'RESET_SESSION_TRANSIENT' });
    setInbox(clearedUi.inbox);
    api.setToken(null); setAuth(null); resetCommercialContext(); setAccId(null); setOppId(null); setSelectedId(null);
    stateRef.current = { accounts: [] };
    dispatch({ type: 'HYDRATE', accounts: [] });
    setSyncErr(clearedUi.syncErr);
    setUndoHint('');
    setSuggestions([]);
    setSelfComputeBusy(false);
    setOppFormOpen(false); setMdDocOpen(false); setNewOppOpen(false); setGapsOpen(false); setAddIntelOpen(false);
    setSelectedEdgeId(null); setDrawerEdgeId(null); setOpenActionId(null);
    setCloudDiscardRevisions({});
    setBooting(false);
    pendingRoute.current = null;
    setCommercialPath('/today');
    window.history.replaceState(null, '', '/'); // 登出清 URL，避免登录页残留目标路径造成误解（重新登录会重新解析）
  }, [resetCommercialContext]);
  useEffect(() => api.onUnauthorized(() => logout()), [logout]);

  // 选中客户/商机 ↔ URL 双向同步：导航 pushState 入历史；popstate（前进/后退）解析回状态并规范化 URL
  useEffect(() => {
    if (!auth?.product.valid || pendingRoute.current) return; // 未登录/配置无效不动 URL；待解析目标不被覆盖
    if (auth.product.shell === 'commercial' && !accId) return;
    const path = buildPath(accId, oppId);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }, [accId, oppId, auth]);
  useEffect(() => {
    const onPop = () => {
      const t = parsePath(window.location.pathname);
      if (auth?.product.valid && auth.product.shell === 'commercial' && !t) {
        const route = resolveProductRoute(window.location.pathname, auth.product);
        if (route.denied) setSyncErr('当前版本未启用该能力');
        if (window.location.pathname !== route.canonicalPath) window.history.replaceState(null, '', route.canonicalPath);
        setCommercialPath(route.canonicalPath);
        setAccId(null); setOppId(null); setSelectedId(null);
        return;
      }
      if (!t) { setAccId(null); setOppId(null); setSelectedId(null); return; }
      if (auth?.product.valid && auth.product.shell === 'commercial' && !capabilityPolicyAllows(auth.product.policy, { entitlement: 'sales.workspace' })) {
        const route = resolveProductRoute('/today', auth.product);
        window.history.replaceState(null, '', route.canonicalPath);
        setCommercialPath(route.canonicalPath);
        setSyncErr('当前版本未启用复杂销售工作台');
        setAccId(null); setOppId(null); setSelectedId(null);
        return;
      }
      const r = resolveRoute(stateRef.current.accounts, t);
      if (r) {
        window.history.replaceState(null, '', buildPath(r.accId, r.oppId)); // 先规范化，同步 effect 将 no-op
        setAccId(r.accId); setOppId(r.oppId); setSelectedId(null);
      } else {
        window.history.replaceState(null, '', '/');
        setAccId(null); setOppId(null); setSelectedId(null);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [auth]);
  const discardToCloudState = useCallback(async (entityKey?: string) => {
    if (!sessionLease.isCurrent()) return;
    const refreshed = await refreshState(renderedSessionTicket);
    if (!refreshed) return;
    invalidateHistory(undoStack.current, redoStack.current);
    historyRevision.current += 1;
    if (entityKey) {
      setCloudDiscardRevisions((revisions) => ({
        ...revisions,
        [entityKey]: (revisions[entityKey] ?? 0) + 1,
      }));
    }
  }, [refreshState, renderedSessionTicket, sessionLease]);
  const coordinator = useMemo(() => createMutationCoordinator(async (action) => {
    await api.mutate(action);
    setSyncErr('');
  }, {
    // 用户选“保留我的值”时只读云端版本号重建 action，不 HYDRATE 覆盖屏幕上的本地草稿。
    prepareConflictRetry: async (action) => {
      const ticket = sessionGuard.current.capture();
      const result = await runSessionRequest(sessionGuard.current, ticket, api.getState, api.getToken);
      if (!result.current) throw new ApiError({ code: 'session_reset', message: '会话已切换', retryable: false });
      return injectBaseVersion(result.value, action);
    },
    onRetrySuccess: (_originalAction, action, delta) => {
      const aligned = alignVersionAfterRetry(stateRef.current, action, delta);
      if (aligned !== stateRef.current) {
        stateRef.current = aligned;
        dispatch({ type: 'HYDRATE', accounts: aligned.accounts });
      }
    },
    onCancelDraft: (entityKey) => schedulerCancelRef.current(entityKey),
  }), []);
  coordinatorResetRef.current = coordinator.reset;
  // 入队前从最新本地镜像注入乐观锁版本；coordinator 保证同实体严格串行。
  const applyQueuedAction = useCallback(async (action: Action) => {
    const injected = injectBaseVersion(stateRef.current, action);
    stateRef.current = reducer(stateRef.current, injected);
    dispatch(injected);
    await coordinator.enqueue(entityKeyForAction(injected), injected);
  }, [coordinator]);
  const executionGate = useMemo(() => createMutationExecutionGate(applyQueuedAction), [applyQueuedAction]);
  executionGateResetRef.current = executionGate.reset;
  const commitScheduler = useMemo(
    () => createCommitScheduler((_key, action) => executionGate.run(action)),
    [executionGate],
  );
  schedulerResetRef.current = commitScheduler.reset;
  schedulerCancelRef.current = commitScheduler.cancel;
  const scheduleDraft = useCallback((action: Action, delayMs = 400) => {
    if (!sessionLease.isCurrent()) return;
    commitScheduler.schedule(entityKeyForAction(action), action, { delayMs });
  }, [commitScheduler, sessionLease]);
  const flushDraft = useCallback((action: Action) => {
    if (!sessionLease.isCurrent()) return Promise.resolve();
    return commitScheduler.flush(entityKeyForAction(action));
  }, [commitScheduler, sessionLease]);
  useEffect(() => () => { void commitScheduler.flushAll().catch(() => undefined); }, [commitScheduler]);
  const recoverHistoryFailure = useCallback(async (failedActions: readonly Action[]) => {
    // 批次可能已部分落库；丢弃两端历史，避免下一次撤销重复已成功的子动作。
    invalidateHistory(undoStack.current, redoStack.current);
    historyRevision.current += 1;
    const keys = new Set(failedActions.map(entityKeyForAction));
    for (const key of keys) commitScheduler.cancel(key);
    try {
      const refreshed = await refreshState(renderedSessionTicket);
      if (!refreshed || !sessionLease.isCurrent()) {
        throw new ApiError({ code: 'session_reset', message: '会话已切换', retryable: false });
      }
      historyRecovery.current = 'refreshed';
    } catch (error) {
      if (sessionLease.isCurrent()) historyRecovery.current = 'refresh-failed';
      // 保留 coordinator 的 failed/conflict Action，网络恢复后仍可重试或查看云端。
      throw error;
    }
    if (!sessionLease.isCurrent()) throw new ApiError({ code: 'session_reset', message: '会话已切换', retryable: false });
    for (const key of keys) coordinator.dismiss(key);
  }, [commitScheduler, coordinator, refreshState, renderedSessionTicket, sessionLease]);
  // undo/redo 的失败恢复属于同一批次 barrier；恢复结束前，后续普通写入不会开始。
  const applyBatch = useCallback(
    (actions: readonly Action[]) => executionGate.runBatch(actions, () => recoverHistoryFailure(actions)),
    [executionGate, recoverHistoryFailure],
  );
  // 普通操作真正越过批次 barrier 时，才基于最新 state 计算逆动作并记录历史。
  const actAsync = useCallback((action: Action): Promise<void> => {
    if (!sessionLease.isCurrent()) {
      return Promise.reject(new ApiError({ code: 'session_reset', message: '会话已切换，已忽略旧界面操作', retryable: false }));
    }
    return executionGate.run(action, () => {
      const inv = computeInverse(action, stateRef.current);
      if (inv && inv.length) {
        undoStack.current.push({ redo: [action], undo: inv });
        if (undoStack.current.length > 10) undoStack.current.shift();
      }
      redoStack.current.length = 0;
      historyRevision.current += 1;
    });
  }, [executionGate, sessionLease]);
  const act = useCallback((action: Action) => {
    void actAsync(action).catch(() => { /* SyncStatus 保留失败 action 和重试入口 */ });
  }, [actAsync]);
  const undo = useCallback(async () => {
    const revision = historyRevision.current;
    const result = await transitionHistory(undoStack.current, redoStack.current, 'undo', applyBatch, undefined, {
      lock: historyLock.current,
      canMoveToDestination: () => historyRevision.current === revision,
      canRestoreToSource: () => historyRevision.current === revision,
    });
    if (historyRevision.current !== revision) return;
    if (result === 'empty') { setUndoHint('⊘ 没有可撤销的操作'); return; }
    if (result === 'busy') { setUndoHint('⏳ 撤销/重做正在同步，请稍候'); return; }
    if (result === 'failed') {
      setUndoHint(historyRecovery.current === 'refreshed'
        ? '⚠️ 撤销未完成，已刷新云端并清空旧历史以防重复执行'
        : '⚠️ 撤销未完成且云端刷新失败，失败操作已保留，可稍后重试');
      return;
    }
    setUndoHint(`↶ 已撤销 · 还可撤销 ${undoStack.current.length} 步`);
  }, [applyBatch]);
  const redo = useCallback(async () => {
    const revision = historyRevision.current;
    const result = await transitionHistory(redoStack.current, undoStack.current, 'redo', applyBatch, undefined, {
      lock: historyLock.current,
      canRestoreToSource: () => historyRevision.current === revision,
    });
    if (historyRevision.current !== revision) return;
    if (result === 'empty') { setUndoHint('⊘ 没有可重做的操作'); return; }
    if (result === 'busy') { setUndoHint('⏳ 撤销/重做正在同步，请稍候'); return; }
    if (result === 'failed') {
      setUndoHint(historyRecovery.current === 'refreshed'
        ? '⚠️ 重做未完成，已刷新云端并清空旧历史以防重复执行'
        : '⚠️ 重做未完成且云端刷新失败，失败操作已保留，可稍后重试');
      return;
    }
    setUndoHint(`↷ 已重做 · 还可重做 ${redoStack.current.length} 步`);
  }, [applyBatch]);
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
  const breakdown = useMemo(() => (g64111Enabled && account && opp ? scoreFromDomain(account, opp) : null), [account, g64111Enabled, opp]);

  // PDE 完整评估（App 层一次 fetch 喂两处：左栏加权分小字+徽章 + 坞引擎详解抽屉）。引擎不可用静默 null 不阻塞。
  const [pdeFull, setPdeFull] = useState<any>(null);
  const [engineSignal, setEngineSignal] = useState(0); // 第8刀：左栏徽章 → 坞开「引擎详解」抽屉的跨组件信号（照 openActionId 模式）
  useEffect(() => {
    if (!pdeEnabled || !opp) { setPdeFull(null); return; }
    let alive = true;
    const ticket = sessionGuard.current.capture();
    void runSessionRequest(sessionGuard.current, ticket, () => api.pdeEv(opp.id), api.getToken)
      .then((result) => { if (alive && result.current) setPdeFull(result.value); })
      .catch(() => {
        if (alive && sessionGuard.current.isCurrent(ticket, api.getToken())) setPdeFull(null);
      });
    return () => { alive = false; };
  }, [pdeEnabled, opp?.id, breakdown]);
  const gaps = useMemo(() => (g64111Enabled && account && opp ? computeGaps(account, opp) : []), [account, g64111Enabled, opp]);
  const roleByPerson = useMemo(() => {
    const m = new Map<string, Role>();
    if (opp) for (const r of opp.roles) m.set(r.personId, r.role);
    return m;
  }, [opp]);

  // 进入某商机时加载已有的 AI 候选关系（pending）
  useEffect(() => {
    if (!opp) { setSuggestions([]); return; }
    let alive = true;
    const ticket = sessionGuard.current.capture();
    void runSessionRequest(sessionGuard.current, ticket, () => api.suggestList(opp.id), api.getToken)
      .then((result) => { if (alive && result.current) setSuggestions(result.value.suggestions); })
      .catch(() => {
        if (alive && sessionGuard.current.isCurrent(ticket, api.getToken())) setSuggestions([]);
      });
    return () => { alive = false; };
  }, [opp?.id]);

  const openAccount = (id: string) => {
    const a = state.accounts.find((x) => x.id === id);
    setAccId(id); setOppId(a?.opportunities[0]?.id ?? null); setSelectedId(null); setVisibleLayers(new Set(['L1']));
  };
  const navigateCommercial = (path: string) => {
    if (!auth?.product.valid || auth.product.shell !== 'commercial') return;
    const route = resolveProductRoute(path, auth.product);
    if (route.denied) {
      setSyncErr('当前版本未启用该能力');
      return;
    }
    setSyncErr('');
    setCommercialPath(route.canonicalPath);
    setAccId(null); setOppId(null); setSelectedId(null);
    if (window.location.pathname !== route.canonicalPath) window.history.pushState(null, '', route.canonicalPath);
  };
  const leaveLegacyWorkspace = () => {
    setAccId(null); setOppId(null); selectPerson(null);
    if (auth?.product.shell === 'commercial') {
      if (window.location.pathname !== commercialPath) window.history.pushState(null, '', commercialPath);
    }
  };
  const createAccount = (name: string, ctype: CustomerType) => {
    const a = newAccount(name, ctype);
    act({ type: 'ADD_ACCOUNT', account: a });
    setAccId(a.id); setOppId(null); setSelectedId(null); setVisibleLayers(new Set(['L1']));
  };
  const openRepairRecord = (kind: 'visitNote' | 'note', id: string) => {
    for (const candidate of state.accounts) {
      if (kind === 'visitNote') {
        const record = (candidate.visitNotes ?? []).find((item) => item.id === id);
        if (!record) continue;
        setRepairTarget({ kind, record });
        return;
      }
      const record = (candidate.notes ?? []).find((item) => item.id === id);
      if (record) {
        setRepairTarget({ kind, record });
        return;
      }
    }
  };
  const loadDemo = async () => {
    const ticket = sessionGuard.current.capture();
    setSyncErr('');
    const prev = new Set(state.accounts.map((a) => a.id));
    try {
      await api.demo();
      const st = await refreshState(ticket);
      if (!st) return;
      const added = st.accounts.find((a) => !prev.has(a.id)) ?? st.accounts[st.accounts.length - 1];
      if (added) { setAccId(added.id); setOppId(added.opportunities[0]?.id ?? null); setSelectedId(null); setVisibleLayers(new Set(['L1'])); }
    } catch (e: any) {
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('载入示例失败：' + e.message);
    }
  };
  const addOpp = () => { if (account) setNewOppOpen(true); };
  const createOpportunity = async (params: { name: string; fromOppId?: string; personIds: string[]; withEdges: boolean; skeleton?: SkeletonRole[] }) => {
    if (!account) return;
    const ticket = sessionGuard.current.capture();
    setNewOppOpen(false);
    try {
      const command = await api.opportunitySkeleton({
        accountId: account.id, name: params.name, fromOppId: params.fromOppId,
        personIds: params.personIds, withEdges: params.withEdges,
        skeleton: params.skeleton?.length ? layoutSkeleton(params.skeleton) : [],
      }, newIdempotencyKey());
      const { opportunityId } = command;
      const st = await refreshState(ticket);
      if (!st) return;
      setOppId(opportunityId); setSelectedId(null); setVisibleLayers(new Set(['L1']));
    } catch (e: any) {
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('新建商机失败：' + e.message);
    }
  };
  const archiveAccount = async (id: string, reason: string) => {
    const ticket = sessionGuard.current.capture();
    try {
      await api.archive('account', id, reason);
      await refreshState(ticket);
    } catch (e: any) {
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('归档失败：' + (e?.message || e));
    }
  };
  // ── 画布交互：选中 / 打开右侧栏 / 飞书式建点连线 ──
  const selectPerson = (id: string | null) => { setSelectedId(id); setSelectedEdgeId(null); if (id) setFocusTab(readonly ? 'profile' : 'advisor'); }; // 单击=选中→焦点面板「参谋」（viewer 无参谋→档案）
  const openPerson = (id: string) => { setSelectedId(id); setSelectedEdgeId(null); setDrawerEdgeId(null); setFocusTab('profile'); }; // 双击=选中→焦点面板「档案」
  const selectEdge = (id: string | null) => { setSelectedEdgeId(id); setSelectedId(null); if (id && drawerEdgeId) setDrawerEdgeId(id); };
  const openEdge = (id: string) => { setSelectedId(null); setDrawerEdgeId(id); };
  // 画布行动牌就地反馈：标完成 + 态度↑↓ → 录一条互动证据喂策略引擎（复用坞的结果回填飞轮，守铁律②：人当场拍板）
  const actionFeedback = async (actionId: string, outcome: 'up' | 'flat' | 'down') => {
    if (!account || !opp) return;
    const ticket = sessionGuard.current.capture();
    const a = (account.planActions ?? []).find((x) => x.id === actionId);
    if (!a) return;
    const today = localYmd(new Date());
    try {
      await api.actionFeedback({
        accountId: account.id,
        opportunityId: opp.id,
        actionId,
        outcome,
        occurredAt: today,
        baseVersion: a.version ?? 0,
        expectedScheduleVersion: a.scheduleVersion ?? 0,
      }, newIdempotencyKey());
      await refreshState(ticket);
    } catch (error: any) {
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('行动回填失败：' + (error?.message || error));
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
  // P11：彻底异步——点完即走。入队立刻返回、砍 2-50s 前台轮询；进度看收件箱角标（P2 心跳/巡检提醒同套感知模型）。
  // 任务真终态由 worker 消费后自然反映到 inbox（下一次 loadInbox 或 hub 刷新）；这里只负责启动+提示。
  const selfCompute = async () => {
    if (!account || selfComputeBusy) return;
    const ticket = sessionGuard.current.capture();
    setSelfComputeBusy(true);
    try {
      const tasks: string[] = [];
      const enrichResult = await runSessionRequest(
        sessionGuard.current,
        ticket,
        () => api.enrichEnqueue(account.id, 'auto'),
        api.getToken,
      );
      if (!enrichResult.current) return;
      const er = enrichResult.value;
      tasks.push(er.enqueued ? '发现干系人' : '发现干系人（进行中）');
      if (opp) {
        const suggestResult = await runSessionRequest(
          sessionGuard.current,
          ticket,
          () => api.suggestEnqueue(opp.id),
          api.getToken,
        );
        if (!suggestResult.current) return;
        const sr = suggestResult.value;
        tasks.push(sr.enqueued ? '推断关系' : '推断关系（进行中）');
      }
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) {
        setSyncErr(`🔍 已启动自算·${tasks.join(' + ')}——后台跑，完成后候选进 📥 收件箱`);
      }
    } catch (e: any) {
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('自算失败：' + (e?.message || e));
    } finally {
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSelfComputeBusy(false);
    }
  };

  // ── 审核收件箱（Hub 级）：复用既有候选采纳/驳回链路；采纳会改对应客户的树 → getState 重拉整树保证跨客户一致 ──
  const refreshAfterAccept = async (ticket: SessionTicket = renderedSessionTicket) => {
    if (!sessionLease.isCurrent()) return;
    try { await refreshState(ticket); } catch { /* 重拉失败下次同步 */ }
    if (!sessionGuard.current.isCurrent(ticket, api.getToken())) return;
    if (opp) {
      try {
        const result = await runSessionRequest(sessionGuard.current, ticket, () => api.suggestList(opp.id), api.getToken);
        if (result.current) setSuggestions(result.value.suggestions);
      } catch { /* 下次同步 */ }
    } // 采纳/忽略关系候选后刷新画布灰虚线候选边
    await loadInbox(ticket);
  };
  const inboxAcceptRel = async (id: string, override?: { layer?: string; label?: string }) => {
    const ticket = sessionGuard.current.capture();
    try { await api.suggestAccept(id, override); await refreshAfterAccept(ticket); }
    catch (e: any) { if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('采纳失败：' + e.message); throw e; }
  };
  const inboxRejectRel = async (id: string) => {
    const ticket = sessionGuard.current.capture();
    try { await api.suggestReject(id); await loadInbox(ticket); }
    catch (e: any) { if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('忽略失败：' + e.message); throw e; }
  };
  const inboxAcceptPerson = async (id: string, override?: { name?: string; title?: string }) => {
    const ticket = sessionGuard.current.capture();
    try { await api.personSuggestAccept(id, override); await refreshAfterAccept(ticket); }
    catch (e: any) { if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('采纳失败：' + e.message); throw e; }
  };
  const inboxRejectPerson = async (id: string) => {
    const ticket = sessionGuard.current.capture();
    try { await api.personSuggestReject(id); await loadInbox(ticket); }
    catch (e: any) { if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('忽略失败：' + e.message); throw e; }
  };
  const inboxAcceptProposal = async (id: string, overrideValue?: string) => {
    const ticket = sessionGuard.current.capture();
    try { await api.proposalAccept(id, overrideValue); await refreshAfterAccept(ticket); }
    catch (e: any) { if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('采纳失败：' + e.message); throw e; }
  };
  const inboxRejectProposal = async (id: string) => {
    const ticket = sessionGuard.current.capture();
    try { await api.proposalReject(id); await loadInbox(ticket); }
    catch (e: any) { if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('忽略失败：' + e.message); throw e; }
  };
  const inboxDismissReminder = async (id: string) => {
    const ticket = sessionGuard.current.capture();
    try { await api.reminderDismiss(id); await loadInbox(ticket); }
    catch (e: any) { if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('忽略失败：' + e.message); throw e; }
  };
  // M3 证据审核：批准=进 E2 燃料池（重拉整树让背离黄条/立场条立即重算）；拒绝只刷收件箱
  const inboxReviewEvidence = async (id: string, action: 'approve' | 'reject', direction?: -1 | 0 | 1) => {
    const ticket = sessionGuard.current.capture();
    try {
      await api.evidenceReview(id, action, direction !== undefined ? { direction } : undefined);
      if (action === 'approve') await refreshAfterAccept(ticket); else await loadInbox(ticket);
    } catch (e: any) {
      if (sessionGuard.current.isCurrent(ticket, api.getToken())) setSyncErr('审核失败：' + e.message);
      throw e;
    }
  };
  const inboxBatch = async (items: InboxBatchItem[], onProgress: Parameters<typeof runBatchWithProgress<InboxBatchItem>>[2]) => {
    const ticket = sessionGuard.current.capture();
    const result = await runBatchWithProgress(items, async (item) => {
      const key = stableBatchItemKey(inboxBatchKeys.current, item, newIdempotencyKey);
      const command = await runSessionRequest(
        sessionGuard.current,
        ticket,
        () => api.inboxBatch({ items: [item] }, key),
        api.getToken,
      );
      if (!command.current) throw new ApiError({ code: 'session_reset', message: '会话已切换', retryable: false });
      clearStableBatchItemKey(inboxBatchKeys.current, item);
    }, onProgress, {
      isCancelled: () => !sessionGuard.current.isCurrent(ticket, api.getToken()),
      cancellationError: () => new ApiError({ code: 'session_reset', message: '会话已切换，已取消旧会话批量审核', retryable: false }),
    });
    if (result.successes.length > 0) await refreshAfterAccept(ticket);
    if (result.failures.length > 0 && sessionGuard.current.isCurrent(ticket, api.getToken())) {
      setSyncErr(`批量审核部分失败：${result.failures.length}/${result.total} 项，请查看失败项后重试。`);
    }
    return result;
  };
  const inboxDialogProps: GlobalInboxProps = {
    rels: inbox.rels,
    persons: inbox.persons,
    proposals: inbox.proposals,
    reminders: inbox.reminders,
    evidences: inbox.evidences,
    accounts: state.accounts,
    onAccept: inboxAcceptRel,
    onReject: inboxRejectRel,
    onAcceptPerson: inboxAcceptPerson,
    onRejectPerson: inboxRejectPerson,
    onAcceptProposal: inboxAcceptProposal,
    onRejectProposal: inboxRejectProposal,
    onDismissReminder: inboxDismissReminder,
    onReviewEvidence: inboxReviewEvidence,
    onBatch: inboxBatch,
  };

  if (booting) return <div className="boot">加载中…</div>;
  if (!auth) return <>
    <Auth onAuthed={onAuthed} />
    {syncErr && api.getToken() && <div className="session-recovery" role="alert">
      <span>{syncErr}</span>
      <button className="btn sm" onClick={() => void restoreSession()}>重试连接</button>
      <button className="btn ghost sm" onClick={logout}>退出登录</button>
    </div>}
  </>;

  if (!auth.product.valid) {
    return (
      <div className="boot" role="alert">
        <span>{INVALID_PRODUCT_CONFIGURATION_MESSAGE}</span>
        <button className="btn ghost sm" onClick={logout}>退出登录</button>
      </div>
    );
  }

  const rootSurface = selectAppRootSurface(auth.product, Boolean(account));
  if (!account && rootSurface === 'commercial_shell') {
    return (
      <>
        <CommercialShell
          access={auth.product}
          pathname={commercialPath}
          accounts={state.accounts}
          crmContextState={commercialContextState}
          actorUserId={auth.user.id}
          readonly={readonly}
          onNavigate={navigateCommercial}
          onOpenLegacy={salesWorkspaceEnabled ? openAccount : () => setSyncErr('当前版本未启用复杂销售工作台')}
          onOpenTeam={() => setGlobalDialogOpen('team', true)}
          onQuickCaptureSaved={async () => {
            try {
              await refreshCrmContext(renderedSessionTicket);
              if (salesWorkspaceEnabled) await refreshRenderedState();
              if (sessionLease.isCurrent()) setSyncErr('');
            } catch (cause) {
              if (sessionLease.isCurrent()) {
                setSyncErr(`客户与事项刷新失败：${toApiError(cause).message}`);
              }
              throw cause;
            }
          }}
          onLogout={logout}
        />
        {syncErr && <div className="sync-toast">{syncErr}</div>}
        <GlobalDialogs
          surface="hub"
          state={appShellUi}
          dispatch={appShellUiDispatch}
          sessionLease={sessionLease}
          readonly={readonly}
          role={auth.user.role}
          accounts={state.accounts}
          inbox={inboxDialogProps}
          repair={{
            onChanged: async () => { await refreshRenderedState(); },
            onRefreshError: (message) => { if (sessionLease.isCurrent()) setSyncErr(message); },
            onRepairRecord: openRepairRecord,
          }}
        />
        <Footer />
      </>
    );
  }

  // ── Hub（手机竖屏时刻流已退役 2026-07-21：竖屏直接进 Hub，横屏提示只在进作战室后）──
  if (!account) {
    const intelContext = appShellUi.intelContext;
    const captureAccount = intelContext ? state.accounts.find((item) => item.id === intelContext.accId) : undefined;
    const captureOpportunity = captureAccount && intelContext
      ? captureAccount.opportunities.find((item) => item.id === intelContext.oppId)
      : undefined;
    return (
      <InternalRootAdapter access={auth.product}>
        <CustomerHub
          accounts={state.accounts} onOpen={openAccount} onCreate={createAccount} onLoadDemo={loadDemo}
          readonly={readonly}
          today={hubToday} needsYou={hubNeedsYou}
          onArchiveAccount={archiveAccount}
          onRepairAccount={(selectedAccount) => setRepairTarget({ kind: 'account', account: selectedAccount })}
          canRestoreArchives={auth.user.role === 'owner' || auth.user.role === 'admin'}
          onArchiveRestored={async () => { await refreshRenderedState(); }}
          tenantName={auth.tenant.name} userName={auth.user.name} plan={auth.tenant.plan}
          onOpenTeam={() => setGlobalDialogOpen('team', true)} onLogout={logout} onOpenAiSettings={() => setGlobalDialogOpen('aiSettings', true)} onOpenWecom={() => setGlobalDialogOpen('wecomSettings', true)}
          theme={theme} onToggleTheme={toggleTheme} onOpenHelp={() => setGlobalDialogOpen('help', true)}
          onOpenMcpAccess={() => setGlobalDialogOpen('mcpAccess', true)}
          onOpenIntel={() => appShellUiDispatch({ type: 'OPEN_INTEL', context: null })}
          onIntelDone={async () => { try { await refreshAfterAccept(); } catch { /* 静默：保存已成功 */ } }}
          onOpenInbox={() => setGlobalDialogOpen('inbox', true)} inboxCount={inbox.total} patrol={inbox.patrol}
        />
        <SyncStatus coordinator={coordinator} onViewCloud={discardToCloudState} />
        {syncErr && <div className="sync-toast">{syncErr}</div>}
        <GlobalDialogs
          surface="hub"
          state={appShellUi}
          dispatch={appShellUiDispatch}
          sessionLease={sessionLease}
          readonly={readonly}
          role={auth.user.role}
          accounts={state.accounts}
          inbox={inboxDialogProps}
          intel={{
            account: captureAccount,
            opportunity: captureOpportunity,
            personId: intelContext?.personId,
            onDone: async () => { try { await refreshRenderedState(); } catch { /* 静默：保存已成功，仅刷新失败 */ } },
            onEnterAccount: async (id) => {
              if (!sessionLease.isCurrent()) return;
              const ticket = sessionGuard.current.capture();
              try {
                const st = await refreshState(ticket);
                if (!st) return;
                const a = st.accounts.find((x) => x.id === id);
                if (!a) return;
                setAccId(id); setOppId(a?.opportunities[0]?.id ?? null); setSelectedId(null); setVisibleLayers(new Set(['L1']));
              } catch {
                if (sessionGuard.current.isCurrent(ticket, api.getToken()) && stateRef.current.accounts.some((item) => item.id === id)) setAccId(id);
              }
            },
          }}
          repair={{
            onChanged: async () => { await refreshRenderedState(); },
            onRefreshError: (message) => { if (sessionLease.isCurrent()) setSyncErr(message); },
            onRepairRecord: openRepairRecord,
          }}
        />
        <Footer />
      </InternalRootAdapter>
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
      readonly={readonly}
      weighted={pdeFull?.score?.weighted ?? null}
      pde={pdeFull ? { action: pdeFull.recommendation?.action ?? '', pwin: pdeFull.pwin ?? 0, flag: pdeFull.confidenceFlag ?? '' } : null}
      onOpenEngine={readonly ? undefined : () => setEngineSignal((n) => n + 1)}
      onSelectOpp={(id) => { setOppId(id); selectPerson(null); setMobileNavOpen(false); }}
      onAddOpp={addOpp}
      onBack={leaveLegacyWorkspace}
      onCollapse={() => (isMobile ? setMobileNavOpen(false) : setSidebarCollapsed(true))}
      gapCount={gaps.length} onOpenGaps={readonly ? undefined : () => setGapsOpen(true)}
    />
  );

  return (
    <div className={`app-shell${isMobile ? ' mobile' : ''}${immersive ? ' immersive' : ''}`}>
      {isMobile && !isLandscape && <OrientationGate />}
      {/* 第8刀：上半区=侧栏+画布并排；坞提出到 app-shell 级全宽横贯底部（列①落在左栏正下方，局势信息纵向融合） */}
      <div className="app-upper">
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
                  {/* viewer（只读投影）：录入/自算/审核入口不渲染；档案（可导出喂 WorkBuddy）与视图操作保留 */}
                  {!readonly && <button className="btn cta xs" onClick={() => setAddIntelOpen(true)} title="接入录音：飞书妙记 / 上传音频 / 得到大脑——转写后一键抽取成图（打字/粘口述走坞底「和地图对话」）">🎧 接入录音</button>}
                  {!readonly && <button className="btn ghost xs" onClick={() => setOppFormOpen(true)}>✏️ 编辑商机</button>}
                  {!readonly && <button className="btn ghost xs" onClick={() => setRepairTarget({ kind: 'opportunity', account, opportunity: opp })}>🛠️ 溯源/归档</button>}
                  <button className="btn ghost xs" onClick={() => setMdDocOpen(true)} title="客户档案 / 商机档案 / 拜访记录（.md 文档）">📋 作战档案</button>
                  {!readonly && <button className="btn ghost xs" onClick={selfCompute} disabled={selfComputeBusy} title="再跑一遍自算：后台用企查查/AI 发现干系人 + 推断商机内关系 + 补企业背景研究，候选进收件箱人审。建客户已自动跑过一次，这里是「再来一遍」。">{selfComputeBusy ? '⏳ 已启动…' : '↻ 重新补全'}</button>}
                  {!readonly && <button className="btn ghost xs" onClick={() => setGlobalDialogOpen('inbox', true)}>📥 收件箱{inbox.total > 0 ? ` (${inbox.total})` : ''}</button>}
                  <span style={{ marginLeft: 'auto' }}>
                    <OverflowMenu align="right" label="⚙️" items={[
                      ...(!readonly ? [{ label: '📆 企微日历', onClick: () => setGlobalDialogOpen('wecomSettings', true) }] : []),
                      { label: '❓ 帮助', onClick: () => setGlobalDialogOpen('help', true) },
                      { label: theme === 'dark' ? '☀️ 白天模式' : '🌙 黑夜模式', onClick: toggleTheme },
                    ]} />
                  </span>
                </>)}
                {isMobile && (<>
                  <OverflowMenu align="left" label={`▾ 层级 (${visibleLayers.size})`}
                    items={(['L1', 'L2', 'L3', 'L4'] as Layer[]).map((l) => ({ label: LAYER_LABEL[l], active: visibleLayers.has(l), onClick: () => toggleLayer(l) }))} />
                  <OverflowMenu align="left" label="⋯ 操作" items={[
                    ...(!readonly ? [{ label: '🎧 接入录音', primary: true, onClick: () => setAddIntelOpen(true) }] : []),
                    ...(!readonly ? [{ label: '✏️ 编辑商机', onClick: () => setOppFormOpen(true) }, { label: '🛠️ 溯源/归档', onClick: () => setRepairTarget({ kind: 'opportunity', account, opportunity: opp }) }] : []),
                    { label: '📋 作战档案', onClick: () => setMdDocOpen(true) },
                    ...(!readonly ? [
                      { label: selfComputeBusy ? '⏳ 自算中…' : '↻ 重新补全', onClick: selfCompute },
                      { label: '📥 收件箱', badge: inbox.total > 0 ? String(inbox.total) : undefined, onClick: () => setGlobalDialogOpen('inbox', true) },
                    ] : []),
                    ...(!readonly ? [{ label: '📆 企微日历', onClick: () => setGlobalDialogOpen('wecomSettings', true) }] : []),
                    { label: '❓ 帮助', onClick: () => setGlobalDialogOpen('help', true) },
                    { label: theme === 'dark' ? '☀️ 白天模式' : '🌙 黑夜模式', onClick: toggleTheme },
                  ]} />
                </>)}
              </div>
            )}
            <>
            <Canvas account={account} opp={opp} visibleLayers={visibleLayers}
              readonly={readonly}
              selectedId={selectedId} selectedEdgeId={selectedEdgeId}
              onSelectPerson={selectPerson} onSelectEdge={selectEdge}
              onOpenPerson={openPerson} onOpenEdge={openEdge} onOpenAction={readonly ? undefined : setOpenActionId} onActionFeedback={readonly ? undefined : actionFeedback}
              onMovePerson={(id, x, y) => scheduleDraft({ type: 'MOVE_PERSON', accId: account.id, personId: id, x, y }, 80)}
              onAddPersonAt={addPersonAt} onAddConnectedNode={addConnectedNode} onConnect={connectNodes}
              onUpdateEdge={updateEdge} onDeleteEdge={deleteEdgeById}
              onUpdatePerson={updatePerson} onDeletePerson={deletePerson}
              immersive={immersive} onToggleImmersive={toggleImmersive} secondTapOpens={true}
              suggestions={suggestions} planActions={account.planActions ?? []} />
            </>
          </>
        ) : (
          <div className="no-opp">
            <div className="no-opp-emoji">🎯</div>
            <div className="no-opp-t">这个客户还没有商机</div>
            <div style={{ display: 'flex', gap: 10 }}>
              {!readonly && <button className="btn primary" onClick={addOpp}>＋ 新建商机</button>}
              <button className="btn ghost" onClick={() => setMdDocOpen(true)}>📋 作战档案</button>
            </div>
            {readonly && <div className="empty-hint" style={{ marginTop: 10 }}>商机由数字员工（销售包）每晚收口同步</div>}
          </div>
        )}
      </main>

      {/* 第9刀：右栏面板归位 .app-upper——absolute 于上半区，底边天然止于坞顶，不再遮挡坞内卡片 */}
      {selectedPerson && opp && breakdown && (
        <FocusPanel key={`focus:${selectedPerson.id}:${cloudDiscardRevisions[`person:${selectedPerson.id}`] ?? 0}`} accId={account.id} oppId={opp.id} account={account} opp={opp} breakdown={breakdown}
          readonly={readonly}
          sessionLease={sessionLease}
          person={selectedPerson} oppRole={selectedRole} bis={selectedBis} ucvs={selectedUcvs}
          visitNotes={account.visitNotes ?? []} tab={focusTab} onTabChange={setFocusTab} dispatch={act}
          draftDispatch={scheduleDraft} flushDraft={flushDraft} coordinator={coordinator}
          onRefresh={refreshState} onViewCloud={discardToCloudState}
          onRepairRecord={(kind, id) => {
            if (kind === 'visitNote') {
              const record = (account.visitNotes ?? []).find((item) => item.id === id);
              if (record) setRepairTarget({ kind, record });
            } else {
              const record = (account.notes ?? []).find((item) => item.id === id);
              if (record) setRepairTarget({ kind, record });
            }
          }}
          onClose={() => setSelectedId(null)} />
      )}
      {drawerEdge && opp && (
        <EdgeDrawer key={`edge:${drawerEdge.id}:${cloudDiscardRevisions[`edge:${drawerEdge.id}`] ?? 0}`} edge={drawerEdge} persons={account.persons}
          readonly={readonly}
          onUpdate={(patch) => updateEdge(drawerEdge.id, patch)}
          onDraftUpdate={(patch) => scheduleDraft({ type: 'UPDATE_EDGE', accId: account.id, oppId: opp.id, edgeId: drawerEdge.id, patch })}
          onDraftFlush={() => flushDraft({ type: 'UPDATE_EDGE', accId: account.id, oppId: opp.id, edgeId: drawerEdge.id, patch: {} })}
          coordinator={coordinator} onViewCloud={discardToCloudState}
          onDelete={() => { deleteEdgeById(drawerEdge.id); setDrawerEdgeId(null); setSelectedEdgeId(null); }}
          onClose={() => setDrawerEdgeId(null)} />
      )}
      </div>

      {/* 第8刀：坞全宽横贯底部（提出 .main），列①与左栏纵向对齐——局势信息上下融合 */}
      {/* viewer：推演坞（策划写作台）整体不渲染——拷问第二屏聚焦权力地图本身 */}
      {opp && !immersive && breakdown && !readonly && (
        <DeliberationDock account={account} opp={opp} breakdown={breakdown} dispatch={act}
          sessionLease={sessionLease}
          patrol={inbox.patrol} pdeFull={pdeFull} openEngineSignal={engineSignal}
          selectedPersonId={selectedId} onSelectPerson={selectPerson}
          openActionId={openActionId} onActionOpened={() => setOpenActionId(null)}
          onChatDone={async () => { try { await refreshAfterAccept(); } catch { /* 静默：保存已成功，仅刷新失败 */ } }} />
      )}

      {oppFormOpen && opp && !readonly && (
        <OpportunityForm key={`opportunity:${opp.id}:${cloudDiscardRevisions[`opportunity:${opp.id}`] ?? 0}`} opp={opp} onClose={() => setOppFormOpen(false)}
          coordinator={coordinator} onViewCloud={discardToCloudState}
          onSave={async (patch) => {
            await api.repairOpportunity(opp.id, patch);
            setOppFormOpen(false);
            void refreshRenderedState().catch(() => {
              if (sessionLease.isCurrent()) setSyncErr('商机纠错已保存，但刷新失败；请稍后重新进入客户。');
            });
          }} />
      )}
      {newOppOpen && !readonly && (
        <NewOpportunityDialog account={account} onClose={() => setNewOppOpen(false)} onCreate={createOpportunity} />
      )}
      {mdDocOpen && <MdDocPanel account={account} dispatch={act} readonly={readonly} onClose={() => setMdDocOpen(false)} />}
      {addIntelOpen && !readonly && (
        <RecordingPanel accountId={account.id} role={auth.user.role}
          onClose={() => setAddIntelOpen(false)}
          onExtracted={async () => { try { await refreshAfterAccept(); } catch { /* 静默：保存已成功，仅刷新失败 */ } }} />
      )}
      {gapsOpen && account && opp && breakdown && !readonly && (
        <GapCards account={account} opp={opp} dispatch={act} onClose={() => setGapsOpen(false)} />
      )}
      <GlobalDialogs
        surface="workroom"
        state={appShellUi}
        dispatch={appShellUiDispatch}
        sessionLease={sessionLease}
        readonly={readonly}
        role={auth.user.role}
        accounts={state.accounts}
        inbox={inboxDialogProps}
        repair={{
          onChanged: async () => { await refreshRenderedState(); },
          onRefreshError: (message) => { if (sessionLease.isCurrent()) setSyncErr(message); },
          onRepairRecord: openRepairRecord,
        }}
        onEditRepairOpportunity={() => setOppFormOpen(true)}
      />
      <SyncStatus coordinator={coordinator} onViewCloud={discardToCloudState} />
      {syncErr && <div className="sync-toast">{syncErr}</div>}
      {undoHint && <div className="undo-toast">{undoHint}</div>}
    </div>
  );
}
