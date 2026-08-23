// 作战档案面板（路 A · 字段内联编辑）：左侧导航选文档，右侧 MdDocView 文档视图（点字段原地改、失焦写回系统）。
// 导出/复制用 mdProfile 渲染的 .md 文本（实时反映系统数据）；版本日志走 localStorage（决策 b）。
import { useEffect, useMemo, useState } from 'react';
import { customerTypeLabel, type Account } from '../types';
import { renderCustomerMd, renderOpportunityMd, renderVisitMd, type VersionLogEntry, type PdeBrief } from '../lib/mdProfile';
import type { Action } from '../store';
import { usePersistentState } from '../ui';
import { Modal } from './Modal';
import { MdDocView } from './MdDocView';
import { api } from '../api';
import { ACT_LABEL } from '../lib/pdeUi';
import { localYmd } from '../lib/dateYmd';

type DocSel = { kind: 'customer' } | { kind: 'opp'; id: string } | { kind: 'visit'; id: string };
const keyOf = (s: DocSel) => (s.kind === 'customer' ? 'customer' : `${s.kind}:${s.id}`);
const today = () => localYmd(new Date());
const bumpVersion = (log: VersionLogEntry[]) =>
  log.length ? `v${(parseFloat(log[log.length - 1].version.replace(/^v/, '')) + 0.1).toFixed(1)}` : 'v1.0';

export function MdDocPanel({ account, dispatch, onClose, readonly = false }: { account: Account; dispatch: (a: Action) => void; onClose: () => void; readonly?: boolean }) {
  const [sel, setSel] = useState<DocSel>({ kind: 'customer' });
  const [logs, setLogs] = usePersistentState<Record<string, VersionLogEntry[]>>(`jianghu.mdlog.${account.id}`, {});
  const [copied, setCopied] = useState(false);

  const visits = account.visitNotes ?? [];
  const docKey = keyOf(sel);
  const isVisit = sel.kind === 'visit';

  // P15：切到商机档案时懒 fetch PDE 摘要 + 走势（用于新增的引擎裁决章）；失败/无 → null 该章跳过
  const [pdeByOpp, setPdeByOpp] = useState<Record<string, PdeBrief | null>>({});
  useEffect(() => {
    if (sel.kind !== 'opp' || sel.id in pdeByOpp) return;
    const oppId = sel.id;
    const nameById = new Map(account.persons.map((p) => [p.id, p.name]));
    (async () => {
      try {
        const [ev, sns] = await Promise.all([
          api.pdeEv(oppId).catch(() => null),
          api.pdeSnapshots(oppId).catch(() => ({ snapshots: [] })),
        ]);
        if (!ev) return setPdeByOpp((m) => ({ ...m, [oppId]: null }));
        const rec = ev.recommendation ?? {};
        const act = ACT_LABEL[rec.action];
        const weakNames = (rec.weak_key_stakeholders ?? []).map((id: string) => nameById.get(id) ?? id).slice(0, 4);
        const snapshots = (sns?.snapshots ?? []).slice(-3);
        const trend = snapshots.length >= 2
          ? snapshots.map((s: any) => `${Math.round((s.pwin ?? 0) * 100)}%`).join(' → ') + `（近${snapshots.length}次）`
          : undefined;
        const brief: PdeBrief = {
          pwin: ev.pwin, action: rec.action, actionLabel: act ? `${act.icon} ${act.text}` : rec.action,
          reason: rec.reason, weakNames, nominal: ev.score?.nominal, weighted: ev.score?.weighted,
          snapshotsTrend: trend,
          gate: (ev.confidenceFlag ?? '').includes('no_pot') ? 'no_pot' : (ev.confidenceFlag ?? '').includes('low_confidence') ? 'low_confidence' : 'clear',
        };
        setPdeByOpp((m) => ({ ...m, [oppId]: brief }));
      } catch { setPdeByOpp((m) => ({ ...m, [oppId]: null })); }
    })();
  }, [sel, account.persons, pdeByOpp]);

  const mdText = useMemo(() => {
    if (sel.kind === 'customer') return renderCustomerMd(account, logs.customer ?? []);
    if (sel.kind === 'opp') { const o = account.opportunities.find((x) => x.id === sel.id); return o ? renderOpportunityMd(account, o, logs[docKey] ?? [], pdeByOpp[sel.id]) : ''; }
    const vn = visits.find((x) => x.id === sel.id); return vn ? renderVisitMd(account, vn) : '';
  }, [sel, account, logs, docKey, visits, pdeByOpp]);

  const title = sel.kind === 'customer' ? `${account.name}-客户档案`
    : sel.kind === 'opp' ? `${account.opportunities.find((o) => o.id === sel.id)?.name ?? '商机'}-商机档案`
    : `拜访-${visits.find((v) => v.id === sel.id)?.date ?? ''}`;

  const stamp = () => {
    const cur = logs[docKey] ?? [];
    const entry: VersionLogEntry = { version: bumpVersion(cur), date: today(), editor: '', summary: '手动记录版本', trigger: '作战档案' };
    setLogs({ ...logs, [docKey]: [...cur, entry] });
  };
  const exportMd = () => {
    const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `${title}.md`; a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(mdText); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* 不支持 */ } };

  const navItem = (s: DocSel, label: string, sub?: string) => {
    const active = keyOf(s) === docKey;
    return (
      <button type="button" key={keyOf(s)} className={`md-nav-item${active ? ' active' : ''}`} onClick={() => setSel(s)} aria-pressed={active}
        style={{ width: '100%', padding: '7px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', background: active ? 'var(--hover)' : 'transparent', borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent' }}>
        <div style={{ fontSize: 13, fontWeight: active ? 600 : 400 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, opacity: 0.6 }}>{sub}</div>}
      </button>
    );
  };

  return (
    <Modal title="📋 作战档案" width={960} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ marginRight: 'auto', fontSize: 12, opacity: 0.7 }}>
          {readonly ? '只读投影 · 一切修改经数字员工（销售包）收口同步' : '点字段原地改、失焦即写回系统 · 打分与角色只读（在画布改）'}
          <span style={{ display: 'block', fontSize: 11, opacity: 0.75, marginTop: 2 }}>💡 .md 用途：复制→喂给外部 AI 深聊 / 粘进 WorkBuddy；导出→归档 / 发同事 / Git 版本追踪</span>
        </span>
        {!isVisit && !readonly && <button className="btn ghost" onClick={stamp} title="在 .md 更新日志记一版（数据已实时写回）">🔖 记一版</button>}
        <button className="btn ghost" onClick={copy} title="复制到剪贴板——喂给外部 AI 深聊 / 粘进 WorkBuddy / 贴到内部知识库">{copied ? '✓ 已复制' : '📋 复制 .md'}</button>
        <button className="btn primary" onClick={exportMd} title="下载 .md 文件——归档、随邮件发同事、Git 里做长期版本追踪">⬇ 导出 .md</button>
      </>}>
      <div style={{ display: 'flex', gap: 12, height: 'min(66vh, 580px)' }}>
        <div style={{ width: 220, flexShrink: 0, overflowY: 'auto', borderRight: '1px solid var(--line)', paddingRight: 8 }}>
          <div className="sb-label" style={{ margin: '4px 0' }}>客户档案</div>
          {navItem({ kind: 'customer' }, '📇 ' + account.name, CUSTOMER_TYPE_LABEL_short(account))}
          <div className="sb-label" style={{ margin: '12px 0 4px' }}>商机档案 · {account.opportunities.length}</div>
          {account.opportunities.length === 0 && <div className="hint-text" style={{ fontSize: 12, opacity: 0.5, padding: '0 10px' }}>暂无商机</div>}
          {account.opportunities.map((o) => navItem({ kind: 'opp', id: o.id }, '🎯 ' + o.name, o.pipelineStage))}
          <div className="sb-label" style={{ margin: '12px 0 4px' }}>拜访记录 · {visits.length}</div>
          {visits.length === 0 && <div className="hint-text" style={{ fontSize: 12, opacity: 0.5, padding: '0 10px' }}>暂无拜访</div>}
          {visits.map((vn) => navItem({ kind: 'visit', id: vn.id }, '🗓️ ' + (vn.date || '—'), vn.topic || '拜访'))}
        </div>
        <div className="mdv-scroll" style={{ flex: 1, overflow: 'auto', padding: '0 16px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)' }}>
          <MdDocView account={account} sel={sel} dispatch={dispatch} readonly={readonly} />
        </div>
      </div>
    </Modal>
  );
}

function CUSTOMER_TYPE_LABEL_short(account: Account): string {
  const map: Record<number, string> = { 1: '央企发电', 2: '地方国企', 3: '分布式民企', 4: 'EPC总包' };
  return account.customerType === null ? customerTypeLabel(null) : map[account.customerType];
}
