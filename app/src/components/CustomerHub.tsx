import { useState } from 'react';
import type { Account, CustomerType } from '../types';
import { CUSTOMER_TYPE_LABEL } from '../types';
import { Modal } from './Modal';
import { OverflowMenu } from './OverflowMenu';
import { EnginePulse } from './EnginePulse';
import type { PatrolInfo } from '../api';
import type { TodayItem } from '../lib/today';

export function CustomerHub({
  accounts, onOpen, onCreate, onLoadDemo, onDeleteAccount,
  tenantName, userName, plan, onOpenTeam, onLogout, onOpenAiSettings, onOpenWecom, theme, onToggleTheme, onOpenHelp, onOpenMcpAccess, onOpenIntel, onOpenInbox, inboxCount = 0, patrol, today = [], needsYou,
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
  onOpenWecom: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenHelp: () => void;
  onOpenMcpAccess: () => void;
  onOpenIntel: () => void; // 从零口述建客户
  onOpenInbox: () => void;     // 打开 Hub 级审核收件箱
  inboxCount?: number;         // 待审候选数（角标）
  patrol?: PatrolInfo | null;  // P2 引擎心跳（本租户最近一轮巡检统计）
  today?: TodayItem[];         // P5 今日三件事（三源聚合，App 算好下发）
  needsYou?: Map<string, number>; // P5 客户卡「需要你」计数（待审+逾期行动），并驱动排序
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [ctype, setCtype] = useState<CustomerType>(2);

  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), ctype);
    setName(''); setCtype(2); setCreating(false);
  };

  // 配置类聚合到「⚙️ 设置」——低频，不与日常动作抢位（桌面/移动共用）。落地 待办-入口重构.md 的 B2 集约。
  const settingsItems = [
    { label: '🔌 接入 AI', onClick: onOpenMcpAccess },
    { label: '🧠 AI 模型', onClick: onOpenAiSettings },
    { label: '📆 企微日历', onClick: onOpenWecom },
    { label: '👥 团队 · ❤️ 支持', onClick: onOpenTeam },
    { label: theme === 'dark' ? '☀️ 白天模式' : '🌙 黑夜模式', onClick: onToggleTheme },
    { label: '📋 载入示例', onClick: onLoadDemo },
    { label: '❓ 帮助', onClick: onOpenHelp },
    { label: '🚪 退出登录', onClick: onLogout },
  ];

  return (
    <div className="hub">
      <div className="hub-top">
        <div className="logo lg">江</div>
        <div className="hub-titlewrap">
          <div className="hub-title">{tenantName}</div>
          <div className="hub-sub">江湖 · 销售干系人作战地图 · 客户工作台</div>
          <EnginePulse patrol={patrol} />
        </div>
        {/* 桌面：整排操作 */}
        <div className="hub-actions-desktop">
          <span className="who">{userName}</span>
          <button className="team-chip inbox-chip" onClick={onOpenInbox} title="审核机器写入的候选（关系 / 人物），采纳后才落库">📥 收件箱{inboxCount > 0 ? ` · ${inboxCount}` : ''}</button>
          <button className="btn cta" onClick={onOpenIntel}>🎙️ 录入情报</button>
          <button className="btn primary" onClick={() => setCreating(true)}>＋ 新建客户</button>
          <OverflowMenu align="right" label="⚙️ 设置" items={settingsItems} />
        </div>
        {/* 移动：主题 + 新建 + ⋯ 菜单 */}
        <div className="hub-actions-mobile">
          <button className="btn primary xs" onClick={() => setCreating(true)}>＋ 新建</button>
          <OverflowMenu align="right" label="⚙️" items={[
            { label: '📥 收件箱', badge: inboxCount > 0 ? String(inboxCount) : undefined, onClick: onOpenInbox },
            { label: '🎙️ 录入情报', primary: true, onClick: onOpenIntel },
            ...settingsItems,
          ]} />
        </div>
      </div>

      {/* P5 今日三件事：逾期行动 / 巡检提醒 / 最大缺口 三源聚合，点击直达客户 */}
      {today.length > 0 && accounts.length > 0 && (
        <div className="hub-today">
          <div className="hub-today-head">📌 今日三件事</div>
          {today.map((t, i) => (
            <button key={i} className="hub-today-item" onClick={() => onOpen(t.accId)}>
              <span className="ht-ico">{t.icon}</span>
              <span className="ht-text">{t.text}</span>
              <span className="ht-sub">{t.sub}</span>
              <span className="ht-go">›</span>
            </button>
          ))}
        </div>
      )}

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
          {[...accounts].sort((a, b) => (needsYou?.get(b.id) ?? 0) - (needsYou?.get(a.id) ?? 0)).map((a) => (
            <div key={a.id} className="acc-card" onClick={() => onOpen(a.id)}>
              <div className="acc-card-top">
                <div className="acc-emoji">🏢</div>
                {(needsYou?.get(a.id) ?? 0) > 0 && (
                  <span className="acc-needs" title="待你拍板的候选/提案/提醒 + 逾期行动">需要你 · {needsYou!.get(a.id)}</span>
                )}
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
              {([1, 2, 3, 4] as CustomerType[]).map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABEL[t]}</option>)}
            </select>
          </label>
        </Modal>
      )}
    </div>
  );
}
