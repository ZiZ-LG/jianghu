// 录音接入面板：多源(飞书妙记 / 上传文件 / 得到大脑 / 演示) → 加密存 Transcript → 抽取成图(复用 voice 双轨，候选进收件箱)。
// 飞书=OAuth 授权后拉妙记转写(transcript:export)；上传=md/txt 文本(替代钉钉，钉钉听记无转写 API)；得到大脑=per-user token。
// PIPL：转写原文加密存储、按工作区隔离、可降解/删。租户级飞书 App 凭据由管理员配(加密，不回明文)。
import { useEffect, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import { api, newIdempotencyKey, type Transcript } from '../api';
import { Modal } from './Modal';
import { IntelReceipt } from './IntelReceipt';

const STATUS_LABEL: Record<string, string> = { active: '待抽取', extracted: '已抽取', redacted: '已降解' };
const fmtDur = (s: number) => (s > 0 ? `${Math.floor(s / 60)}分${s % 60}秒` : '');

type Source = 'feishu' | 'upload' | 'getnote' | 'mock';
const SOURCES: { key: Source; label: string }[] = [
  { key: 'feishu', label: '飞书妙记' },
  { key: 'upload', label: '上传文件' },
  { key: 'getnote', label: '得到大脑' },
  { key: 'mock', label: '演示' },
];

const inputStyle: CSSProperties = {
  padding: '6px 8px', border: '1px solid var(--line)', borderRadius: 4,
  background: 'var(--panel)', color: 'var(--ink)', fontSize: 13, marginBottom: 6, width: '100%', boxSizing: 'border-box',
};

export function RecordingPanel({ accountId, role, onClose, onExtracted, embedded }: {
  accountId?: string;
  role: string;
  onClose: () => void;
  onExtracted: () => void; // 抽取成功后回调：刷新整树 + 收件箱
  embedded?: boolean; // true=嵌入「＋添加情报」单入口（去掉自带 Modal 外壳）
}) {
  const [source, setSource] = useState<Source>('feishu');
  const [list, setList] = useState<Transcript[]>([]);
  const [creds, setCreds] = useState<Record<string, string>>({}); // source → status
  const [feishuCfg, setFeishuCfg] = useState<{ configured: boolean; appId: string; hasSecret: boolean; redirectUri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [showCfg, setShowCfg] = useState(false);
  const [cfgAppId, setCfgAppId] = useState('');
  const [cfgSecret, setCfgSecret] = useState('');
  const [getnoteApiKey, setGetnoteApiKey] = useState('');
  const [getnoteClientId, setGetnoteClientId] = useState('');
  const [feishuUrl, setFeishuUrl] = useState('');
  const [showFeishuUrl, setShowFeishuUrl] = useState(false);

  const isAdmin = role === 'owner' || role === 'admin';

  const load = async () => {
    try { setList((await api.recordingTranscripts(accountId)).transcripts); } catch (e: any) { setMsg('加载失败：' + (e?.message || e)); }
  };
  const loadCreds = async () => {
    try { const r = await api.recordingCredentials(); const m: Record<string, string> = {}; r.credentials.forEach((c) => { m[c.source] = c.status; }); setCreds(m); } catch { /* 忽略 */ }
  };
  const loadFeishuCfg = async () => {
    try { const c = await api.recordingFeishuConfig(); setFeishuCfg(c); setCfgAppId(c.appId); } catch { /* 忽略 */ }
  };
  useEffect(() => { void load(); void loadCreds(); void loadFeishuCfg(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [accountId]);

  const pull = async (src: Source) => {
    setBusy(true); setMsg('');
    try {
      const r = await api.recordingPull({ source: src as any, accountId });
      setMsg(`已拉取：新增 ${r.saved} 条、已存在 ${r.skipped} 条（${r.note}）`);
      await load();
    } catch (e: any) { setMsg('拉取失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const connectFeishu = async () => {
    setMsg('');
    try { const { authUrl } = await api.recordingFeishuOauthStart(); window.open(authUrl, '_blank'); setMsg('已打开飞书授权页，确认勾选含「离线访问」后回来点「一键拉取」。'); }
    catch (e: any) { setMsg('发起授权失败：' + (e?.message || e)); }
  };
  const pullFeishuOne = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api.recordingFeishuPull(feishuUrl.trim(), accountId);
      setMsg(`已拉取：${r.note}（新增 ${r.saved} 条），可在下方点「抽取成图」。`);
      setFeishuUrl('');
      await load();
    } catch (e: any) { setMsg('拉取失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };
  const feishuSync = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api.recordingFeishuSync(accountId);
      setMsg(`一键拉取：${r.note}。可在下方点「抽取成图」。`);
      await load();
    } catch (e: any) { setMsg('一键拉取失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const saveFeishuCfg = async () => {
    setBusy(true); setMsg('');
    try { const r = await api.recordingSaveFeishuConfig({ appId: cfgAppId.trim(), appSecret: cfgSecret.trim() || undefined }); setCfgSecret(''); setShowCfg(false); await loadFeishuCfg(); setMsg(`飞书应用已保存。回调地址：${r.redirectUri}（请确认已在飞书后台「重定向 URL」填入）`); }
    catch (e: any) { setMsg('保存失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const saveGetnote = async () => {
    setBusy(true); setMsg('');
    try { await api.recordingSaveGetnote({ apiKey: getnoteApiKey.trim(), clientId: getnoteClientId.trim() }); setGetnoteApiKey(''); setGetnoteClientId(''); await loadCreds(); setMsg('得到大脑凭据已保存（加密）。可点「拉取得到大脑」。'); }
    catch (e: any) { setMsg('保存失败：' + (e?.message || e)); }
    finally { setBusy(false); }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.recordingUpload(f, accountId);
      setMsg(`已上传「${f.name}」：新增 ${r.saved} 条，可在下方点「抽取成图」。`);
      await load();
    } catch (err: any) { setMsg('上传失败：' + (err?.message || err)); }
    finally { setBusy(false); e.target.value = ''; }
  };

  const extract = async (t: Transcript) => {
    setExtractingId(t.id); setReceipt(null); setMsg('');
    try {
      const rc = await api.recordingExtract(t.id, newIdempotencyKey());
      setReceipt(rc);
      onExtracted();
      await load();
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
    <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, border: '1px solid var(--line)', color: 'var(--muted)' }}>{STATUS_LABEL[status] || status}</span>
  );

  const footer = <span style={{ fontSize: 12, color: 'var(--muted)' }}>转写原文加密存储、严格按工作区隔离，可随时降解 / 删除（PIPL 合规）。</span>;
  const body = (
    <>
      {/* 源选择 */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {SOURCES.map((s) => (
          <button key={s.key} className={`btn ${source === s.key ? 'primary' : 'ghost'} sm`} onClick={() => { setSource(s.key); setMsg(''); }}>
            {s.label}{creds[s.key] === 'active' && (s.key === 'feishu' || s.key === 'getnote') ? ' ✓' : ''}
          </button>
        ))}
      </div>

      {/* 操作区（按源） */}
      <div style={{ marginBottom: 10 }}>
        {source === 'feishu' && (<>
          {!feishuCfg?.configured ? (
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>工作区还没配置飞书应用。{isAdmin ? '点下方「配置飞书应用」填 App ID/Secret。' : '请工作区管理员先配置飞书应用。'}</div>
          ) : creds.feishu === 'active' ? (
            <div>
              <button className="btn primary sm" onClick={feishuSync} disabled={busy}>{busy ? '⏳ 拉取中…' : '🔄 一键拉取拜访妙记'}</button>
              <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setShowFeishuUrl(!showFeishuUrl)}>按链接拉单篇</button>
              <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={connectFeishu}>🔗 重新授权</button>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>扫描你飞书妙记里标题以「【拜访】」开头的新记录，自动拉取（已拉过的跳过）。授权过期请点「重新授权」。</div>
              {showFeishuUrl && (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                  <input placeholder="粘贴飞书妙记链接…" value={feishuUrl} onChange={(e) => setFeishuUrl(e.target.value)} style={{ ...inputStyle, marginBottom: 0, flex: 1, minWidth: 180 }} />
                  <button className="btn primary sm" onClick={pullFeishuOne} disabled={busy || !feishuUrl.trim()}>拉这篇</button>
                </div>
              )}
            </div>
          ) : (
            <button className="btn primary sm" onClick={connectFeishu}>🔗 连接飞书（授权我的妙记）</button>
          )}
          {isAdmin && <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => setShowCfg(!showCfg)}>⚙️ 配置飞书应用</button>}
          {showCfg && isAdmin && (
            <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--line)', borderRadius: 6 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>飞书开放平台「企业自建应用」凭证（App Secret 加密存、不回显）。回调地址需在飞书后台「重定向 URL」填入：</div>
              <div style={{ fontSize: 12, color: 'var(--ink)', marginBottom: 8, wordBreak: 'break-all' }}><code>{feishuCfg?.redirectUri}</code></div>
              <input placeholder="App ID（cli_...）" value={cfgAppId} onChange={(e) => setCfgAppId(e.target.value)} style={inputStyle} />
              <input placeholder={feishuCfg?.hasSecret ? 'App Secret（留空=不修改）' : 'App Secret'} value={cfgSecret} onChange={(e) => setCfgSecret(e.target.value)} type="password" style={inputStyle} />
              <button className="btn primary sm" onClick={saveFeishuCfg} disabled={busy || !cfgAppId.trim()}>保存</button>
            </div>
          )}
        </>)}

        {source === 'upload' && (
          <label className="btn primary sm" style={{ cursor: 'pointer', display: 'inline-block' }}>
            📄 选择文件（md / txt / docx / pdf）
            <input type="file" accept=".md,.txt,.docx,.pdf" onChange={onFile} style={{ display: 'none' }} />
          </label>
        )}

        {source === 'getnote' && (
          creds.getnote === 'active'
            ? (<div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button className="btn primary sm" onClick={() => pull('getnote')} disabled={busy}>{busy ? '⏳ 拉取中…' : '⬇️ 拉取得到大脑'}</button>
                <button className="btn ghost sm" onClick={async () => { await api.recordingDeleteCredential('getnote'); await loadCreds(); setMsg('已断开得到大脑，可重新配置。'); }}>重新配置</button>
              </div>)
            : (<div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>得到大脑开放平台（biji.com/openapi）的 API Key + Client ID，加密存储。</div>
                <input placeholder="API Key（gk_live_...）" value={getnoteApiKey} onChange={(e) => setGetnoteApiKey(e.target.value)} type="password" style={inputStyle} />
                <input placeholder="Client ID（cli_...）" value={getnoteClientId} onChange={(e) => setGetnoteClientId(e.target.value)} style={inputStyle} />
                <button className="btn primary sm" onClick={saveGetnote} disabled={busy || !getnoteApiKey.trim() || !getnoteClientId.trim()}>保存</button>
              </div>)
        )}

        {source === 'mock' && (
          <button className="btn primary sm" onClick={() => pull('mock')} disabled={busy}>{busy ? '⏳ 拉取中…' : '⬇️ 拉取演示转写'}</button>
        )}
      </div>

      {msg && <div style={{ fontSize: 13, color: 'var(--ink)', margin: '6px 0' }}>{msg}</div>}
      {receipt && <div style={{ margin: '8px 0' }}><IntelReceipt receipt={receipt} /></div>}

      {/* 转写列表 */}
      {list.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--muted)', padding: '12px 0' }}>还没有录音转写。选来源后拉取 / 上传转写文字。</div>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {list.map((t) => (
            <li key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--line)', borderRadius: 6, background: 'var(--panel)' }}>
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
    </>
  );
  return embedded
    ? <div className="intel-embed">{body}<div className="modal-foot">{footer}</div></div>
    : <Modal title="🎧 录音接入" onClose={onClose} width={580} footer={footer}>{body}</Modal>;
}
