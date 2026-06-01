import type { Account, Role } from '../types';
import { ROLE_COLOR, ROLE_LABEL, SENTIMENT_CHAR, SENTIMENT_COLOR } from '../types';
import { usePersistentState } from '../ui';

const ROLES: Role[] = ['A', 'D', 'U', 'TB', 'R'];

export function Sidebar({
  account, currentOppId, onSelectOpp, selectedPersonId, onSelectPerson,
  onBack, onAddOpp, onDeleteOpp, onAddPerson, roleByPerson, onCollapse, theme, onToggleTheme,
}: {
  account: Account;
  currentOppId: string | null;
  onSelectOpp: (id: string) => void;
  selectedPersonId: string | null;
  onSelectPerson: (id: string) => void;
  onBack: () => void;
  onAddOpp: () => void;
  onDeleteOpp: (id: string) => void;
  onAddPerson: () => void;
  roleByPerson: Map<string, Role>;
  onCollapse: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}) {
  const [legendCollapsed, setLegendCollapsed] = usePersistentState('jianghu.legendCollapsed', false);
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button className="back-btn" onClick={onBack} title="返回客户列表">‹</button>
        <div className="logo">江</div>
        <div className="sidebar-title">{account.name}<small>{account.persons.length} 干系人 · {account.opportunities.length} 商机</small></div>
        <button className="theme-toggle" onClick={onToggleTheme} title={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}>{theme === 'dark' ? '☀️' : '🌙'}</button>
        <button className="collapse-btn" onClick={onCollapse} title="折叠侧边栏">«</button>
      </div>

      <div className="sidebar-body">
        <div className="sb-row"><span className="sb-label">商机</span><button className="add-mini" onClick={onAddOpp}>＋</button></div>
        <div className="nav-sub">
          {account.opportunities.length === 0 && <div className="empty-hint" style={{ padding: '4px 8px' }}>暂无商机，点 ＋ 新建</div>}
          {account.opportunities.map((o) => (
            <div key={o.id} className={`nav-opp${o.id === currentOppId ? ' active' : ''}`} onClick={() => onSelectOpp(o.id)}>
              <div className="nav-opp-name">🎯 {o.name}</div>
              <div className="row-between">
                <span className="stage">{o.pipelineStage}</span>
                <button className="row-del" onClick={(e) => { e.stopPropagation(); if (confirm(`删除商机「${o.name}」？`)) onDeleteOpp(o.id); }}>🗑</button>
              </div>
            </div>
          ))}
        </div>

        <div className="sb-row" style={{ marginTop: 16 }}><span className="sb-label">干系人</span><button className="add-mini" onClick={onAddPerson}>＋</button></div>
        <div className="person-list">
          {account.persons.length === 0 && <div className="empty-hint" style={{ padding: '4px 8px' }}>暂无干系人，点 ＋ 新建</div>}
          {account.persons.map((p) => {
            const role = roleByPerson.get(p.id);
            return (
              <div key={p.id} className={`person-row${p.id === selectedPersonId ? ' active' : ''}`} onClick={() => onSelectPerson(p.id)}>
                {role ? <span className="role-dot" style={{ background: ROLE_COLOR[role] }}>{role}</span>
                  : <span className="role-dot" style={{ background: '#cbd5e1' }}>·</span>}
                <span className="person-row-name">{p.name}</span>
                <span className="person-row-title">{p.isCompetitor ? '竞品' : p.title}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className={`legend${legendCollapsed ? ' collapsed' : ''}`}>
        <button className="legend-toggle" onClick={() => setLegendCollapsed((c) => !c)}
          title={legendCollapsed ? '展开图例' : '收起图例（让干系人列表显示更多）'}>
          <span>图例</span>
          <span className="legend-arr">{legendCollapsed ? '⌃' : '⌄'}</span>
        </button>
        {!legendCollapsed && (
          <div className="legend-body">
            <div className="sb-label">角色</div>
            <div className="legend-grid">
              {ROLES.map((r) => <div className="it" key={r}><span className="dot" style={{ background: ROLE_COLOR[r] }}>{r}</span>{ROLE_LABEL[r]}</div>)}
            </div>
            <div className="sb-label" style={{ marginTop: 10 }}>支持度</div>
            <div className="legend-grid">
              {(['star', 'plus', 'neutral', 'unknown', 'minus', 'x'] as const).map((s) => (
                <div className="it" key={s}><b style={{ color: SENTIMENT_COLOR[s], width: 12, textAlign: 'center' }}>{SENTIMENT_CHAR[s]}</b>
                  {s === 'star' ? '排他' : s === 'plus' ? '支持' : s === 'neutral' ? '中立' : s === 'unknown' ? '未知' : s === 'minus' ? '负面' : '倒戈'}</div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
