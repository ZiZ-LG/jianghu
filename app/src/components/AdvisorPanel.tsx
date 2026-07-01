// 参谋 · 深度对话（焦点面板「🧭 参谋」tab）：对着当前焦点人，带整张图上下文(buildAiContext)问 AI，多轮。
// 复用 /api/ai/simulate（无 Key 走 mockAnalysis 演示降级）。P2④a 先做问答；产出候选→落牌为 P2④b。
// 与左栏 ChatPanel(和地图对话·改图直落) 分工：这里是"想"（深度分析），那里是"改"（执行落库）。
import { useEffect, useRef, useState } from 'react';
import type { Account, Opportunity, Person } from '../types';
import type { ScoreBreakdown } from '../lib/g64111';
import { buildAiContext } from '../aiContext';
import { api } from '../api';

type Msg = { role: 'user' | 'assistant'; text: string };

export function AdvisorPanel({ account, opp, breakdown, person }: {
  account: Account; opp: Opportunity; breakdown: ScoreBreakdown; person: Person;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([{
    role: 'assistant',
    text: `对着「${person.name}」问我——怎么打、倒戈风险、下一步。我会带上整张图的上下文（角色 / 态度 / 关系 / 趋赢力 / 燃点）帮你深想。`,
  }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy]);

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || busy) return;
    setMsgs((m) => [...m, { role: 'user', text }]); setInput(''); setBusy(true);
    try {
      // 焦点：把"用户此刻盯着谁"明确标进上下文
      const ctx = { ...buildAiContext(account, opp, breakdown), focus: { name: person.name, title: person.title } };
      const r = await api.aiSimulate(ctx, `围绕干系人「${person.name}」：${text}`);
      setMsgs((m) => [...m, { role: 'assistant', text: r.analysis }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', text: '推演失败：' + (e?.message || '未知') + '（若未配模型，去「🧠 AI 模型」填一个自己的 Key；也可先看演示分析）' }]);
    } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); }
  };

  const quick = person.isCompetitor
    ? ['这个竞品的威胁点在哪', '怎么把跟它绑定的人策反']
    : ['他的倒戈风险多大', '给我攻坚他的下一步', '怎么把他往我方拉'];

  return (
    <div className="chat-panel" style={{ height: '100%' }}>
      <div className="chat-head">
        <span className="chat-title">🧭 参谋 · 对着「{person.name}」深想</span>
        <span className="chat-hint">带全图上下文 · 用你的模型</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
        {quick.map((q) => <button key={q} className="btn ghost xs" onClick={() => ask(q)} disabled={busy}>{q}</button>)}
      </div>
      <div className="chat-list" ref={listRef}>
        {msgs.map((m, i) => <div key={i} className={`chat-bub ${m.role}`}>{m.text}</div>)}
        {busy && <div className="chat-bub assistant chat-typing">结合整张图思考中…</div>}
      </div>
      <div className="chat-input">
        <textarea rows={1} value={input} placeholder={`问参谋关于「${person.name}」…（Enter 发送）`}
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={busy} />
        <button className="chat-send" onClick={() => ask(input)} disabled={busy || !input.trim()} title="发送" aria-label="发送">➤</button>
      </div>
    </div>
  );
}
