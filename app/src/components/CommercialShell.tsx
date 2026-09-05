import { useState } from 'react';
import {
  isG64111RunnableMatter,
  type CommandContext,
  type CrmContextSnapshot,
  type ProductAccess,
  type ProductEntryId,
} from '@jianghu/domain-contracts';
import type { Account } from '../types';
import { personalMatterPath, personalRouteContext, quickCapturePath, resolveProductRoute } from '../lib/productRoutes';
import { PersonalCustomerForm, PersonalWorkbench } from './PersonalWorkbench';
import { QuickCapture } from './QuickCapture';
import { TodayPanel } from './TodayPanel';
import { CrmContextPanel, type CrmContextPanelState } from './CrmContextPages';
import { toQuickCaptureAccounts, type QuickCaptureAccountOption } from '../lib/crmContext';
import { PostMeetingReviewPanel } from './PostMeetingReviewPanel';
import { PreMeetingBriefPanel } from './PreMeetingBriefPanel';
import { RelationshipWorkspacePanel } from './RelationshipWorkspacePanel';
import {
  G64111SetupPanel,
  type G64111SetupAction,
  type G64111SetupPanelState,
} from './G64111SetupPanel';

function EmptyState({ children }: { children: string }) {
  return <div className="commercial-shell-empty">{children}</div>;
}

function LegacyG64111MatterList({ state, onOpenLegacy }: {
  state: G64111SetupPanelState;
  onOpenLegacy: (customerId: string, matterId: string) => void;
}) {
  if (state.status === 'loading') return <EmptyState>正在确认 G64111 事项绑定…</EmptyState>;
  if (state.status === 'error') return <EmptyState>方法论状态暂不可用，原工作台已安全关闭。</EmptyState>;
  const matters = state.snapshot.matters.filter(isG64111RunnableMatter);
  if (matters.length === 0) return <EmptyState>尚无已启用 G64111 的事项；通用复杂销售工作流仍可使用。</EmptyState>;
  return (
    <div className="commercial-shell-list">
      {matters.map((matter) => (
        <button
          key={matter.matterId}
          className="commercial-shell-row"
          data-legacy-g64111-matter={matter.matterId}
          onClick={() => onOpenLegacy(matter.customerId, matter.matterId)}
        >
          <span>{matter.matterTitle}</span><span>{matter.customerName} ›</span>
        </button>
      ))}
    </div>
  );
}

function ProductPanel({
  id, pathname, accounts, crmContextState, quickCaptureAccounts, actorUserId, actorRole, readonly, portfolioEnabled,
  methodologyState, onNavigate, onOpenLegacy, onOpenTeam, onMethodologyAction, onRetryMethodology, onQuickCaptureSaved,
}: {
  id: ProductEntryId;
  pathname: string;
  accounts: Account[];
  crmContextState: CrmContextPanelState;
  quickCaptureAccounts: QuickCaptureAccountOption[];
  actorUserId: string;
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  portfolioEnabled: boolean;
  methodologyState: G64111SetupPanelState;
  onNavigate: (path: string) => void;
  onOpenLegacy: (customerId: string, matterId: string) => void;
  onOpenTeam: () => void;
  onMethodologyAction: (action: G64111SetupAction) => Promise<void>;
  onRetryMethodology: () => void;
  onQuickCaptureSaved: () => Promise<unknown>;
}) {
  const [addingCustomer, setAddingCustomer] = useState(false);
  if (id === 'today') {
    return <TodayPanel
      actorUserId={actorUserId}
      readonly={readonly}
      onDataChanged={onQuickCaptureSaved}
      onOpenMatter={matterId => onNavigate(personalMatterPath(matterId))}
    />;
  }
  const matters = accounts.flatMap((account) => account.opportunities.map((matter) => ({ account, matter })));
  if (id === 'matters') return <PersonalWorkbench pathname={pathname} readonly={readonly} actorUserId={actorUserId} onNavigate={onNavigate} onDataChanged={onQuickCaptureSaved} />;
  if (id === 'customers') {
    return <>
      {!readonly ? <div className="personal-toolbar"><span>客户与商机共享同一份联系人记录</span><button className="btn" onClick={() => setAddingCustomer(true)}>添加客户</button></div> : null}
      {addingCustomer && !readonly ? <PersonalCustomerForm actorUserId={actorUserId} onClose={() => setAddingCustomer(false)} onSaved={() => { setAddingCustomer(false); void onQuickCaptureSaved().catch(() => undefined); }} /> : null}
      <CrmContextPanel
      mode={id}
      state={crmContextState}
      onRetry={() => { void onQuickCaptureSaved().catch(() => undefined); }}
      onQuickCapture={() => onNavigate('/quick-capture')}
      readonly={readonly}
      onNavigate={onNavigate}
      portfolioEnabled={portfolioEnabled}
    /></>;
  }
  if (id === 'quick-capture') {
    return <QuickCapture
      key={`${actorUserId}:${pathname}`}
      accounts={quickCaptureAccounts}
      actorUserId={actorUserId}
      readonly={readonly}
      onSaved={onQuickCaptureSaved}
      initialCustomerId={personalRouteContext(pathname).customerId}
      initialMatterId={personalRouteContext(pathname).matterId}
    />;
  }
  if (id === 'team') {
    return (
      <div className="commercial-shell-empty" data-capability-surface="team">
        <p>团队能力已启用。</p>
        <button className="btn primary" onClick={onOpenTeam}>打开团队管理</button>
      </div>
    );
  }
  if (id === 'sales-workspace') {
    const crmContext = crmContextState.status === 'ready' ? crmContextState.snapshot : null;
    return <div data-capability-surface="sales-workspace">
      <PreMeetingBriefPanel
        crmContext={crmContext}
        actorRole={actorRole}
        readonly={readonly}
        onDataChanged={onQuickCaptureSaved}
      />
      <PostMeetingReviewPanel
        crmContext={crmContext}
        actorRole={actorRole}
        readonly={readonly}
        onDataChanged={onQuickCaptureSaved}
      />
      <RelationshipWorkspacePanel
        crmContext={crmContext}
        actorUserId={actorUserId}
        actorRole={actorRole}
        readonly={readonly}
        onDataChanged={onQuickCaptureSaved}
      />
      <section className="commercial-legacy-entry" data-legacy-sales-entry="frozen">
        <div className="commercial-legacy-heading"><h2>原复杂销售工作台</h2><span>遗留入口 · 冻结新功能</span></div>
        <LegacyG64111MatterList state={methodologyState} onOpenLegacy={onOpenLegacy} />
      </section>
    </div>;
  }
  if (id === 'g64111') {
    return <G64111SetupPanel state={methodologyState} onRetry={onRetryMethodology} onAction={onMethodologyAction} />;
  }
  return (
    <div className="commercial-shell-empty" data-capability-surface="pde">
      <p>PDE 决策能力已就绪，可基于现有事项准备评估与行动排序。</p>
      <strong>{matters.length} 个事项可进入决策准备</strong>
      <div className="commercial-shell-actions">
        <button className="btn primary" onClick={() => onNavigate('/matters')}>查看事项</button>
      </div>
    </div>
  );
}

export function CommercialShell({
  access, pathname, accounts, crmContextState, actorUserId, actorRole, readonly, methodologyState,
  onNavigate, onOpenLegacy, onOpenTeam, onMethodologyAction, onRetryMethodology, onQuickCaptureSaved, onLogout,
}: {
  access: ProductAccess;
  pathname: string;
  accounts: Account[];
  crmContextState: CrmContextPanelState;
  actorUserId: string;
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  methodologyState: G64111SetupPanelState;
  onNavigate: (path: string) => void;
  onOpenLegacy: (customerId: string, matterId: string) => void;
  onOpenTeam: () => void;
  onMethodologyAction: (action: G64111SetupAction) => Promise<void>;
  onRetryMethodology: () => void;
  onQuickCaptureSaved: () => Promise<unknown>;
  onLogout: () => void;
}) {
  const route = resolveProductRoute(pathname, access);
  const crmContext: CrmContextSnapshot | null = crmContextState.status === 'ready'
    ? crmContextState.snapshot
    : null;
  const quickCaptureAccounts = toQuickCaptureAccounts(crmContext);
  const context = personalRouteContext(pathname);
  const customerId = context.customerId ?? crmContext?.matters.find(matter => matter.id === context.matterId)?.customerId;
  const advanced = access.navigation.filter(entry => !['matters', 'today', 'customers', 'quick-capture'].includes(entry.id));
  return (
    <div className="commercial-shell">
      <header className="commercial-shell-header">
        <div className="logo">江</div>
        <div><strong>江湖 CRM</strong><small>我的客户经营</small></div>
        {!readonly && access.navigation.some(entry => entry.id === 'quick-capture') ? <button className="btn primary" data-global-quick-capture="true" onClick={() => onNavigate(customerId ? quickCapturePath(customerId, context.matterId) : '/quick-capture')}>＋ 快速记录</button> : null}
        <button className="btn ghost xs" onClick={onLogout}>退出登录</button>
      </header>
      <nav className="commercial-shell-nav" aria-label="产品导航">
        {access.navigation.filter(entry => ['matters', 'today', 'customers'].includes(entry.id)).map((entry) => (
          <button
            key={entry.id}
            data-product-entry={entry.id}
            className={entry.id === route.entry.id ? 'active' : ''}
            aria-current={entry.id === route.entry.id ? 'page' : undefined}
            onClick={() => onNavigate(entry.path)}
          >{entry.label}</button>
        ))}
        {advanced.length ? <details className="commercial-advanced"><summary>历史工具</summary><div>{advanced.map(entry => <button key={entry.id} data-product-entry={entry.id} aria-current={entry.id === route.entry.id ? 'page' : undefined} onClick={() => onNavigate(entry.path)}>{entry.label}</button>)}</div></details> : null}
      </nav>
      <main data-product-panel={route.entry.id} className="commercial-shell-panel">
        <h1>{route.entry.title}</h1>
        <p className="commercial-shell-description">{route.entry.description}</p>
        <ProductPanel
          key={`${actorUserId}:${route.entry.id}:${readonly}`}
          id={route.entry.id}
          pathname={pathname}
          accounts={accounts}
          crmContextState={crmContextState}
          quickCaptureAccounts={quickCaptureAccounts}
          actorUserId={actorUserId}
          actorRole={actorRole}
          readonly={readonly}
          portfolioEnabled={access.policy.entitlements.includes('sales.workspace')}
          methodologyState={methodologyState}
          onNavigate={onNavigate}
          onOpenLegacy={onOpenLegacy}
          onOpenTeam={onOpenTeam}
          onMethodologyAction={onMethodologyAction}
          onRetryMethodology={onRetryMethodology}
          onQuickCaptureSaved={onQuickCaptureSaved}
        />
      </main>
    </div>
  );
}
