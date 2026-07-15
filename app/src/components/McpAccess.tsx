import { useEffect, useState } from 'react';
import { api, type AccessTokenInfo, type AccessTokenPreset } from '../api';
import { Modal } from './Modal';

// 推导 MCP 接入地址：生产同源走 origin/api/mcp；本地开发(5173)指向后端 3001。
function mcpUrl(): string {
  const o = window.location.origin;
  if (/:5173$/.test(o)) return o.replace(':5173', ':3001') + '/api/mcp';
  return o.replace(/\/$/, '') + '/api/mcp';
}

// 复制到剪贴板。navigator.clipboard 仅在安全上下文(HTTPS/localhost)可用；
// 团队多经 http://主机.local 或 Tailscale IP（非安全上下文）访问，故必须有 execCommand 回退。
function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function copy(text: string, onOk: () => void, onFail?: () => void) {
  copyToClipboard(text).then((ok) => (ok ? onOk() : onFail?.()));
}

export function McpAccess({ onClose }: { onClose: () => void }) {
  const url = mcpUrl();
  const [tokens, setTokens] = useState<AccessTokenInfo[]>([]);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<AccessTokenPreset>('workbuddy_sync');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null); // 刚生成的一次性明文
  const [copied, setCopied] = useState('');

  const load = () => api.accessTokenList().then((r) => setTokens(r.tokens)).catch(() => {});
  useEffect(() => { load(); }, []);

  const flash = (k: string) => { setCopied(k); setTimeout(() => setCopied(''), 1500); };
  // 复制并给反馈：成功闪「✓ 已复制」，失败闪「✗ 复制失败」（提示手动选择）。
  const doCopy = (text: string, k: string) => copy(text, () => flash(k), () => flash(k + '_fail'));

  const create = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api.accessTokenCreate(name.trim(), preset);
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
          <input readOnly value={url} style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
          <button className="btn ghost sm" onClick={() => doCopy(url, 'url')}>{copied === 'url' ? '✓ 已复制' : copied === 'url_fail' ? '✗ 失败' : '复制'}</button>
        </div>
      </label>

      {/* 刚生成的一次性明文 */}
      {fresh && (
        <div className="ok-msg" style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>✅ 令牌「{fresh.name}」已生成 —— 只显示这一次，请立即复制保存</div>
          {/* 完整配置：可直接粘进 AI 助手。点击可全选，复制不成时可手动复制 */}
          <textarea readOnly value={configJson(fresh.token)} onFocus={(e) => e.target.select()}
            style={{ width: '100%', minHeight: 120, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, lineHeight: 1.5, background: 'var(--panel-2)', color: 'var(--ink)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 10px', resize: 'vertical' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn primary sm" onClick={() => doCopy(configJson(fresh.token), 'cfg')}>{copied === 'cfg' ? '✓ 已复制配置' : copied === 'cfg_fail' ? '✗ 复制失败，请点上方框手动复制' : '📋 复制完整 MCP 配置'}</button>
            <button className="btn ghost sm" onClick={() => doCopy(fresh.token, 'tok')}>{copied === 'tok' ? '✓ 已复制令牌' : copied === 'tok_fail' ? '✗ 失败' : '只复制令牌'}</button>
          </div>
          <div className="hint-text" style={{ margin: '8px 0 0' }}>提示：若"复制"无效（部分浏览器在非 HTTPS 下限制），请点上方文本框 → 全选(Ctrl/⌘+A) → 复制(Ctrl/⌘+C)。</div>
        </div>
      )}

      {/* 生成新令牌 */}
      <div className="enrich-cfg" style={{ marginTop: 12 }}>
        <div className="fld sm" style={{ marginBottom: 10 }}>
          <span>最小权限预设</span>
          <div style={{ display: 'grid', gap: 6 }}>
            {([
              ['workbuddy_sync', 'Workbuddy 同步', '同步客户/商机/拜访，并提交人物、关系和证据候选'],
              ['readonly_analysis', '只读分析', '只能查看作战数据，不能写入或提交候选'],
              ['research_proposal', '调研提案', '只读并提交人物、关系和证据候选，不能改正式业务数据'],
            ] as const).map(([value, label, description]) => (
              <label key={value} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' }}>
                <input type="radio" name="mcp-token-preset" value={value} checked={preset === value}
                  onChange={() => setPreset(value)} style={{ marginTop: 3 }} />
                <span><strong>{label}</strong><br /><span style={{ color: 'var(--muted)', fontSize: 12 }}>{description}</span></span>
              </label>
            ))}
          </div>
        </div>
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
                <div className="m-email">{t.preset === 'workbuddy_sync' ? 'Workbuddy 同步' : t.preset === 'readonly_analysis' ? '只读分析' : t.preset === 'research_proposal' ? '调研提案' : '旧令牌（请重发）'} · 创建于 {new Date(t.createdAt).toLocaleDateString('zh-CN')} · {t.lastUsedAt ? `最近使用 ${new Date(t.lastUsedAt).toLocaleDateString('zh-CN')}` : '尚未使用'}</div>
              </div>
              <button className="btn ghost sm" onClick={() => revoke(t.id)}>吊销</button>
            </div>
          ))}
        </div>
      )}

      <div className="hint-text" style={{ marginTop: 14 }}>
        🔒 请按用途选择最小权限。吊销、成员移除或角色降级会在下一次请求立即生效；升级前生成的旧令牌默认降为只读，需要按用途重新签发。怀疑泄漏时请立即吊销。配置粘到 AI 助手后，可先说「看看我有哪些客户」验证连接。
      </div>
    </Modal>
  );
}
