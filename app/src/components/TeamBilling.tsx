import { useEffect, useState } from 'react';
import { api } from '../api';
import { Modal } from './Modal';

interface Member { id: string; phone: string | null; email: string | null; name: string; role: string }
interface Billing { plan: string; seatLimit: number; memberCount: number }
interface Donate { url: string; qrUrl: string; note: string }

export function TeamBilling({ role, onClose }: { role: string; onClose: () => void }) {
  const canManage = role === 'owner' || role === 'admin';
  const [billing, setBilling] = useState<Billing | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [donate, setDonate] = useState<Donate | null>(null);
  const [err, setErr] = useState('');
  const [nm, setNm] = useState({ phone: '', email: '', name: '', password: '', role: 'member' });

  const load = async () => {
    try {
      setBilling(await api.billing());
      setMembers((await api.members()).members);
      setDonate(await api.donate());
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => { load(); }, []);

  const add = async () => {
    setErr('');
    try {
      await api.addMember({ name: nm.name, password: nm.password, role: nm.role, ...(nm.phone ? { phone: nm.phone } : {}), ...(nm.email ? { email: nm.email } : {}) });
      setNm({ phone: '', email: '', name: '', password: '', role: 'member' }); await load();
    } catch (e: any) { setErr(e.message); }
  };
  const remove = async (id: string) => { try { await api.removeMember(id); await load(); } catch (e: any) { setErr(e.message); } };

  const full = billing ? billing.memberCount >= billing.seatLimit : false;
  const canSubmit = nm.name && nm.password.length >= 6 && (nm.phone || nm.email);

  return (
    <Modal title="团队与支持" width={560} onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>关闭</button>}>
      {/* 捐赠支持 */}
      {donate && (
        <div className="donate-card">
          <div className="donate-emoji">☕</div>
          <div style={{ flex: 1 }}>
            <div className="donate-note">{donate.note}</div>
            {donate.url
              ? <a className="btn primary sm" href={donate.url} target="_blank" rel="noreferrer" style={{ marginTop: 8, display: 'inline-block' }}>去支持作者</a>
              : <div className="hint-text" style={{ margin: '6px 0 0' }}>（管理员可在后端 .env 配置 DONATE_URL / DONATE_QR_URL）</div>}
          </div>
          {donate.qrUrl && <img className="donate-qr" src={donate.qrUrl} alt="收款码" />}
        </div>
      )}

      {billing && (
        <div className="plan-card" style={{ marginTop: 12 }}>
          <div>
            <div className="plan-name">免费版 · 多人协作</div>
            <div className="plan-seats">成员 {billing.memberCount} / {billing.seatLimit} 席</div>
          </div>
          <div className="hint-text" style={{ margin: 0 }}>产品免费，自愿赞赏</div>
        </div>
      )}

      <div className="section-t" style={{ marginTop: 14 }}>成员（{members.length}）</div>
      <div className="member-list">
        {members.map((m) => (
          <div key={m.id} className="member-row">
            <div className="avatar sm">{m.name[0]}</div>
            <div style={{ flex: 1 }}>
              <div className="m-name">{m.name} <span className={`role-tag ${m.role}`}>{m.role}</span></div>
              <div className="m-email">{m.phone || m.email}</div>
            </div>
            {canManage && m.role !== 'owner' && <button className="row-del" onClick={() => remove(m.id)}>🗑</button>}
          </div>
        ))}
      </div>

      {canManage && (
        <>
          <div className="section-t">邀请成员{full && <span className="seat-full">（席位已满）</span>}</div>
          <label className="fld"><span>姓名</span><input value={nm.name} onChange={(e) => setNm({ ...nm, name: e.target.value })} /></label>
          <div className="fld-row">
            <label className="fld"><span>手机号（二选一）</span><input value={nm.phone} onChange={(e) => setNm({ ...nm, phone: e.target.value })} placeholder="11 位手机号" /></label>
            <label className="fld"><span>邮箱（二选一）</span><input value={nm.email} onChange={(e) => setNm({ ...nm, email: e.target.value })} placeholder="可选" /></label>
          </div>
          <div className="fld-row">
            <label className="fld"><span>初始密码</span><input value={nm.password} onChange={(e) => setNm({ ...nm, password: e.target.value })} placeholder="≥6 位" /></label>
            <label className="fld"><span>角色</span>
              <select value={nm.role} onChange={(e) => setNm({ ...nm, role: e.target.value })}>
                <option value="admin">管理员</option><option value="member">成员</option><option value="viewer">只读</option>
              </select></label>
          </div>
          <button className="btn primary sm" disabled={full || !canSubmit} onClick={add}>＋ 添加成员</button>
        </>
      )}
      {err && <div className="auth-err" style={{ marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}
