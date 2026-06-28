// 录音接入面板（薄入口）：从录音源拉转写（加密存）→ 列表 → 抽取成图（复用 voice 双轨，候选进收件箱人审）。
// 第一刀：mock 源端到端；得到大脑 MCP / 飞书 · 钉钉 OpenAPI 真实源待 BYO 凭据接入。
// PIPL：转写原文加密存储、按工作区隔离、可降解（清原文留记录）、可删。
import { useEffect, useState } from 'react';
import { api, type Transcript } from '../api';
import { Modal } from './Modal';
import { IntelReceipt } from './IntelReceipt';

const STATUS_LABEL: Record<string, string> = { active: '待抽取', extracted: '已抽取', redacted: '已降解' };
const fmtDur = (s: number) => (s > 0 ? `${Math.floor(s / 60)}分${s % 60}秒` : '');

export function RecordingPanel({ accountId, onClose, onExtracted }: {
  accountId?: string;
  onClose: () => void;
  onExtracted: () => void; // 抽取成功后回调：刷新整树 + 收件箱
}) {
  const [list, setList] = useState<Transcript[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);

  const load = async () => {
    try { setList((await api.recordingTranscripts(accountId)).transcripts); }
    catch (e: any) { setMsg('加载失败：' + (e?.message || e)); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [accountId]);

  const pull = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api.recordingPull({ source: 'mock', accountId });
      setMsg(`已拉取：新增 ${r.saved} 条、已存在 ${r.skipped} 条（${r.note}）`);
      await load();
    } catch (e: any) { setMsg('拉取失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const extract = async (t: Transcript) => {
    setExtractingId(t.id); setReceipt(null); setMsg('');
    try {
      const rc = await api.recordingExtract(t.id);
      setReceipt(rc);
      onExtracted();   // 刷新整树 + 收件箱（候选人审）
      await load();    // transcript 状态转 extracted
    } catch (e: any) { setMsg('抽取失败：' + (e?.message || e)); }
    finally { setExtractingId(null); }
  };

  const redact = async (t: Transcript) => {
    if (!window.confirm('降解后将清除该转写原文（保留记录元数据），不可再抽取。继续？')) return;
    try { await api.recordingRedact(t.id); await load(); } catch (e: any) { setMsg('降解失败：' + (e?.message || e)); }
  };
  const del = async (t: Transcript) => {
    if (!window.confirm('彻底删除该转写记录？')) return;
    try { await api.recordingDelete(t.id); await load(); } catch (e: any) { setMsg('删除失败：' + (e?.message || e)); }
  };

  const badge = (status: string) => (
    <span style={{
      fontSize: 11, padding: '1px 6px', borderRadius: 4,
      border: '1px solid var(--line)', color: 'var(--muted)',
    }}>{STATUS_LABEL[status] || status}</span>
  );

  return (
    <Modal title="🎧 录音接入" onClose={onClose} width={560}
      footer={<span style={{ fontSize: 12, color: 'var(--muted)' }}>转写原文加密存储、严格按工作区隔离，可随时降解 / 删除（PIPL 合规）。</span>}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <button className="btn primary sm" onClick={pull} disabled={busy}>{busy ? '⏳ 拉取中…' : '⬇️ 拉取拜访录音'}</button>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>来源：演示（mock）· 得到大脑 / 飞书 / 钉钉待配置凭据接入</span>
      </div>
      {msg && <div style={{ fontSize: 13, color: 'var(--ink)', margin: '6px 0' }}>{msg}</div>}
      {receipt && <div style={{ margin: '8px 0' }}><IntelReceipt receipt={receipt} /></div>}
      {list.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>还没有录音转写。点「拉取拜访录音」从录音源同步转写文字。</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((t) => (
            <li key={t.id} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
              border: '1px solid var(--line)', borderRadius: 6, background: 'var(--panel)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title || '(无标题)'}</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
                  {badge(t.status)}<span>{t.source}</span>{fmtDur(t.durationSec) && <span>· {fmtDur(t.durationSec)}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {t.hasContent && t.status !== 'extracted' && (
                  <button className="btn sm" onClick={() => extract(t)} disabled={extractingId === t.id}>{extractingId === t.id ? '整理中…' : '🪄 抽取成图'}</button>
                )}
                {t.hasContent && t.status === 'extracted' && (
                  <button className="btn ghost sm" onClick={() => extract(t)} disabled={extractingId === t.id}>↻ 重新抽取</button>
                )}
                {t.hasContent && <button className="btn ghost sm" onClick={() => redact(t)} title="清除原文，保留记录（PIPL 降解）">降解</button>}
                <button className="btn ghost sm" onClick={() => del(t)} title="彻底删除">🗑</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
