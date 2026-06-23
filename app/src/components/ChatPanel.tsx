// 左栏对话框 · 用自然语言改图/调信息。复用「录入情报」voiceExtract 双轨管线（守铁律②）：
// 你明说的（加人/连关系/改支持度…）直接生效带溯源；它推断的进收件箱待审。无模型时降级存笔记。
import { useEffect, useRef, useState } from 'react';
import type { Account, Opportunity } from '../types';
import { api } from '../api';

type Msg = { role: 'user' | 'assistant'; text: string };

// 尽量从 voiceExtract 回执提炼一句话；结构未知时给稳妥通用提示（真正的证明是地图随之刷新）
function summarize(r: any): string {
  if (r && (r.note || r.noKey || r.fallback || r.savedAsNote)) {
    return '当前工作区未配模型，已把这段存为笔记。配置模型后，对话才能解析成改图指令（加人 / 连关系 / 改支持度）。';
  }
  return '✓ 已处理：你明说的已直接生效（带溯源），它推断的已进收件箱待你审。地图已刷新。';
}

export function ChatPanel({ account, opp, onDone, height }: { account: Account; opp: Opportunity | null; onDone: () => void; height?: number }) {
  const [msgs, setMsgs] = useState<Msg[]>([{
    role: 'assistant',
    text: '改人、连关系、调打分都可以跟我说。例：「把钱大钧标记为抗拒」「加个采购处长王某，连到钱大钧」「钱大钧的 FORM 还差哪几项」。明说的直接生效，推断的进收件箱。',
  }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setMsgs((m) => [...m, { role: 'user', text }]);
    setInput(''); setBusy(true);
    try {
      const r = await api.voiceExtract({ text, accountId: account.id, opportunityId: opp?.id });
      setMsgs((m) => [...m, { role: 'assistant', text: summarize(r) }]);
      onDone();
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', text: '处理失败：' + (e?.message || '未知错误') }]);
    } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className="chat-panel" style={height != null ? { height } : undefined}>
      <div className="chat-head">
        <span className="chat-title">💬 和地图对话</span>
        <span className="chat-hint">用你的模型 · 守录入双轨</span>
      </div>
      <div className="chat-list" ref={listRef}>
        {msgs.map((m, i) => <div key={i} className={`chat-bub ${m.role}`}>{m.text}</div>)}
        {busy && <div className="chat-bub assistant chat-typing">解析中…</div>}
      </div>
      <div className="chat-input">
        <textarea rows={1} value={input} placeholder="和地图对话，改人 / 关系 / 打分…（Enter 发送）"
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={busy} />
        <button className="chat-send" onClick={send} disabled={busy || !input.trim()} title="发送" aria-label="发送">➤</button>
      </div>
    </div>
  );
}
