import { useEffect, useState } from 'react';
import { api, type CompanyCandidate, type CompanyEquityData } from '../api';
import { Modal } from './Modal';

const SOURCE_LABEL: Record<string, { t: string; c: string }> = {
  qcc: { t: '企查查 · 权威工商数据', c: '#16a34a' },
  web: { t: '搜索引擎(AI 联网) · 待核实', c: '#0ea5e9' },
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
  // 全称锚定：候选企业列表（多候选时让用户点选，符合企查查"不可自动锁定"规则）
  const [candidates, setCandidates] = useState<CompanyCandidate[] | null>(null);
  const [resolvedName, setResolvedName] = useState('');
  // 股权/对外投资（只读·仅供参考，不写库）；按需加载，避免每次查人都拉。
  const [equity, setEquity] = useState<CompanyEquityData | null>(null);
  const [equityErr, setEquityErr] = useState('');
  const [equityLoading, setEquityLoading] = useState(false);

  // 企查查 MCP 配置（粘贴 JSON）
  const [cfg, setCfg] = useState({ configured: false, mode: 'mcp', endpoint: '', hasToken: false });
  const [mcpJson, setMcpJson] = useState('');
  const [showConfig, setShowConfig] = useState(false);
  const [cfgMsg, setCfgMsg] = useState('');
  const [cfgBusy, setCfgBusy] = useState(false);
  const [dataSource, setDataSource] = useState<'auto' | 'web'>('auto'); // auto=企查查/AI；web=搜索引擎(AI 联网)

  useEffect(() => { api.qccConfig().then(setCfg).catch(() => {}); }, []);

  // 按完整登记名查关键人并填充预览
  const fetchPersons = async (fullName: string, mode: 'auto' | 'web' = 'auto') => {
    setErr(''); setLoading(true); setRows([]); setCandidates(null);
    setEquity(null); setEquityErr(''); // 切换主体时清空股权/投资旧数据
    try {
      const r = await api.enrichCompany(fullName, mode);
      setRows(r.persons.map((p) => ({ ...p, selected: true })));
      setSource(r.source); setNote(r.note); setResolvedName(fullName);
    } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
  };

  // 按需拉取股权/对外投资（只展示，不导入）。需已配企查查 MCP + 已锚定全称。
  const loadEquity = async () => {
    if (!resolvedName) return;
    setEquityErr(''); setEquityLoading(true);
    try { setEquity(await api.qccCompanyData(resolvedName)); }
    catch (e: any) { setEquityErr(e.message); } finally { setEquityLoading(false); }
  };

  const search = async () => {
    if (!name.trim()) return;
    setErr(''); setRows([]); setCandidates(null); setNote('');
    // 搜索引擎源：AI 联网直接查，无需企查查全称锚定
    if (dataSource === 'web') { await fetchPersons(name.trim(), 'web'); return; }
    // 未配企查查 MCP：保持原逻辑（直接 AI/mock 兜底，无需锚定）
    if (!cfg.configured) { await fetchPersons(name.trim()); return; }
    // 已配 MCP：先锚定全称（企查查要求 searchKey 为完整登记名；简称会命中多候选）
    setLoading(true);
    try {
      const r = await api.qccResolve(name.trim());
      if (!r.candidates.length) { setErr('未检索到匹配企业，请检查名称'); return; }
      if (r.exact || r.candidates.length === 1) { await fetchPersons(r.candidates[0].name); return; }
      setCandidates(r.candidates); // 多候选 → 让用户人审点选
    } catch (e: any) {
      // resolve 失败时，退回直接查（可能是工具差异），不阻断用户
      setErr(e.message + '（已尝试直接查询）'); await fetchPersons(name.trim());
    } finally { setLoading(false); }
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
    <Modal title="🔍 搜索情报" width={600} onClose={onClose}
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

      {/* 数据源选择：企查查/AI（auto）或 搜索引擎（AI 联网） */}
      <div className="fld" style={{ marginBottom: 10 }}>
        <span>数据源</span>
        <div className="intel-scope">
          <label className="chk-line"><input type="radio" checked={dataSource === 'auto'} onChange={() => setDataSource('auto')} />{cfg.configured ? '企查查 MCP（工商数据）' : 'AI 联想（未配企查查）'}</label>
          <label className="chk-line"><input type="radio" checked={dataSource === 'web'} onChange={() => setDataSource('web')} />🔍 搜索引擎（AI 联网·待核实）</label>
        </div>
        {dataSource === 'web' && <div className="hint-text" style={{ margin: '4px 0 0' }}>从公开网络搜索，需所配 AI 模型支持联网；结果均为待核实，勾选后导入。</div>}
      </div>

      {/* 查询 */}
      <div className="enrich-search">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()}
          placeholder={cfg.configured ? '输入公司名或简称（如「华为」），将先锚定全称' : '输入公司完整名称'} />
        <button className="btn primary" onClick={search} disabled={loading}>{loading ? '查询中…' : '🔍 查询关键人'}</button>
      </div>

      {/* 多候选 → 人审点选正确主体（企查查规则：不可自动锁定） */}
      {candidates && candidates.length > 0 && (
        <div className="enrich-candidates">
          <div className="enrich-toolbar" style={{ margin: '12px 0 6px' }}>
            <span>「{name}」命中 {candidates.length} 个主体，请选择目标企业：</span>
            <button className="link-btn" onClick={() => setCandidates(null)}>取消</button>
          </div>
          <div className="enrich-list">
            {candidates.map((c, i) => (
              <button key={i} className="cand-row" onClick={() => fetchPersons(c.name)} disabled={loading}>
                <span className="er-name">{c.name}</span>
                <span className="cand-meta">
                  {c.legalPerson && <span>法人：{c.legalPerson}</span>}
                  {c.status && <span className="cand-status">{c.status}</span>}
                  {c.establishDate && <span>{c.establishDate}</span>}
                </span>
                <span className="cand-code">{c.creditCode}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {note && <div className="enrich-note" style={{ borderColor: SOURCE_LABEL[source]?.c }}>
        <b style={{ color: SOURCE_LABEL[source]?.c }}>{SOURCE_LABEL[source]?.t || source}</b>
        {resolvedName && resolvedName !== name && <> · 主体：<b>{resolvedName}</b></>} · {note}
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

      {/* 股权 / 对外投资（仅企查查 MCP；只展示·不导入·不写库，纯参考信息） */}
      {cfg.configured && resolvedName && (
        <div className="enrich-equity">
          <div className="enrich-toolbar" style={{ marginTop: 16 }}>
            <span>股权 / 对外投资 <span className="hint-text" style={{ margin: 0 }}>· 仅供参考，不导入建图</span></span>
            {!equity
              ? <button className="link-btn" onClick={loadEquity} disabled={equityLoading}>{equityLoading ? '加载中…' : '查看股权/投资 ▸'}</button>
              : <button className="link-btn" onClick={loadEquity} disabled={equityLoading}>{equityLoading ? '刷新中…' : '刷新'}</button>}
          </div>
          {equityErr && <div className="auth-err">{equityErr}</div>}
          {equity && (
            <div className="equity-cols">
              <div className="equity-col">
                <div className="equity-h">股东（{equity.shareholders.length}）</div>
                {equity.shareholders.length === 0
                  ? <div className="hint-text" style={{ margin: 0 }}>无股东数据</div>
                  : <div className="enrich-list">
                      {equity.shareholders.map((s, i) => (
                        <div key={i} className="equity-row">
                          <span className="er-name">{s.name}</span>
                          <span className="equity-meta">
                            {s.ratio && <span className="equity-ratio">{s.ratio}</span>}
                            {s.amount && <span>{s.amount}</span>}
                          </span>
                        </div>
                      ))}
                    </div>}
              </div>
              <div className="equity-col">
                <div className="equity-h">对外投资（{equity.investments.length}）</div>
                {equity.investments.length === 0
                  ? <div className="hint-text" style={{ margin: 0 }}>无对外投资数据</div>
                  : <div className="enrich-list">
                      {equity.investments.map((v, i) => (
                        <div key={i} className="equity-row">
                          <span className="er-name">{v.name}</span>
                          <span className="equity-meta">
                            {v.ratio && <span className="equity-ratio">{v.ratio}</span>}
                            {v.status && <span className="cand-status">{v.status}</span>}
                            {v.establishDate && <span>{v.establishDate}</span>}
                          </span>
                        </div>
                      ))}
                    </div>}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
