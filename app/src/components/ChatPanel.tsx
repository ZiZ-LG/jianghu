// 坞尾对话 · 录情报 + 改图的唯一文本入口（P3 文本入口收敛：AddIntel 口述 tab 退役，这里承接长短文本）。
// 复用「录入情报」voiceExtract 双轨管线（守铁律②）：你明说的直接生效带溯源；它推断的进收件箱待审。
// 多轮 priorText 指代消解 + IntelReceipt 结构化回执 + 抽取完基于缺口「我还想追问」（P1② 从口述 tab 迁入）。
// 与右栏参谋强分工：这里=「改·落库」，参谋=「问·不落库」。
import { useEffect, useRef, useState } from 'react';
import type { Account, Opportunity } from '../types';
import { api, newIdempotencyKey } from '../api';
import { IntelReceipt } from './IntelReceipt';
import { visitAsks } from '../lib/gaps';

type Msg = { role: 'user' | 'assistant'; text?: string; receipt?: any };

export function ChatPanel({ account, opp, onDone, height, onCollapse }: { account: Account; opp: Opportunity | null; onDone: () => void; height?: number; onCollapse?: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([{
    role: 'assistant',
    text: '录情报、改图都跟我说——短指令（「把钱大钧标记为抗拒」）行，整段拜访口述直接粘进来也行。明说的直接生效，推断的进收件箱。想问打法、要分析？选个人到右栏「🧭 参谋」，那边只想不落库。',
  }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [priorText, setPriorText] = useState(''); // 多轮增量：累积已提交文本，供 LLM 消解「他/那位」指代
  const [askHint, setAskHint] = useState('');     // P1② 追问：点了哪条追问，本轮输入＝对它的回答
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, busy, askHint]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setMsgs((m) => [...m, { role: 'user', text }]);
    setInput(''); setBusy(true);
    try {
      // 追问轮：把追问句拼进上文，LLM 才能消解「他挺支持的」这类指代式回答
      const prior = [priorText, askHint && `[江湖追问] ${askHint}`].filter(Boolean).join('\n');
      const r = await api.voiceExtract({ text, accountId: account.id, opportunityId: opp?.id, priorText: prior || undefined }, newIdempotencyKey());
      setMsgs((m) => [...m, { role: 'assistant', receipt: r }]);
      setPriorText((prev) => (prev ? prev + '\n' : '') + text);
      setAskHint('');
      onDone();
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', text: '处理失败：' + (e?.message || '未知错误') }]);
    } finally { setBusy(false); }
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // 追问只挂最后一条回执下，且用最新 account/opp 渲染时算——缺口被这轮回答补上后自动消失/轮换
  const lastReceiptIdx = msgs.reduce((acc, m, i) => (m.receipt ? i : acc), -1);
  const asksFor = (m: Msg): string[] => {
    if (!opp || !m.receipt) return [];
    const names = [
      ...(m.receipt.personsCreated ?? []).map((p: any) => p.name),
      ...(m.receipt.personsReused ?? []).map((p: any) => p.name),
      ...(m.receipt.rolesSet ?? []).map((r: any) => r.name),
    ];
    return visitAsks(account, opp, { mentionNames: names });
  };

  const rows = Math.min(6, Math.max(1, input.split('\n').length)); // 粘长口述自动长高
  return (
    <div className="chat-panel" style={height != null ? { height } : undefined}>
      <div className="chat-head">
        <span className="chat-title">💬 和地图对话</span>
        <span className="chat-hint">改图 · 录情报 · 会落库</span>
        {onCollapse && <button className="btn ghost xs" style={{ marginLeft: 'auto' }} onClick={onCollapse}>收起 ⌄</button>}
      </div>
      <div className="chat-list" ref={listRef}>
        {msgs.map((m, i) => m.receipt ? (
          <div className="chat-bub assistant chat-receipt" key={i}>
            <IntelReceipt receipt={m.receipt} emptyHint="这段话里没识别到可落的信息——补充点具体的人、事、关系再说一次。" />
            {i === lastReceiptIdx && !busy && (() => {
              const asks = asksFor(m);
              return asks.length > 0 && (
                <div className="ir-asks">
                  <div className="ir-asks-head">🤔 我还想追问——点一条，接着答我就行：</div>
                  {asks.map((q) => (
                    <button key={q} className="ir-ask" onClick={() => { setAskHint(q); inputRef.current?.focus(); }}>{q}</button>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          <div key={i} className={`chat-bub ${m.role}`}>{m.text}</div>
        ))}
        {busy && <div className="chat-bub assistant chat-typing">解析中…</div>}
      </div>
      {askHint && (
        <div className="chat-askhint">
          🤔 回答追问：<b>{askHint}</b>
          <button className="x-btn" onClick={() => setAskHint('')} title="取消追问">×</button>
        </div>
      )}
      <div className="chat-input">
        <textarea rows={rows} ref={inputRef} value={input}
          placeholder={askHint ? '口头回答就行——「他/那位」我会接着上文理解（Enter 发送）' : '说情报 / 改图 / 粘拜访口述…（落库 · Enter 发送，Shift+Enter 换行）'}
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={busy} />
        <button className="chat-send" onClick={send} disabled={busy || !input.trim()} title="发送" aria-label="发送">➤</button>
      </div>
    </div>
  );
}
