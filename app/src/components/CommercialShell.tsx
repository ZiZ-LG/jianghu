import type { ProductAccess, ProductEntryId } from '@jianghu/domain-contracts';
import type { Account } from '../types';
import { resolveProductRoute } from '../lib/productRoutes';
import { QuickCapture } from './QuickCapture';
import { TodayPanel } from './TodayPanel';
import { CrmContextPanel } from './CrmContextPages';

function EmptyState({ children }: { children: string }) {
  return <div className="commercial-shell-empty">{children}</div>;
}

function LegacyAccountList({ accounts, onOpenLegacy }: { accounts: Account[]; onOpenLegacy: (accountId: string) => void }) {
  if (accounts.length === 0) return <EmptyState>还没有可打开的客户，先在“客户”中建立档案。</EmptyState>;
  return (
    <div className="commercial-shell-list">
      {accounts.map((account) => (
        <button key={account.id} className="commercial-shell-row" onClick={() => onOpenLegacy(account.id)}>
          <span>{account.name}</span><span>{account.opportunities.length} 个事项 ›</span>
        </button>
      ))}
    </div>
  );
}

function ProductPanel({
  id, accounts, actorUserId, readonly, onNavigate, onOpenLegacy, onOpenTeam, onQuickCaptureSaved,
}: {
  id: ProductEntryId;
  accounts: Account[];
  actorUserId: string;
  readonly: boolean;
  onNavigate: (path: string) => void;
  onOpenLegacy: (accountId: string) => void;
  onOpenTeam: () => void;
  onQuickCaptureSaved: () => Promise<unknown>;
}) {
  if (id === 'today') {
    return <TodayPanel
      actorUserId={actorUserId}
      readonly={readonly}
      onDataChanged={onQuickCaptureSaved}
    />;
  }
  const matters = accounts.flatMap((account) => account.opportunities.map((matter) => ({ account, matter })));
  if (id === 'customers' || id === 'matters') {
    return <CrmContextPanel mode={id} onQuickCapture={() => onNavigate('/quick-capture')} />;
  }
  if (id === 'quick-capture') {
    return <QuickCapture
      accounts={accounts}
      actorUserId={actorUserId}
      readonly={readonly}
      onSaved={onQuickCaptureSaved}
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
    return <div data-capability-surface="sales-workspace"><LegacyAccountList accounts={accounts} onOpenLegacy={onOpenLegacy} /></div>;
  }
  if (id === 'g64111') {
    return (
      <div className="commercial-shell-empty" data-capability-surface="g64111">
        <p>G64111 趋赢力方法论已就绪，可从现有事项开始检查关键角色与信息缺口。</p>
        <strong>{matters.length} 个事项可纳入方法论分析</strong>
        <div className="commercial-shell-actions">
          <button className="btn primary" onClick={() => onNavigate('/matters')}>查看事项</button>
        </div>
      </div>
    );
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
  access, pathname, accounts, actorUserId, readonly, onNavigate, onOpenLegacy, onOpenTeam, onQuickCaptureSaved, onLogout,
}: {
  access: ProductAccess;
  pathname: string;
  accounts: Account[];
  actorUserId: string;
  readonly: boolean;
  onNavigate: (path: string) => void;
  onOpenLegacy: (accountId: string) => void;
  onOpenTeam: () => void;
  onQuickCaptureSaved: () => Promise<unknown>;
  onLogout: () => void;
}) {
  const route = resolveProductRoute(pathname, access);
  return (
    <div className="commercial-shell">
      <header className="commercial-shell-header">
        <div className="logo">江</div>
        <div><strong>江湖 CRM</strong><small>轻量客户与事项</small></div>
        <button className="btn ghost xs" onClick={onLogout}>退出登录</button>
      </header>
      <nav className="commercial-shell-nav" aria-label="产品导航">
        {access.navigation.map((entry) => (
          <button
            key={entry.id}
            data-product-entry={entry.id}
            className={entry.id === route.entry.id ? 'active' : ''}
            aria-current={entry.id === route.entry.id ? 'page' : undefined}
            onClick={() => onNavigate(entry.path)}
          >{entry.label}</button>
        ))}
      </nav>
      <main data-product-panel={route.entry.id} className="commercial-shell-panel">
        <h1>{route.entry.title}</h1>
        <p className="commercial-shell-description">{route.entry.description}</p>
        <ProductPanel
          id={route.entry.id}
          accounts={accounts}
          actorUserId={actorUserId}
          readonly={readonly}
          onNavigate={onNavigate}
          onOpenLegacy={onOpenLegacy}
          onOpenTeam={onOpenTeam}
          onQuickCaptureSaved={onQuickCaptureSaved}
        />
      </main>
    </div>
  );
}
