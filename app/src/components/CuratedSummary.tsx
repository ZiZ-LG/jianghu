import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { api } from '../api';

const wrap: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  margin: '8px 0 18px',
  background: 'var(--panel)',
};
const summaryStyle: CSSProperties = {
  cursor: 'pointer',
  padding: 12,
  color: 'var(--muted)',
  fontSize: 12,
  fontWeight: 600,
};
const contentWrap: CSSProperties = { padding: '0 12px 12px' };
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 };
const badgeStyle: CSSProperties = { fontSize: 12, color: 'var(--muted)', fontWeight: 600 };
const bodyStyle: CSSProperties = {
  fontSize: 14,
  color: 'var(--ink)',
  lineHeight: 1.75,
  whiteSpace: 'pre-wrap',
};
const mutedStyle: CSSProperties = { fontSize: 13, color: 'var(--muted)', margin: 0 };
const taStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--line)',
  borderRadius: 6,
  padding: 8,
  background: 'var(--panel)',
  color: 'var(--ink)',
  fontSize: 14,
  lineHeight: 1.7,
};

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function CuratedSummary({
  entityKind,
  entityId,
  readonly = false,
}: {
  entityKind: 'account' | 'opportunity';
  entityId: string;
  readonly?: boolean;
}) {
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState('');
  const [edited, setEdited] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setErr('');
    void api.curatedGet(entityKind, entityId)
      .then((result) => {
        if (!active) return;
        setContent(result.content || '');
        setStatus(result.status);
        setEdited(Boolean(result.editedByHuman));
      })
      .catch((cause: unknown) => {
        if (active) setErr(`加载失败：${errorMessage(cause)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [entityKind, entityId]);

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.curatedSave(entityKind, entityId, draft);
      setContent(draft);
      setEdited(true);
      setStatus('human');
      setEditing(false);
    } catch (cause: unknown) {
      setErr(`保存失败：${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = edited || status === 'human'
    ? '人工维护'
    : status === 'compatibility_cache'
      ? '旧 AI 缓存 · 非权威'
      : '无可用兼容资料';
  const hint = status === 'restricted'
    ? '当前角色无权查看该客户的兼容资料。'
    : '暂无人工综述或可安全复用的旧资料。';

  return (
    <details style={wrap} className="curated-compatibility-input">
      <summary style={summaryStyle}>兼容资料输入 · 非拜访简报权威</summary>
      <div style={contentWrap}>
        <div style={head}>
          <span style={badgeStyle}>{statusLabel}</span>
          <span style={{ flex: 1 }} />
          {!editing && !readonly && (
            <button
              className="btn ghost sm"
              onClick={() => { setDraft(content); setEditing(true); }}
              disabled={busy || loading}
            >
              编辑人工资料
            </button>
          )}
        </div>
        {loading ? <p style={mutedStyle}>加载中…</p>
          : editing ? (
            <>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                rows={6}
                style={taStyle}
                placeholder="编辑兼容资料…（人工内容保持最高优先级）"
              />
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <button className="btn primary sm" onClick={() => { void save(); }} disabled={busy}>保存</button>
                <button className="btn ghost sm" onClick={() => setEditing(false)} disabled={busy}>取消</button>
              </div>
            </>
          )
          : content ? <div style={bodyStyle}>{content}</div>
          : <p style={mutedStyle}>{hint}</p>}
        {err && <p style={{ color: 'var(--muted)', fontSize: 12, margin: '6px 0 0' }}>⚠️ {err}</p>}
      </div>
    </details>
  );
}
