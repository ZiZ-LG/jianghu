import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';

// 企业微信日历同步设置：① 管理员配租户企微自建应用(corpId/agentId/secret，AES 存) ② 每人绑自己的企微 userid。
// 绑定后，行动/里程碑落库会自动同步到本人企微日历(江湖→企微单向；P2-b 加双向回写)。
export function WeComSettings({ role, onClose }: { role: string; onClose: () => void }) {
  const canManage = role === 'owner' || role === 'admin';
  const [corpId, setCorpId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [secret, setSecret] = useState('');
  const [hasSecret, setHasSecret] = useState(false);
  const [wecomUserid, setWecomUserid] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.wecomConfig().then((c) => { setCorpId(c.corpId); setAgentId(c.agentId); setHasSecret(c.hasSecret); }).catch(() => {});
    api.wecomBind().then((b) => setWecomUserid(b.wecomUserid)).catch(() => {});
  }, []);

  const saveConfig = async () => {
    setErr(''); setMsg(''); setBusy(true);
    try {
      await api.wecomSaveConfig({ corpId: corpId.trim(), agentId: agentId.trim(), ...(secret ? { secret } : {}) });
      if (secret) setHasSecret(true);
      setSecret('');
      setMsg('企微应用配置已保存');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const saveBind = async () => {
    setErr(''); setMsg(''); setBusy(true);
    try { await api.wecomSaveBind(wecomUserid.trim()); setMsg(wecomUserid.trim() ? '企微 userid 绑定已保存' : '已解除绑定'); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="企业微信日历同步" width={540} onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>关闭</button>}>
      <div className="hint-text" style={{ marginTop: 0 }}>
        把「行动 / 里程碑」自动同步到<strong>你的企业微信日历</strong>。用<strong>本工作区企微自己的自建应用凭据</strong>，平台不需公司资质。Secret 经 AES 加密存服务端，绝不外发。
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

      <div style={{ fontWeight: 600, margin: '18px 0 6px' }}>② 我的企微 userid（绑定后行动才进我的日历）</div>
      <label className="fld"><span>我的企微 userid</span>
        <input value={wecomUserid} onChange={(e) => setWecomUserid(e.target.value)} placeholder="企微通讯录里的成员账号，如 zhangsan" /></label>
      <button className="btn primary sm" onClick={saveBind} disabled={busy} style={{ marginTop: 4 }}>保存绑定</button>

      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="auth-err">{err}</div>}
    </Modal>
  );
}
