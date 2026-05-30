import { useState } from 'react';
import { api, type AuthResult } from '../api';
import { Footer } from './Footer';

export function Auth({ onAuthed }: { onAuthed: (r: AuthResult) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [method, setMethod] = useState<'phone' | 'email'>('phone');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setErr(''); setLoading(true);
    try {
      const cred = method === 'phone' ? { phone, password } : { email, password };
      const res = mode === 'register'
        ? await api.register({ ...cred, name, tenantName })
        : await api.login(cred);
      api.setToken(res.token);
      onAuthed(res);
    } catch (e: any) {
      setErr(e.message || '出错了');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="logo lg">江</div>
          <div>
            <div className="hub-title">江湖 · Game of JiangHu</div>
            <div className="hub-sub">销售干系人作战地图 · 云端协作版</div>
          </div>
        </div>

        <div className="auth-tabs">
          <button className={mode === 'register' ? 'on' : ''} onClick={() => setMode('register')}>注册新工作区</button>
          <button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>登录</button>
        </div>

        <div className="method-toggle">
          <button className={method === 'phone' ? 'on' : ''} onClick={() => setMethod('phone')}>📱 手机号</button>
          <button className={method === 'email' ? 'on' : ''} onClick={() => setMethod('email')}>✉️ 邮箱</button>
        </div>

        {mode === 'register' && (
          <label className="fld"><span>工作区名称（团队/公司）</span>
            <input value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="如：华东销售一部" /></label>
        )}
        {mode === 'register' && (
          <label className="fld"><span>你的姓名</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：张三" /></label>
        )}
        {method === 'phone' ? (
          <label className="fld"><span>手机号</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="11 位中国大陆手机号" inputMode="numeric" /></label>
        ) : (
          <label className="fld"><span>邮箱</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
        )}
        <label className="fld"><span>密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="至少 6 位" /></label>

        {err && <div className="auth-err">{err}</div>}

        <button className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={loading} onClick={submit}>
          {loading ? '请稍候…' : mode === 'register' ? '创建工作区并进入' : '登录'}
        </button>
        <div className="auth-foot">
          {mode === 'register' ? '已有账号？' : '还没有工作区？'}
          <a onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setErr(''); }}>
            {mode === 'register' ? '去登录' : '去注册'}
          </a>
        </div>
        <div className="auth-tip">手机号即可注册使用，无需企业资质。微信登录需企业认证，暂未开放。</div>
      </div>
      <Footer />
    </div>
  );
}
