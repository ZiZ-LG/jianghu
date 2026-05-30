import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';

const SOURCE_LABEL: Record<string, { t: string; c: string }> = {
  qcc: { t: '企查查 · 权威工商数据', c: '#16a34a' },
  ai: { t: 'AI 联想 · 待核实', c: '#f59e0b' },
  mock: { t: '角色清单 · 待补齐', c: '#94a3b8' },
};

interface Row { name: string; title: string; selected: boolean }

export function EnrichPanel({
  accountName, role, onImport, onClose,
}: {
  accountName: string;
  role: string;
  onImport: (persons: { name: string; title: string; source: string }[]) => void;
  onClose: () => void;
}) {
  const canManage = role === 'owner' || role === 'admin';
  const [name, setName] = useState(accountName);
  const [rows, setRows] = useState<Row[]>([]);
  const [source, setSource] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // 企查查 MCP 配置（粘贴 JSON）
  const [cfg, setCfg] = useState({ configured: false, mode: 'mcp', endpoint: '', hasToken: false });
  const [mcpJson, setMcpJson] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [cfgMsg, setCfgMsg] = useState('');
  const [cfgBusy, setCfgBusy] = useState(false);

  useEffect(() => { api.qccConfig().then(setCfg).catch(() => {}); }, []);

  const search = async () => {
    if (!name.trim()) return;
    setErr(''); setLoading(true); setRows([]);
    try {
      const r = await api.enrichCompany(name.trim());
      setRows(r.persons.map((p) => ({ ...p, selected: true })));
      setSource(r.source); setNote(r.note);
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  };
  const saveCfg = async (test: boolean) => {
    setCfgMsg(''); setErr(''); setCfgBusy(true);
    try {
      if (mcpJson.trim()) { await api.qccSaveConfig({ mcpJson: mcpJson.trim() }); setMcpJson(''); }
      else if (!cfg.configured) { setCfgMsg('请先粘贴企查查 MCP 配置 JSON'); setCfgBusy(false); return; }
      if (test) { const r = await api.qccTest(); setCfgMsg('✓ ' + (r.message || '连通正常')); }
      else setCfgMsg('✓ 已保存');
      api.qccConfig().then(setCfg);
    } catch (e: any) { setCfgMsg('✗ ' + e.message); } finally { setCfgBusy(false); }
  };
  const clearCfg = async () => {
    setCfgMsg(''); setCfgBusy(true);
    try { await api.qccClearConfig(); setCfg({ configured: false, mode: 'mcp', endpoint: '', hasToken: false }); setCfgMsg('已清除'); }
    catch (e: any) { setCfgMsg('✗ ' + e.message); } finally { setCfgBusy(false); }
  };
  const toggle = (i: number) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, selected: !r.selected } : r)));
  const selected = rows.filter((r) => r.selected);
  const doImport = () => { onImport(selected.map((r) => ({ name: r.name, title: r.title, source }))); onClose(); };

  return (
    <Modal title="🏢 企查查 · 自动建图" width={600} onClose={onClose}
      footer={<>
        <span className="hint-text" style={{ margin: 0, marginRight: 'auto' }}>导入为节点（带来源·待验证），后续指派角色 + 核实</span>
        <button className="btn ghost" onClick={onClose}>关闭</button>
        <button className="btn primary" onClick={doImport} disabled={!selected.length}>导入选中（{selected.length}）</button>
      </>}>

      {/* 数据源状态 */}
      <div className="enrich-status">
        {cfg.configured
          ? <span>数据源：<b style={{ color: '#16a34a' }}>企查查 MCP（已连接）</b></span>
          : <span>数据源：<b style={{ color: '#f59e0b' }}>AI 联想（未配企查查 MCP，质量有限）</b></span>}
        <button className="link-btn" onClick={() => setShowConfig((s) => !s)}>{showConfig ? '收起配置' : '配置企查查 MCP ▸'}</button>
      </div>

      {showConfig && (
        <div className="enrich-cfg">
          {!canManage && <div className="hint-text" style={{ marginTop: 0 }}>仅管理员可配置。</div>}
          <div className="hint-text" style={{ marginTop: 0 }}>
            打开 <b>agent.qcc.com/guide</b>，把页面给出的 MCP 配置 JSON 整段复制，粘贴到下面即可（含 Bearer Token，将加密存储）。
          </div>
          {cfg.configured && (
            <div className="ok-msg" style={{ marginTop: 0, marginBottom: 8 }}>
              ✓ 已连接：<code style={{ fontSize: 11 }}>{cfg.endpoint}</code>（重新粘贴可覆盖）
            </div>
          )}
          <label className="fld sm">
            <span>企查查 MCP 配置 JSON</span>
            <textarea disabled={!canManage} value={mcpJson} onChange={(e) => setMcpJson(e.target.value)} rows={6}
              style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11.5, minHeight: 120 }}
              placeholder={'{\n  "mcpServers": {\n    "qcc-company": {\n      "url": "https://agent.qcc.com/mcp/company/stream",\n      "headers": { "Authorization": "Bearer xxxxxxxx" }\n    }\n  }\n}'} />
          </label>
          {canManage && <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn ghost sm" onClick={() => saveCfg(true)} disabled={cfgBusy}>{cfgBusy ? '处理中…' : '保存并测试连通'}</button>
            <button className="btn primary sm" onClick={() => saveCfg(false)} disabled={cfgBusy}>保存</button>
            {cfg.configured && <button className="btn ghost sm" onClick={clearCfg} disabled={cfgBusy}>清除</button>}
            {cfgMsg && <span className="hint-text" style={{ margin: 0, alignSelf: 'center' }}>{cfgMsg}</span>}
          </div>}
        </div>
      )}

      {/* 查询 */}
      <div className="enrich-search">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="输入公司完整名称" />
        <button className="btn primary" onClick={search} disabled={loading}>{loading ? '查询中…' : '🔍 查询关键人'}</button>
      </div>

      {note && <div className="enrich-note" style={{ borderColor: SOURCE_LABEL[source]?.c }}>
        <b style={{ color: SOURCE_LABEL[source]?.c }}>{SOURCE_LABEL[source]?.t || source}</b> · {note}
      </div>}
      {err && <div className="auth-err">{err}</div>}

      {rows.length > 0 && (
        <>
          <div className="enrich-toolbar">
            <span>发现 {rows.length} 人</span>
            <button className="link-btn" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, selected: true })))}>全选</button>
            <button className="link-btn" onClick={() => setRows((rs) => rs.map((r) => ({ ...r, selected: false })))}>全不选</button>
          </div>
          <div className="enrich-list">
            {rows.map((r, i) => (
              <label key={i} className={`enrich-row${r.selected ? ' on' : ''}`}>
                <input type="checkbox" checked={r.selected} onChange={() => toggle(i)} />
                <span className="er-name">{r.name}</span>
                <span className="er-title">{r.title}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
