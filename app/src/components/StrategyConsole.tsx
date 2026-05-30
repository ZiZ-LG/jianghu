import { useEffect, useRef, useState } from 'react';
import type { Account, Opportunity } from '../types';
import type { ScoreBreakdown } from '../lib/g64111';
import { api } from '../api';
import { buildAiContext } from '../aiContext';
import { Modal } from './Modal';
import { Markdownish } from './Markdownish';

const SUGGESTIONS = [
  '如果绕过拍板人直接找批准人，会有什么风险？',
  '当前最该补哪个 G64111 缺口？给出顺序。',
  '如何把倒向对手的关键人争取回来？',
  '下一步该重点搞定谁？给具体行动。',
];

interface Msg { role: 'user' | 'ai'; content: string; provider?: string }

export function StrategyConsole({
  account, opp, breakdown, onClose, onOpenSettings,
}: {
  account: Account;
  opp: Opportunity;
  breakdown: ScoreBreakdown;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [providerLabel, setProviderLabel] = useState('');
  const [needConfig, setNeedConfig] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.aiConfig().then((c) => {
      setNeedConfig(!c.configured);
      setProviderLabel(c.provider === 'mock' ? '内置演示' : (c.model || c.provider));
    }).catch(() => {});
  }, []);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [msgs, loading]);

  const send = async (text: string) => {
    const q = text.trim();
    if (!q || loading) return;
    setInput('');
    setMsgs((m) => [...m, { role: 'user', content: q }]);
    setLoading(true);
    try {
      const ctx = buildAiContext(account, opp, breakdown);
      const r = await api.aiSimulate(ctx, q);
      setMsgs((m) => [...m, { role: 'ai', content: r.analysis, provider: r.provider }]);
      setNeedConfig(false);
    } catch (e: any) {
      if (/配置/.test(e.message)) setNeedConfig(true);
      setMsgs((m) => [...m, { role: 'ai', content: `⚠️ ${e.message}` }]);
    } finally { setLoading(false); }
  };

  return (
    <Modal title="🧠 AI 战略推演台" width={680} onClose={onClose}
      footer={<div className="sc-foot">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send(input)}
          placeholder="输入一个假设策略，按 G64111 推演影响…" disabled={loading} />
        <button className="btn primary" onClick={() => send(input)} disabled={loading || !input.trim()}>{loading ? '推演中…' : '推演'}</button>
      </div>}>

      <div className="sc-bar">
        <span>当前模型：<b>{providerLabel || '加载中'}</b> · 趋赢力 {Math.round(breakdown.percent * 100)}%</span>
        <button className="link-btn" onClick={onOpenSettings}>模型设置</button>
      </div>

      {needConfig && (
        <div className="auth-err" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>尚未配置模型。可先用「内置演示（无需 Key）」体验。</span>
          <button className="btn primary sm" onClick={onOpenSettings}>去配置</button>
        </div>
      )}

      <div className="sc-stream" ref={scrollRef}>
        {msgs.length === 0 && !loading && (
          <div className="sc-empty">
            <div style={{ fontSize: 30 }}>🧠</div>
            <div>把你的攻关假设丢进来，AI 会基于当前干系人格局与趋赢力给出推演。</div>
            <div className="sc-chips">
              {SUGGESTIONS.map((s) => <button key={s} className="sc-chip" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`sc-msg ${m.role}`}>
            {m.role === 'user'
              ? <div className="sc-bubble-user">{m.content}</div>
              : <div className="sc-bubble-ai"><Markdownish text={m.content} />{m.provider && <div className="sc-prov">— {m.provider}</div>}</div>}
          </div>
        ))}
        {loading && <div className="sc-msg ai"><div className="sc-bubble-ai sc-typing"><span /><span /><span /></div></div>}
      </div>
    </Modal>
  );
}
