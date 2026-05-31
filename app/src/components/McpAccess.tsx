import { useEffect, useState } from 'react';
import { api, type AccessTokenInfo } from '../api';
import { Modal } from './Modal';

// 推导 MCP 接入地址：生产同源走 origin/api/mcp；本地开发(5173)指向后端 3001。
function mcpUrl(): string {
  const o = window.location.origin;
  if (/:5173$/.test(o)) return o.replace(':5173', ':3001') + '/api/mcp';
  return o.replace(/\/$/, '') + '/api/mcp';
}

function copy(text: string, onOk: () => void) {
  navigator.clipboard?.writeText(text).then(onOk, () => {});
}

export function McpAccess({ onClose }: { onClose: () => void }) {
  const url = mcpUrl();
  const [tokens, setTokens] = useState<AccessTokenInfo[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null); // 刚生成的一次性明文
  const [copied, setCopied] = useState('');

  const load = () => api.accessTokenList().then((r) => setTokens(r.tokens)).catch(() => {});
  useEffect(() => { load(); }, []);

  const flash = (k: string) => { setCopied(k); setTimeout(() => setCopied(''), 1500); };

  const create = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.accessTokenCreate(name.trim());
      setFresh({ token: r.token, name: r.name || '（未命名）' });
      setName(''); load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    if (!confirm('吊销后用此令牌的 AI 助手将立即断开，确定？')) return;
    try { await api.accessTokenRevoke(id); load(); } catch (e: any) { setErr(e.message); }
  };

  const configJson = (token: string) => JSON.stringify({
    mcpServers: { jianghu: { url, headers: { Authorization: `Bearer ${token}` } } },
  }, null, 2);

  return (
    <Modal title="🔌 接入 AI 助手（Workbuddy / OpenClaw / Claude 等）" width={680} onClose={onClose}
      footer={<button className="btn primary" onClick={onClose}>完成</button>}>

      <p className="md-p" style={{ fontSize: 13, color: 'var(--muted)', marginTop: 0 }}>
        生成一个接入令牌，把下面的配置粘进你的 AI 助手「连接器 / MCP」设置，它就能查询你的作战数据、帮你联网调研并提议建图（提议须你在「🔮 荐关系」人审采纳）。
      </p>

      {/* 接入地址 */}
      <label className="fld sm"><span>接入地址</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input readOnly value={url} style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={() => copy(url, () => flash('url'))}>{copied === 'url' ? '✓ 已复制' : '复制'}</button>
        </div>
      </label>

      {/* 刚生成的一次性明文 */}
      {fresh && (
        <div className="ok-msg" style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>✅ 令牌「{fresh.name}」已生成 —— 只显示这一次，请立即复制保存</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ flex: 1, fontSize: 11, wordBreak: 'break-all', background: 'var(--panel-2)', padding: '6px 8px', borderRadius: 6 }}>{fresh.token}</code>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button className="btn ghost sm" onClick={() => copy(fresh.token, () => flash('tok'))}>{copied === 'tok' ? '✓ 已复制令牌' : '复制令牌'}</button>
            <button className="btn primary sm" onClick={() => copy(configJson(fresh.token), () => flash('cfg'))}>{copied === 'cfg' ? '✓ 已复制配置' : '📋 复制完整 MCP 配置'}</button>
          </div>
        </div>
      )}

      {/* 生成新令牌 */}
      <div className="enrich-cfg" style={{ marginTop: 12 }}>
        <div className="fld-row" style={{ alignItems: 'flex-end' }}>
          <label className="fld sm" style={{ flex: 1, marginBottom: 0 }}><span>新令牌备注名（可选，便于辨认）</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：我的 Workbuddy / 张三的 Claude"
              onKeyDown={(e) => e.key === 'Enter' && create()} />
          </label>
          <button className="btn primary sm" onClick={create} disabled={busy}>{busy ? '生成中…' : '+ 生成令牌'}</button>
        </div>
        {err && <div className="auth-err" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      {/* 已有令牌列表 */}
      <div className="sug-section-t" style={{ marginTop: 16 }}>我的接入令牌</div>
      {tokens.length === 0 ? (
        <div className="empty-hint" style={{ padding: '4px 2px' }}>还没有令牌。点上面「生成令牌」创建第一个。</div>
      ) : (
        <div className="member-list">
          {tokens.map((t) => (
            <div key={t.id} className="member-row">
              <div style={{ flex: 1 }}>
                <div className="m-name">{t.name || '（未命名）'} <span style={{ color: 'var(--faint)', fontWeight: 400 }}>· …{t.lastFour}</span></div>
                <div className="m-email">创建于 {new Date(t.createdAt).toLocaleDateString('zh-CN')} · {t.lastUsedAt ? `最近使用 ${new Date(t.lastUsedAt).toLocaleDateString('zh-CN')}` : '尚未使用'}</div>
              </div>
              <button className="btn ghost sm" onClick={() => revoke(t.id)}>吊销</button>
            </div>
          ))}
        </div>
      )}

      <div className="hint-text" style={{ marginTop: 14 }}>
        🔒 令牌等同你的账号读写权限，请勿外泄。怀疑泄漏时在此「吊销」并重新生成即可。配置粘到 AI 助手后，直接对它说「看看我有哪些客户」试试。
      </div>
    </Modal>
  );
}
