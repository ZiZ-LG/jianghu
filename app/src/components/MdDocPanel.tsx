// MD 档案面板（块B · 系统→MD 视图）：客户档案 / 商机档案 / 拜访记录三类 .md 的查看 + 更新 + 导出。
// 左侧导航选文档，右侧显示渲染出的 .md（可编辑为本地草稿）。「更新档案」从系统重生成并在更新日志追加版本(+0.1)。
// 版本日志/草稿走 .md 侧（localStorage，决策 b）；改动回写系统在块C（双向回写）实现。
import { useMemo, useState } from 'react';
import type { Account } from '../types';
import { renderCustomerMd, renderOpportunityMd, renderVisitMd, type VersionLogEntry } from '../lib/mdProfile';
import { diffCustomer, diffOpportunity, diffVisit, type MdApplyResult } from '../lib/mdParse';
import type { Action } from '../store';
import { usePersistentState } from '../ui';
import { Modal } from './Modal';

type DocSel = { kind: 'customer' } | { kind: 'opp'; id: string } | { kind: 'visit'; id: string };
const keyOf = (s: DocSel) => (s.kind === 'customer' ? 'customer' : `${s.kind}:${s.id}`);
const today = () => new Date().toISOString().slice(0, 10);
const bumpVersion = (log: VersionLogEntry[]) =>
  log.length ? `v${(parseFloat(log[log.length - 1].version.replace(/^v/, '')) + 0.1).toFixed(1)}` : 'v1.0';

export function MdDocPanel({ account, onApply, onClose }: { account: Account; onApply: (actions: Action[]) => void; onClose: () => void }) {
  const [sel, setSel] = useState<DocSel>({ kind: 'customer' });
  // 版本日志：按客户隔离，map 文档 key → 日志数组（localStorage 持久化，决策 b）
  const [logs, setLogs] = usePersistentState<Record<string, VersionLogEntry[]>>(`jianghu.mdlog.${account.id}`, {});
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // 会话级编辑草稿
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<MdApplyResult | null>(null); // 回写确认队列（diff 预览）
  const [writeMsg, setWriteMsg] = useState('');

  const visits = account.visitNotes ?? [];
  const docKey = keyOf(sel);
  const isVisit = sel.kind === 'visit';

  const generated = useMemo(() => {
    if (sel.kind === 'customer') return renderCustomerMd(account, logs.customer ?? []);
    if (sel.kind === 'opp') {
      const o = account.opportunities.find((x) => x.id === sel.id);
      return o ? renderOpportunityMd(account, o, logs[docKey] ?? []) : '（商机不存在）';
    }
    const vn = visits.find((x) => x.id === sel.id);
    return vn ? renderVisitMd(account, vn) : '（拜访记录不存在）';
  }, [sel, account, logs, docKey, visits]);

  const content = drafts[docKey] ?? generated;
  const dirty = drafts[docKey] !== undefined && drafts[docKey] !== generated;

  const title = sel.kind === 'customer' ? `${account.name}-客户档案`
    : sel.kind === 'opp' ? `${account.opportunities.find((o) => o.id === sel.id)?.name ?? '商机'}-商机档案`
    : `拜访-${visits.find((v) => v.id === sel.id)?.date ?? ''}`;

  // 更新档案：丢草稿、从系统重生成；非拜访则在版本日志追加一行(+0.1)
  const refresh = () => {
    if (!isVisit) {
      const cur = logs[docKey] ?? [];
      const entry: VersionLogEntry = { version: bumpVersion(cur), date: today(), editor: '', summary: '从系统刷新（数据为准）', trigger: '手动更新档案' };
      setLogs({ ...logs, [docKey]: [...cur, entry] });
    }
    setDrafts((d) => { const n = { ...d }; delete n[docKey]; return n; });
  };

  // 回写系统（块C）：解析当前草稿 → diff 出改动 → 确认 → 走既有 UPDATE_* Action 落库（仅文本/勾选白名单）
  const writeBack = () => {
    const o = sel.kind === 'opp' ? account.opportunities.find((x) => x.id === sel.id) : undefined;
    const vn = sel.kind === 'visit' ? visits.find((x) => x.id === sel.id) : undefined;
    const d: MdApplyResult = sel.kind === 'customer' ? diffCustomer(account, content)
      : sel.kind === 'opp' ? (o ? diffOpportunity(account, o, content) : { actions: [], changes: [] })
        : (vn ? diffVisit(account, vn, content) : { actions: [], changes: [] });
    if (!d.changes.length) { setWriteMsg('未检测到可回写改动（打分表/角色表/行动计划为只读，不回写）'); setTimeout(() => setWriteMsg(''), 3500); return; }
    setPending(d);
  };
  const confirmWrite = () => {
    if (!pending) return;
    onApply(pending.actions);
    if (!isVisit) {
      const cur = logs[docKey] ?? [];
      setLogs({ ...logs, [docKey]: [...cur, { version: bumpVersion(cur), date: today(), editor: '', summary: `从 .md 回写 ${pending.changes.length} 处`, trigger: 'MD 双向回写' }] });
    }
    setDrafts((d) => { const n = { ...d }; delete n[docKey]; return n; }); // 清草稿，回写后以系统为准重新生成
    setPending(null);
  };

  const exportMd = () => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${title}.md`; a.click();
    URL.revokeObjectURL(url);
  };
  const copy = async () => { try { await navigator.clipboard.writeText(content); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* 不支持 */ } };

  const navItem = (s: DocSel, label: string, sub?: string) => {
    const active = keyOf(s) === docKey;
    return (
      <div key={keyOf(s)} className={`md-nav-item${active ? ' active' : ''}`} onClick={() => setSel(s)}
        style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', background: active ? 'var(--hover)' : 'transparent', borderLeft: active ? '3px solid var(--accent)' : '3px solid transparent' }}>
        <div style={{ fontSize: 13, fontWeight: active ? 600 : 400 }}>{label}</div>
        {sub && <div style={{ fontSize: 11, opacity: 0.6 }}>{sub}</div>}
      </div>
    );
  };

  return (
    <Modal title="📄 档案（.md）" width={920} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ marginRight: 'auto', fontSize: 12, opacity: 0.7 }}>
          {writeMsg || (dirty ? '✏️ 已编辑（本地草稿）· 可回写系统，或更新档案丢弃草稿' : '系统 → MD 实时生成 · 编辑后可回写系统')}
        </span>
        {dirty && <button className="btn" onClick={writeBack} title="解析草稿改动，确认后写回系统（仅文本字段/勾选；打分表、角色表、行动计划为只读不回写）">✍️ 回写系统</button>}
        {!isVisit && <button className="btn ghost" onClick={refresh} title="丢弃草稿，从系统当前数据重生成，并在更新日志记一版">🔄 更新档案</button>}
        <button className="btn ghost" onClick={copy}>{copied ? '✓ 已复制' : '📋 复制'}</button>
        <button className="btn primary" onClick={exportMd}>⬇ 导出 .md</button>
      </>}>
      <div style={{ display: 'flex', gap: 12, height: 'min(64vh, 560px)', position: 'relative' }}>
        {/* 左侧导航 */}
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

        {/* 右侧 .md 内容（可编辑草稿） */}
        <textarea
          value={content}
          onChange={(e) => setDrafts((d) => ({ ...d, [docKey]: e.target.value }))}
          spellCheck={false}
          style={{
            flex: 1, resize: 'none', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12.5, lineHeight: 1.6, padding: 12, borderRadius: 8, border: '1px solid var(--line)',
            background: 'var(--panel)', color: 'var(--ink)', whiteSpace: 'pre', overflow: 'auto',
          }}
        />

        {/* 回写确认 overlay：逐条列出将写回系统的改动（from → to） */}
        {pending && (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 8, padding: 16, display: 'flex', flexDirection: 'column', zIndex: 5 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>确认回写系统 · {pending.changes.length} 处改动</div>
            <div className="hint-text" style={{ fontSize: 12, opacity: 0.65, marginBottom: 8 }}>仅以下字段写回（走乐观锁，若期间被他人改动会提示刷新）；打分表 / 角色表 / 行动计划不在内。</div>
            <div style={{ flex: 1, overflowY: 'auto', fontSize: 13, border: '1px solid var(--line)', borderRadius: 6, padding: '4px 10px' }}>
              {pending.changes.map((c, i) => (
                <div key={i} style={{ padding: '7px 0', borderBottom: i < pending.changes.length - 1 ? '1px solid var(--line)' : 'none' }}>
                  <div style={{ opacity: 0.6, fontSize: 12, marginBottom: 2 }}>{c.section}</div>
                  <div><span style={{ color: 'var(--faint)', textDecoration: 'line-through', opacity: 0.7 }}>{c.from || '（空）'}</span>　→　<span style={{ color: 'var(--accent)', fontWeight: 500 }}>{c.to || '（空）'}</span></div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
              <button className="btn ghost" onClick={() => setPending(null)}>取消</button>
              <button className="btn primary" onClick={confirmWrite}>确认回写 {pending.changes.length} 处</button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// 客户类型短标签（导航副标题用）。避免在导航里引入额外 import 链路。
function CUSTOMER_TYPE_LABEL_short(account: Account): string {
  const map: Record<number, string> = { 1: '央企发电', 2: '地方国企', 3: '分布式民企', 4: 'EPC总包' };
  return map[account.customerType] ?? `类型${account.customerType}`;
}
