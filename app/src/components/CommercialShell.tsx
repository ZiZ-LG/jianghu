import type { ProductAccess, ProductEntryId } from '@jianghu/domain-contracts';
import type { Account } from '../types';
import { resolveProductRoute } from '../lib/productRoutes';

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
  id, accounts, readonly, onNavigate, onOpenLegacy, onOpenTeam,
}: {
  id: ProductEntryId;
  accounts: Account[];
  readonly: boolean;
  onNavigate: (path: string) => void;
  onOpenLegacy: (accountId: string) => void;
  onOpenTeam: () => void;
}) {
  const matters = accounts.flatMap((account) => account.opportunities.map((matter) => ({ account, matter })));
  if (id === 'today') {
    return accounts.length === 0
      ? <EmptyState>今天还没有需要处理的客户或事项。</EmptyState>
      : <div className="commercial-shell-summary">当前关注 {accounts.length} 个客户、{matters.length} 个事项。</div>;
  }
  if (id === 'customers') {
    return accounts.length === 0 ? <EmptyState>还没有客户档案。</EmptyState> : (
      <div className="commercial-shell-list">
        {accounts.map((account) => (
          <div key={account.id} className="commercial-shell-row static">
            <span>{account.name}</span><span>{account.persons.length} 位联系人</span>
          </div>
        ))}
      </div>
    );
  }
  if (id === 'matters') {
    return matters.length === 0 ? <EmptyState>还没有进行中的事项。</EmptyState> : (
      <div className="commercial-shell-list">
        {matters.map(({ account, matter }) => (
          <div key={matter.id} className="commercial-shell-row static">
            <span>{matter.name}</span><span>{account.name}</span>
          </div>
        ))}
      </div>
    );
  }
  if (id === 'quick-capture') {
    return (
      <div className="commercial-shell-empty">
        <p>选择一个已有客户或事项，继续留下下一步。</p>
        <div className="commercial-shell-actions">
          <button className="btn primary" onClick={() => onNavigate('/customers')}>前往客户</button>
          <button className="btn ghost" onClick={() => onNavigate('/matters')}>查看事项</button>
        </div>
        {readonly && <small>当前为只读视图。</small>}
      </div>
    );
  }
  if (id === 'team') {
    return (
      <div className="commercial-shell-empty">
        <p>团队能力已启用。</p>
        <button className="btn primary" onClick={onOpenTeam}>打开团队管理</button>
      </div>
    );
  }
  return <LegacyAccountList accounts={accounts} onOpenLegacy={onOpenLegacy} />;
}

export function CommercialShell({
  access, pathname, accounts, readonly, onNavigate, onOpenLegacy, onOpenTeam, onLogout,
}: {
  access: ProductAccess;
  pathname: string;
  accounts: Account[];
  readonly: boolean;
  onNavigate: (path: string) => void;
  onOpenLegacy: (accountId: string) => void;
  onOpenTeam: () => void;
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
          readonly={readonly}
          onNavigate={onNavigate}
          onOpenLegacy={onOpenLegacy}
          onOpenTeam={onOpenTeam}
        />
      </main>
    </div>
  );
}
