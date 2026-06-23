import { useMemo, useState } from 'react';
import type { Account, Opportunity, Role, Sentiment } from '../types';
import { ROLE_LABEL, SENTIMENT_LABEL, FAMILY_7Q } from '../types';
import { Modal } from './Modal';

// 干系人完整度（与画布同口径）
function completeness(p: Account['persons'][number]): number {
  const dims = [p.form.family, p.form.occupation, p.form.recreation, p.form.moneyMotivation].filter((d) => d.trim()).length;
  const fam = FAMILY_7Q.filter((q) => (p.form.family7[q] ?? '').trim()).length;
  return Math.round((dims / 4) * 50 + (fam / 7) * 50);
}

interface Row {
  id: string; name: string; title: string; orgLevel: number; isCompetitor: boolean;
  role: Role | null; roleLabel: string; sentiment: Sentiment | null; sentimentLabel: string;
  isKeyInfluencer: boolean; completeness: number; biCount: number; logCount: number;
}

type GroupBy = 'none' | 'role' | 'orgLevel';
type SortBy = 'name' | 'completeness' | 'role' | 'sentiment';

const ORG_LEVEL_LABEL: Record<number, string> = { 1: 'L1 高层', 2: 'L2 中层', 3: 'L3 执行层', 4: 'L4 外围' };

export function ReportPanel({
  account, opp, onClose,
}: {
  account: Account;
  opp: Opportunity;
  onClose: () => void;
}) {
  // 筛选条件
  const [fRole, setFRole] = useState<'all' | Role>('all');
  const [fSentiment, setFSentiment] = useState<'all' | Sentiment>('all');
  const [includeCompetitor, setIncludeCompetitor] = useState(true);
  const [onlyKeyInfluencer, setOnlyKeyInfluencer] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>('role');
  const [sortBy, setSortBy] = useState<SortBy>('role');

  const roleByPerson = useMemo(() => {
    const m = new Map<string, (typeof opp.roles)[number]>();
    for (const r of opp.roles) m.set(r.personId, r);
    return m;
  }, [opp.roles]);

  // 组装行
  const allRows: Row[] = useMemo(() => account.persons.map((p) => {
    const r = roleByPerson.get(p.id);
    return {
      id: p.id, name: p.name, title: p.title, orgLevel: p.orgLevel, isCompetitor: !!p.isCompetitor,
      role: r?.role ?? null, roleLabel: r ? ROLE_LABEL[r.role] : '未指派',
      sentiment: r?.sentiment ?? null, sentimentLabel: r ? SENTIMENT_LABEL[r.sentiment] : '—',
      isKeyInfluencer: !!r?.isKeyInfluencer,
      completeness: completeness(p),
      biCount: opp.bis.filter((b) => b.personId === p.id).length,
      logCount: p.logs.length,
    };
  }), [account.persons, roleByPerson, opp.bis]);

  // 筛选
  const rows = useMemo(() => {
    let rs = allRows;
    if (!includeCompetitor) rs = rs.filter((r) => !r.isCompetitor);
    if (fRole !== 'all') rs = rs.filter((r) => r.role === fRole);
    if (fSentiment !== 'all') rs = rs.filter((r) => r.sentiment === fSentiment);
    if (onlyKeyInfluencer) rs = rs.filter((r) => r.isKeyInfluencer);
    const ROLE_ORDER: Record<string, number> = { A: 0, D: 1, U: 2, R: 3, C: 4 };
    const sorters: Record<SortBy, (a: Row, b: Row) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, 'zh'),
      completeness: (a, b) => b.completeness - a.completeness,
      role: (a, b) => (ROLE_ORDER[a.role ?? ''] ?? 9) - (ROLE_ORDER[b.role ?? ''] ?? 9),
      sentiment: (a, b) => (b.sentiment ? 1 : 0) - (a.sentiment ? 1 : 0),
    };
    return [...rs].sort(sorters[sortBy]);
  }, [allRows, includeCompetitor, fRole, fSentiment, onlyKeyInfluencer, sortBy]);

  // 分组
  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: '全部干系人', rows }];
    const map = new Map<string, Row[]>();
    for (const r of rows) {
      const key = groupBy === 'role' ? (r.isCompetitor ? '友商' : r.roleLabel)
        : (ORG_LEVEL_LABEL[r.orgLevel] ?? `L${r.orgLevel}`);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()].map(([key, rs]) => ({ key, rows: rs }));
  }, [rows, groupBy]);

  const COLS = ['姓名', '职务', '组织层级', '角色', '支持度', '关键影响人', '完整度%', '燃眉之急', '互动记录'];
  const rowCells = (r: Row): (string | number)[] => [
    r.name, r.title, ORG_LEVEL_LABEL[r.orgLevel] ?? `L${r.orgLevel}`,
    r.isCompetitor ? '友商' : r.roleLabel, r.sentimentLabel, r.isKeyInfluencer ? '是' : '',
    r.completeness, r.biCount, r.logCount,
  ];

  // 导出 PDF：用浏览器打印（中文友好、零依赖）。打印样式只显示报表节点。
  const exportPDF = () => window.print();

  // 导出 Excel：CSV + UTF-8 BOM（Excel 中文不乱码）
  const exportCSV = () => {
    const esc = (v: string | number) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines: string[] = [];
    lines.push(`江湖 · 干系人报表 — ${account.name} / ${opp.name}`);
    lines.push('');
    for (const g of groups) {
      if (groupBy !== 'none') lines.push(esc(`【${g.key}】（${g.rows.length}）`));
      lines.push(COLS.map(esc).join(','));
      for (const r of g.rows) lines.push(rowCells(r).map(esc).join(','));
      lines.push('');
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const today = new Date().toISOString().slice(0, 10);
    a.href = url; a.download = `江湖干系人报表_${account.name}_${today}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="📊 干系人报表 · 筛选 / 分组 / 排序 → 导出" width={860} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ margin: 0, marginRight: 'auto' }}>共 {rows.length} 人 · {groups.length} 组</span>
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn ghost" onClick={exportCSV}>⬇ 导出 Excel(CSV)</button>
        <button className="btn primary" onClick={exportPDF}>🖨 导出 PDF</button>
      </>}>

      {/* 控制条 */}
      <div className="rep-controls no-print">
        <label className="rep-ctl"><span>角色筛选</span>
          <select value={fRole} onChange={(e) => setFRole(e.target.value as any)}>
            <option value="all">全部角色</option>
            {(['A', 'D', 'U', 'R', 'C'] as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          </select>
        </label>
        <label className="rep-ctl"><span>支持度筛选</span>
          <select value={fSentiment} onChange={(e) => setFSentiment(e.target.value as any)}>
            <option value="all">全部支持度</option>
            {(['star', 'plus', 'neutral', 'unknown', 'minus', 'x'] as Sentiment[]).map((s) => <option key={s} value={s}>{SENTIMENT_LABEL[s]}</option>)}
          </select>
        </label>
        <label className="rep-ctl"><span>分组方式</span>
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
            <option value="role">按角色</option>
            <option value="orgLevel">按组织层级</option>
            <option value="none">不分组</option>
          </select>
        </label>
        <label className="rep-ctl"><span>排序</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
            <option value="role">按角色</option>
            <option value="name">按姓名</option>
            <option value="completeness">按完整度</option>
            <option value="sentiment">按支持度有无</option>
          </select>
        </label>
        <label className="rep-chk"><input type="checkbox" checked={includeCompetitor} onChange={(e) => setIncludeCompetitor(e.target.checked)} />含友商</label>
        <label className="rep-chk"><input type="checkbox" checked={onlyKeyInfluencer} onChange={(e) => setOnlyKeyInfluencer(e.target.checked)} />仅关键影响人</label>
      </div>

      {/* 报表预览（也是打印内容） */}
      <div className="report-print" id="report-print">
        <div className="rep-title">
          <h2>{account.name} · 干系人作战报表</h2>
          <div className="rep-sub">商机：{opp.name} · 阶段：{opp.pipelineStage} · 导出 {new Date().toLocaleDateString('zh-CN')} · 共 {rows.length} 人</div>
        </div>
        {rows.length === 0 ? (
          <div className="empty-hint" style={{ padding: 20 }}>当前筛选条件下没有干系人。</div>
        ) : groups.map((g) => (
          <div key={g.key} className="rep-group">
            {groupBy !== 'none' && <div className="rep-group-h">{g.key} <span>（{g.rows.length}）</span></div>}
            <table className="rep-table">
              <thead><tr>{COLS.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {g.rows.map((r) => (
                  <tr key={r.id}>
                    {rowCells(r).map((c, i) => <td key={i} className={i >= 6 ? 'num' : ''}>{c === '' ? '—' : c}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </Modal>
  );
}
