import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { SessionLease } from '../lib/sessionLifecycle';
import { Modal } from './Modal';

const PRESETS = [
  { id: 'mock', label: '🧪 内置演示（无需 Key）', provider: 'mock', baseUrl: '', model: '' },
  { id: 'deepseek', label: 'DeepSeek', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'qwen', label: '通义千问 Qwen', provider: 'openai-compatible', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'kimi', label: 'Kimi (Moonshot)', provider: 'openai-compatible', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'glm', label: '智谱 GLM', provider: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'openai', label: 'OpenAI', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'openrouter', label: 'OpenRouter', provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { id: 'ollama', label: 'Ollama 本地', provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5' },
  { id: 'custom', label: '自定义', provider: 'openai-compatible', baseUrl: '', model: '' },
];

export function AiSettings({ role, onClose, onSaved, sessionLease }: {
  role: string;
  onClose: () => void;
  onSaved?: () => void;
  sessionLease: SessionLease;
}) {
  const canManage = role === 'owner' || role === 'admin';
  const [provider, setProvider] = useState('mock');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const operationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    let alive = true;
    void sessionLease.run(api.aiConfig).then((result) => {
      if (!alive || !result.current) return;
      const c = result.value;
      setProvider(c.provider); setBaseUrl(c.baseUrl); setModel(c.model); setHasKey(c.hasKey);
    }).catch(() => {});
    return () => {
      alive = false;
      mountedRef.current = false;
      operationRef.current += 1;
    };
  }, [sessionLease]);

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id)!;
    setProvider(p.provider); setBaseUrl(p.baseUrl); setModel(p.model); setMsg(''); setErr('');
  };
  const commitSaved = () => {
    if (apiKey) setHasKey(true);
    setApiKey('');
  };
  const saveRequest = () => api.aiSaveConfig({ provider, baseUrl, model, ...(apiKey ? { apiKey } : {}) });
  const operationIsCurrent = (operation: number) => mountedRef.current
    && operation === operationRef.current
    && sessionLease.isCurrent();
  const save = async () => {
    const operation = ++operationRef.current;
    setErr(''); setMsg(''); setBusy(true);
    try {
      const result = await sessionLease.run(saveRequest);
      if (!result.current || !operationIsCurrent(operation)) return;
      commitSaved(); setMsg('已保存'); onSaved?.();
    } catch (e: any) {
      if (operationIsCurrent(operation)) setErr(e.message);
    } finally {
      if (operationIsCurrent(operation)) setBusy(false);
    }
  };
  const test = async () => {
    const operation = ++operationRef.current;
    setErr(''); setMsg(''); setBusy(true);
    try {
      const saved = await sessionLease.run(saveRequest);
      if (!saved.current || !operationIsCurrent(operation)) return;
      commitSaved();
      const tested = await sessionLease.run(api.aiTest);
      if (!tested.current || !operationIsCurrent(operation)) return;
      setMsg('连接正常：' + (tested.value.message || 'ok')); onSaved?.();
    } catch (e: any) {
      if (operationIsCurrent(operation)) setErr('测试失败：' + e.message);
    } finally {
      if (operationIsCurrent(operation)) setBusy(false);
    }
  };

  const isMock = provider === 'mock';

  return (
    <Modal title="AI 模型设置（自带模型 / Key）" width={540} onClose={onClose}
      footer={canManage ? <>
        <button className="btn ghost" onClick={test} disabled={busy}>保存并测试</button>
        <button className="btn primary" onClick={save} disabled={busy}>保存</button>
      </> : <button className="btn ghost" onClick={onClose}>关闭</button>}>

      <div className="hint-text" style={{ marginTop: 0 }}>
        推演用<strong>你自己的模型与额度</strong>调用，平台不承担 token 成本与授权。支持任意 OpenAI 兼容接口（国产模型大多支持）。Key 经 AES 加密存于服务端。
      </div>

      {!canManage && <div className="auth-err">仅工作区管理员可修改模型配置。</div>}

      <label className="fld"><span>选择模型服务商（预置一键填好地址）</span>
        <select disabled={!canManage} onChange={(e) => applyPreset(e.target.value)} value={PRESETS.find((p) => p.provider === provider && p.baseUrl === baseUrl)?.id ?? (isMock ? 'mock' : 'custom')}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>

      {isMock ? (
        <div className="donate-card" style={{ background: '#eff6ff', borderColor: '#bfdbfe' }}>
          <div className="donate-emoji">🧪</div>
          <div className="donate-note" style={{ color: '#1e40af' }}>内置演示模式：基于真实 G64111 数据生成推演，<strong>无需 Key、零成本</strong>，适合先体验。配置真实模型后可获得更深入分析。</div>
        </div>
      ) : (
        <>
          <label className="fld"><span>接口地址 Base URL</span>
            <input disabled={!canManage} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" /></label>
          <label className="fld"><span>模型名 Model</span>
            <input disabled={!canManage} value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" /></label>
          <label className="fld"><span>API Key {hasKey && <span style={{ color: '#16a34a' }}>（已配置，留空则不变）</span>}</span>
            <input disabled={!canManage} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={hasKey ? '••••••••（已保存）' : 'sk-...'} /></label>
        </>
      )}

      {msg && <div className="ok-msg">{msg}</div>}
      {err && <div className="auth-err">{err}</div>}
    </Modal>
  );
}
