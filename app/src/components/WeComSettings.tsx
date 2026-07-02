import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';

// 企业微信集成设置：① 管理员配租户企微自建应用(corpId/agentId/secret，AES 存) ② 每人绑自己的企微 userid
// ③ 消息推送与一键采纳(回调 Token/AESKey，场景 B) ④ 测试推送(V1 文本卡 / V2 按钮卡)。
// 绑定后：行动/里程碑自动同步到本人企微日历；新提案推模板卡到企微、点按钮即采纳/驳回。
export function WeComSettings({ role, onClose }: { role: string; onClose: () => void }) {
  const canManage = role === 'owner' || role === 'admin';
  const [corpId, setCorpId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [secret, setSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [wecomUserid, setWecomUserid] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [hasCallback, setHasCallback] = useState(false);
  const [cbToken, setCbToken] = useState('');
  const [cbAesKey, setCbAesKey] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.wecomConfig().then((c) => {
      setCorpId(c.corpId); setAgentId(c.agentId); setHasSecret(c.hasSecret);
      setHasCallback(c.hasCallback); setCallbackUrl(c.callbackUrl);
    }).catch(() => {});
    api.wecomBind().then((b) => setWecomUserid(b.wecomUserid)).catch(() => {});
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setErr(''); setMsg(''); setBusy(true);
    try { await fn(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveConfig = () => run(async () => {
    await api.wecomSaveConfig({ corpId: corpId.trim(), agentId: agentId.trim(), ...(secret ? { secret } : {}) });
    if (secret) setHasSecret(true);
    setSecret('');
    setMsg('企微应用配置已保存');
  });
  const saveCallback = () => run(async () => {
    await api.wecomSaveConfig({ ...(cbToken.trim() ? { callbackToken: cbToken.trim() } : {}), ...(cbAesKey.trim() ? { callbackAesKey: cbAesKey.trim() } : {}) });
    if (cbToken.trim() && cbAesKey.trim()) setHasCallback(true);
    setCbToken(''); setCbAesKey('');
    setMsg('回调配置已保存——现在可以去企微后台「接收消息」里保存 URL 了');
  });
  const saveBind = () => run(async () => {
    await api.wecomSaveBind(wecomUserid.trim());
    setMsg(wecomUserid.trim() ? '企微 userid 绑定已保存' : '已解除绑定');
  });
  const connectWecom = () => run(async () => {
    const { url } = await api.wecomOauthStart();
    window.open(url, '_blank');
    setMsg('已打开企微授权页，扫码/确认后回此处会自动绑定（可重新打开本设置查看）');
  });
  const testPush = (kind: 'textcard' | 'card') => run(async () => {
    await api.wecomTestPush(kind);
    setMsg(kind === 'textcard' ? '文本卡已发出——去手机企微看（V1 ✓）' : '按钮卡已发出——在企微点按钮，卡片会自动刷新（V2）');
  });
  const copyUrl = () => { navigator.clipboard?.writeText(callbackUrl).then(() => setMsg('回调 URL 已复制')).catch(() => {}); };

  return (
    <Modal title="企业微信集成（日历 + 消息推送）" width={560} onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>关闭</button>}>
      <div className="hint-text" style={{ marginTop: 0 }}>
        行动/里程碑同步到<strong>你的企微日历</strong>；新提案推<strong>模板卡到企微、点按钮一键采纳</strong>。用本工作区企微自己的自建应用凭据，Secret / AESKey 经 AES 加密存服务端，绝不外发。
      </div>

      <div style={{ fontWeight: 600, margin: '14px 0 6px' }}>① 企微自建应用（管理员配，全工作区共用）</div>
      {!canManage && <div className="auth-err">仅工作区管理员可配置企微应用。</div>}
      <label className="fld"><span>企业 ID（corpId）</span>
        <input disabled={!canManage} value={corpId} onChange={(e) => setCorpId(e.target.value)} placeholder="ww 开头" /></label>
      <label className="fld"><span>应用 AgentId</span>
        <input disabled={!canManage} value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="如 1000002" /></label>
      <label className="fld"><span>应用 Secret {hasSecret && <span style={{ color: '#16a34a' }}>（已配置，留空则不变）</span>}</span>
        <input disabled={!canManage} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={hasSecret ? '••••••••（已保存）' : '自建应用 Secret'} /></label>
      {canManage && <button className="btn primary sm" onClick={saveConfig} disabled={busy} style={{ marginTop: 4 }}>保存应用配置</button>}

      <div style={{ fontWeight: 600, margin: '18px 0 6px' }}>② 我的企微 userid（绑定后日历/推送才到我）</div>
      <label className="fld"><span>我的企微 userid</span>
        <input value={wecomUserid} onChange={(e) => setWecomUserid(e.target.value)} placeholder="企微通讯录里的成员账号，如 zhangsan" /></label>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button className="btn primary sm" onClick={saveBind} disabled={busy}>保存绑定</button>
        <button className="btn ghost sm" onClick={connectWecom} disabled={busy} title="扫码自动获取企微 userid（需公网部署 + 应用可信域名）">📱 扫码自动绑定</button>
      </div>

      <div style={{ fontWeight: 600, margin: '18px 0 6px' }}>③ 消息推送与一键采纳（管理员 · 场景 B）{hasCallback && <span style={{ color: '#16a34a', fontWeight: 400 }}>（回调已配置）</span>}</div>
      <div className="hint-text" style={{ marginTop: 0 }}>
        在企微后台该应用「接收消息 → 设置 API 接收」里：URL 填下面这个；Token / EncodingAESKey 点「随机获取」后<strong>先填回这里保存，再回企微后台点保存</strong>（顺序反了会验证失败）。
      </div>
      <label className="fld"><span>回调 URL（复制到企微后台）</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input readOnly value={callbackUrl} style={{ flex: 1 }} />
          <button className="btn ghost sm" onClick={copyUrl}>复制</button>
        </div></label>
      <label className="fld"><span>Token {hasCallback && <span style={{ color: '#16a34a' }}>（已配置，留空则不变）</span>}</span>
        <input disabled={!canManage} value={cbToken} onChange={(e) => setCbToken(e.target.value)} placeholder="企微「接收消息」页随机获取的 Token" /></label>
      <label className="fld"><span>EncodingAESKey（43 位）</span>
        <input disabled={!canManage} type="password" value={cbAesKey} onChange={(e) => setCbAesKey(e.target.value)} placeholder={hasCallback ? '••••••••（已保存）' : '企微「接收消息」页随机获取'} /></label>
      {canManage && <button className="btn primary sm" onClick={saveCallback} disabled={busy || (!cbToken.trim() && !cbAesKey.trim())} style={{ marginTop: 4 }}>保存回调配置</button>}

      <div style={{ fontWeight: 600, margin: '18px 0 6px' }}>④ 测试推送（先完成 ①② ；按钮卡还需 ③）</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn ghost sm" onClick={() => testPush('textcard')} disabled={busy}>发文本卡（V1 推送通）</button>
        <button className="btn ghost sm" onClick={() => testPush('card')} disabled={busy}>发按钮卡（V2 回调通）</button>
      </div>

      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="auth-err">{err}</div>}
    </Modal>
  );
}
