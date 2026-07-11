// AI 梳理层（P3）综述区：作战档案顶部「🤖 AI 整理·待核」现状综述。
// 懒生成(打开即取，后端按需调 LLM)；可编辑(保存→human-wins 锁定不被 AI 覆盖)；可↻重新梳理。
// 不覆盖原始(原始仍在下方各章)；不显示/不改分(趋赢力另算)。
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api';

const wrap: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: 12, margin: '8px 0 18px', background: 'var(--panel)' };
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 };
const badgeStyle: CSSProperties = { fontSize: 12, color: 'var(--muted)', fontWeight: 600 };
const bodyStyle: CSSProperties = { fontSize: 14, color: 'var(--ink)', lineHeight: 1.75, whiteSpace: 'pre-wrap' };
const mutedStyle: CSSProperties = { fontSize: 13, color: 'var(--muted)', margin: 0 };
const taStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--line)', borderRadius: 6, padding: 8, background: 'var(--panel)', color: 'var(--ink)', fontSize: 14, lineHeight: 1.7 };

export function CuratedSummary({ entityKind, entityId, readonly = false }: { entityKind: 'account' | 'opportunity'; entityId: string; readonly?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');
  const [edited, setEdited] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    setLoading(true); setErr('');
    try { const r = await api.curatedGet(entityKind, entityId); setContent(r.content || ''); setStatus(r.status); setEdited(!!r.editedByHuman); }
    catch (e: any) { setErr('加载失败：' + (e?.message || e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [entityKind, entityId]);

  const regen = async () => {
    if (edited && !window.confirm('重新梳理会用 AI 结果覆盖你编辑过的综述，继续？')) return;
    setBusy(true); setErr('');
    try {
      const r = await api.curatedRegen(entityKind, entityId);
      setContent(r.content || ''); setStatus(r.status); setEdited(!!r.editedByHuman);
      if (r.status === 'needConfig') setErr('未配置 AI 模型，无法梳理（在「🧠 AI 模型」里配置）');
      if (r.status === 'error') setErr('梳理失败：' + (r.error || ''));
    } catch (e: any) { setErr('梳理失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setErr('');
    try { await api.curatedSave(entityKind, entityId, draft); setContent(draft); setEdited(true); setStatus('human'); setEditing(false); }
    catch (e: any) { setErr('保存失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const hint = readonly ? '暂无综述。'
    : status === 'needConfig' ? '未配置 AI 模型，配置后打开即自动梳理零散记录。'
    : status === 'empty' ? '暂无可梳理的原始记录（笔记 / 拜访纪要 / 录音转写）。'
    : '点「↻ 重新梳理」生成综述。';

  return (
    <div style={wrap}>
      <div style={head}>
        <span style={badgeStyle}>{edited ? '✍️ 人工编辑（已锁定）' : '🤖 AI 整理 · 待核'}</span>
        <span style={{ flex: 1 }} />
        {!editing && !readonly && <button className="btn ghost sm" onClick={() => { setDraft(content); setEditing(true); }} disabled={busy || loading}>编辑</button>}
        {!editing && !readonly && <button className="btn ghost sm" onClick={regen} disabled={busy || loading} title={edited ? '会覆盖你的编辑' : ''}>{busy ? '整理中…' : '↻ 重新梳理'}</button>}
      </div>
      {loading ? <p style={mutedStyle}>加载中…</p>
        : editing ? (
          <>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} style={taStyle} placeholder="编辑综述…（保存后锁定，不被 AI 覆盖）" />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn primary sm" onClick={save} disabled={busy}>保存</button>
              <button className="btn ghost sm" onClick={() => setEditing(false)}>取消</button>
            </div>
          </>
        )
        : content ? <div style={bodyStyle}>{content}</div>
        : <p style={mutedStyle}>{hint}</p>}
      {err && <p style={{ color: 'var(--muted)', fontSize: 12, margin: '6px 0 0' }}>⚠️ {err}</p>}
    </div>
  );
}
