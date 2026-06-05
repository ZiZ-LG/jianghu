import { useState } from 'react';
import type { Account, CustomerType } from '../types';
import { CUSTOMER_TYPE_LABEL } from '../types';
import { Modal } from './Modal';
import { OverflowMenu } from './OverflowMenu';

export function CustomerHub({
  accounts, onOpen, onCreate, onLoadDemo, onDeleteAccount,
  tenantName, userName, plan, onOpenTeam, onLogout, onOpenAiSettings, theme, onToggleTheme, onOpenHelp, onOpenMcpAccess, onOpenIntel,
}: {
  accounts: Account[];
  onOpen: (accId: string) => void;
  onCreate: (name: string, customerType: CustomerType) => void;
  onLoadDemo: () => void;
  onDeleteAccount: (accId: string) => void;
  tenantName: string;
  userName: string;
  plan: string;
  onOpenTeam: () => void;
  onLogout: () => void;
  onOpenAiSettings: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenHelp: () => void;
  onOpenMcpAccess: () => void;
  onOpenIntel: () => void; // 从零口述建客户
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [ctype, setCtype] = useState<CustomerType>(2);

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), ctype);
    setName(''); setCtype(2); setCreating(false);
  };

  return (
    <div className="hub">
      <div className="hub-top">
        <div className="logo lg">江</div>
        <div className="hub-titlewrap">
          <div className="hub-title">{tenantName}</div>
          <div className="hub-sub">江湖 · 销售干系人作战地图 · 客户工作台</div>
        </div>
        {/* 桌面：整排操作 */}
        <div className="hub-actions-desktop">
          <button className="theme-toggle" onClick={onToggleTheme} title={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}>{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button className="team-chip" onClick={onOpenMcpAccess}>🔌 接入 AI</button>
          <button className="team-chip" onClick={onOpenHelp}>❓ 帮助</button>
          <button className="team-chip" onClick={onOpenAiSettings}>🧠 AI 模型</button>
          <button className="team-chip" onClick={onOpenTeam}>👥 团队 · ❤️ 支持</button>
          <span className="who">{userName}</span>
          <button className="btn ghost" onClick={onLoadDemo}>载入示例</button>
          <button className="btn cta" onClick={onOpenIntel}>🎙️ 录入情报</button>
          <button className="btn primary" onClick={() => setCreating(true)}>＋ 新建客户</button>
          <button className="btn ghost" onClick={onLogout} title="退出登录">退出</button>
        </div>
        {/* 移动：主题 + 新建 + ⋯ 菜单 */}
        <div className="hub-actions-mobile">
          <button className="theme-toggle" onClick={onToggleTheme} title="切换主题">{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button className="btn primary xs" onClick={() => setCreating(true)}>＋ 新建</button>
          <OverflowMenu align="right" items={[
            { label: '🎙️ 录入情报', primary: true, onClick: onOpenIntel },
            { label: '📋 载入示例', onClick: onLoadDemo },
            { label: '🔌 接入 AI', onClick: onOpenMcpAccess },
            { label: '🧠 AI 模型', onClick: onOpenAiSettings },
            { label: '❓ 帮助', onClick: onOpenHelp },
            { label: '👥 团队 · ❤️ 支持', onClick: onOpenTeam },
            { label: '🚪 退出登录', onClick: onLogout },
          ]} />
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="hub-empty">
          <div className="hub-empty-emoji">🗺️</div>
          <div className="hub-empty-t">还没有客户</div>
          <div className="hub-empty-s">从「新建客户」开始你的第一张作战地图，或先「载入示例数据」体验完整功能。</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn cta" onClick={onOpenIntel}>🎙️ 口述建客户</button>
            <button className="btn primary" onClick={() => setCreating(true)}>＋ 新建客户</button>
            <button className="btn ghost" onClick={onLoadDemo}>载入示例（西部电力建设集团）</button>
          </div>
        </div>
      ) : (
        <div className="hub-grid">
          {accounts.map((a) => (
            <div key={a.id} className="acc-card" onClick={() => onOpen(a.id)}>
              <div className="acc-card-top">
                <div className="acc-emoji">🏢</div>
                <button className="acc-del" title="删除客户"
                  onClick={(e) => { e.stopPropagation(); if (confirm(`删除客户「${a.name}」及其全部商机/干系人？`)) onDeleteAccount(a.id); }}>🗑</button>
              </div>
              <div className="acc-name">{a.name}</div>
              <div className="acc-type">{CUSTOMER_TYPE_LABEL[a.customerType]}</div>
              {(a.region || a.group || a.primaryOwner) && (
                <div className="acc-sub">{[a.region, a.group, a.primaryOwner].filter(Boolean).join(' · ')}</div>
              )}
              <div className="acc-meta">{a.opportunities.length} 个商机 · {a.persons.length} 位干系人</div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal title="新建客户" onClose={() => setCreating(false)}
          footer={<>
            <button className="btn ghost" onClick={() => setCreating(false)}>取消</button>
            <button className="btn primary" onClick={submit} disabled={!name.trim()}>创建</button>
          </>}>
          <label className="fld">
            <span>客户名称</span>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="如：西部电力建设集团" />
          </label>
          <label className="fld">
            <span>客户类型</span>
            <select value={ctype} onChange={(e) => setCtype(Number(e.target.value) as CustomerType)}>
              {([1, 2, 3] as CustomerType[]).map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
        </Modal>
      )}
    </div>
  );
}
