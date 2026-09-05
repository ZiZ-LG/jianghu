import { useState } from 'react';
import { api, type AuthResult, type WorkspaceChoice } from '../api';
import { authErrorMessage, validateAuth } from '../lib/authValidation';
import { Footer } from './Footer';

export function Auth({ onAuthed }: { onAuthed: (r: AuthResult) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [method, setMethod] = useState<'phone' | 'email'>('phone');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  // 登录命中同号多工作区时，后端返回候选；非空则展示工作区选择，用户点选后带 tenantId 二次登录
  const [workspaces, setWorkspaces] = useState<WorkspaceChoice['workspaces'] | null>(null);

  const enter = (res: AuthResult) => { api.setToken(res.token); onAuthed(res); };

  const submit = async () => {
    const validationError = validateAuth({ mode, method, name, phone, email, password });
    if (validationError) { setErr(validationError); return; }
    setErr(''); setLoading(true);
    try {
      const cred = method === 'phone' ? { phone: phone.trim(), password } : { email: email.trim(), password };
      if (mode === 'register') {
        enter(await api.register({ ...cred, name: name.trim() }));
      } else {
        const res = await api.login(cred);
        if ('needWorkspace' in res) { setWorkspaces(res.workspaces); return; } // 同号多工作区 → 转选择
        enter(res);
      }
    } catch (e: unknown) {
      setErr(authErrorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const chooseWorkspace = async (tenantId: string) => {
    setErr(''); setLoading(true);
    try {
      const cred = method === 'phone' ? { phone: phone.trim(), password } : { email: email.trim(), password };
      const res = await api.login({ ...cred, tenantId });
      if ('needWorkspace' in res) { setErr('登录失败，请重试'); return; } // 已指定工作区，理论不会再要求选择
      enter(res);
    } catch (e: unknown) {
      setErr(authErrorMessage(e));
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
            <div className="hub-sub">看清客户决策，接续下一步行动</div>
          </div>
        </div>

        {workspaces ? (
          <div className="ws-choose">
            <label className="fld"><span>该账号在多个工作区都有，请选择进入：</span></label>
            {workspaces.map((w) => (
              <button key={w.tenantId} className="btn ghost" style={{ width: '100%', marginTop: 6, justifyContent: 'flex-start' }}
                disabled={loading} onClick={() => chooseWorkspace(w.tenantId)}>
                🏢 {w.tenantName}
              </button>
            ))}
            {err && <div className="auth-err">{err}</div>}
            <div className="auth-foot">
              <button type="button" className="auth-link" onClick={() => { setWorkspaces(null); setErr(''); }}>← 返回</button>
            </div>
          </div>
        ) : (
          <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="auth-tabs">
              <button type="button" className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setErr(''); }}>创建私人账户</button>
              <button type="button" className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr(''); }}>登录</button>
            </div>

            {mode === 'register' && (
              <div className="auth-join">
                从一个客户、一条记录开始。你的客户与商机保存在自己的私人工作区。
              </div>
            )}

            <div className="method-toggle">
              <button type="button" className={method === 'phone' ? 'on' : ''} onClick={() => { setMethod('phone'); setErr(''); }}>📱 手机号</button>
              <button type="button" className={method === 'email' ? 'on' : ''} onClick={() => { setMethod('email'); setErr(''); }}>✉️ 邮箱</button>
            </div>

            {mode === 'register' && (
              <label className="fld"><span>你的姓名</span>
                <input name="name" autoComplete="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：曹经理" /></label>
            )}
            {method === 'phone' ? (
              <label className="fld"><span>手机号</span>
                <input name="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="11 位中国大陆手机号" inputMode="numeric" /></label>
            ) : (
              <label className="fld"><span>邮箱</span>
                <input name="email" autoComplete="email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
            )}
            <label className="fld"><span>密码</span>
              <input name="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={6}
                type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" /></label>

            {err && <div id="auth-error" className="auth-err" role="alert" aria-live="polite">{err}</div>}

            <button type="submit" className="btn primary" style={{ width: '100%', marginTop: 6 }} disabled={loading}>
              {loading ? '请稍候…' : mode === 'register' ? '创建账户并开始' : '登录'}
            </button>
            <div className="auth-foot">
              {mode === 'register' ? '已有账号？' : '还没有账号？'}
              <button type="button" className="auth-link" onClick={() => { setMode(mode === 'register' ? 'login' : 'register'); setErr(''); }}>
                {mode === 'register' ? '去登录' : '去注册'}
              </button>
            </div>
            <div className="auth-tip">使用手机号或邮箱即可开始。已有工作区的账号可直接登录。</div>
          </form>
        )}
      </div>
      <Footer />
    </div>
  );
}
