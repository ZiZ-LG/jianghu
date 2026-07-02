// 参谋 · 深度对话 + 出候选（焦点面板「🧭 参谋」tab）：对着焦点人带全图上下文多轮问答（/api/ai/simulate），
// 想落地时「🎯 出候选」→ AI 承接对话产三类可落地候选：🃏行动牌 / 📌策略卡 / ⚠️风险 → 人审采纳落库（挂焦点人）。
// 守硬规则②：候选只本地暂存，采纳才 dispatch（ADD_PLAN_ACTION / ADD_STRATEGY_CARD / ADD_STRATEGY_RISK）；分析绝不自动改图。
// 与左栏 ChatPanel(和地图对话·改图直落) 分工：这里是"想 + 出候选"，那里是"改"。
import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { Account, Opportunity, Person } from '../types';
import type { ScoreBreakdown } from '../lib/g64111';
import type { Action } from '../store';
import { newPlanAction, newStrategyCard, newStrategyRisk } from '../store';
import { buildAiContext } from '../aiContext';
import { api, type AdvisorCand } from '../api';

type Msg = { role: 'user' | 'assistant'; text: string };
type Cand = AdvisorCand & { accepted?: boolean };
const todayYmd = () => new Date().toISOString().slice(0, 10);

export function AdvisorPanel({ account, opp, breakdown, person, dispatch }: {
  account: Account; opp: Opportunity; breakdown: ScoreBreakdown; person: Person; dispatch: Dispatch<Action>;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([{
    role: 'assistant',
    text: `对着「${person.name}」问我——怎么打、倒戈风险、下一步。我带整张图的上下文（角色/态度/关系/趋赢力/燃点）帮你深想；想落地就点「🎯 出候选」，我给出可采纳的 🃏行动牌 / 📌策略卡 / ⚠️风险。`,
  }]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [cardBusy, setCardBusy] = useState(false);
  const [cands, setCands] = useState<Cand[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs, cands, busy, cardBusy]);

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

  // 出候选：承接最近一问一答，产三类候选（本地暂存，采纳才落）
  const makeCards = async () => {
    if (cardBusy || busy) return;
    setCardBusy(true);
    try {
      const ctx = { ...buildAiContext(account, opp, breakdown), focus: { name: person.name, title: person.title } };
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.text || '';
      const asst = msgs.filter((m) => m.role === 'assistant');
      const lastAna = asst.length > 1 ? asst[asst.length - 1].text : ''; // 跳过欢迎语
      const note = [lastUser && `我刚问：${lastUser}`, lastAna && `你的分析要点：${lastAna.slice(0, 240)}`].filter(Boolean).join('\n');
      const r = await api.advisorActions(opp.id, { name: person.name, title: person.title }, ctx, note);
      const list: Cand[] = (r.candidates || []).map((c) => ({ ...c }));
      setCands(list);
      if (!list.length) setMsgs((m) => [...m, { role: 'assistant', text: '这一手我暂时没抽出可落地的候选——把目标聊具体些，或多问两句，我再出。' }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: 'assistant', text: '出候选失败：' + (e?.message || '未知') + '（若未配模型，去「🧠 AI 模型」填一个自己的 Key，或用内置演示模式）' }]);
    } finally { setCardBusy(false); }
  };

  // 采纳：按类型落不同库（行动牌→PlanAction 挂焦点人 / 策略卡→StrategyCard / 风险→StrategyRisk），全带 origin=ai
  const acceptCard = (i: number) => {
    const c = cands[i]; if (!c || c.accepted) return;
    if (c.kind === 'action') {
      const pa = newPlanAction(account.id, opp.id, todayYmd());
      pa.title = c.title; pa.target = c.purpose; pa.resources = c.resources; pa.cautions = c.cautions;
      pa.personId = person.id; pa.origin = 'ai';
      dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: opp.id, planAction: pa });
    } else if (c.kind === 'card') {
      const card = newStrategyCard(account.id, opp.id, c.gapItem || '');
      card.title = c.title; card.basis = c.basis; card.personId = person.id; card.origin = 'ai';
      dispatch({ type: 'ADD_STRATEGY_CARD', accId: account.id, oppId: opp.id, card });
    } else {
      const risk = newStrategyRisk(account.id, opp.id, 'risk');
      risk.text = c.title; risk.severity = c.severity; risk.origin = 'ai';
      dispatch({ type: 'ADD_STRATEGY_RISK', accId: account.id, oppId: opp.id, risk });
    }
    setCands((xs) => xs.map((x, j) => (j === i ? { ...x, accepted: true } : x)));
  };
  const ignoreCard = (i: number) => setCands((xs) => xs.filter((_, j) => j !== i));

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input); }
  };

  const quick = person.isCompetitor
    ? ['这个竞品的威胁点在哪', '怎么把跟它绑定的人策反']
    : ['他的倒戈风险多大', '给我攻坚他的下一步', '怎么把他往我方拉'];

  const META = {
    action: { ic: '🃏', tag: '行动牌', done: `已挂到「${person.name}」节点旁 · 去画布点牌可标完成 / 记反馈` },
    card: { ic: '📌', tag: '策略卡', done: '已进推演坞「策略泳道」' },
    risk: { ic: '⚠️', tag: '风险', done: '已进推演坞坞头 ⚠ 红条，常驻示警' }, // 第6刀：风险砍容器降级坞头红条
  } as const;

  return (
    <div className="chat-panel" style={{ height: '100%' }}>
      <div className="chat-head">
        <span className="chat-title">🧭 参谋 · 对着「{person.name}」深想</span>
        <span className="chat-hint">带全图上下文 · 用你的模型</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: '8px 12px', borderBottom: '1px solid var(--line)' }}>
        {quick.map((q) => <button key={q} className="btn ghost xs" onClick={() => ask(q)} disabled={busy}>{q}</button>)}
      </div>
      <div className="adv-cardbar">
        <button className="btn primary xs" disabled={cardBusy || busy} onClick={makeCards}>{cardBusy ? '结合对话出候选中…' : '🎯 出候选'}</button>
        <span className="adv-cardbar-hint">AI 产 行动牌 / 策略卡 / 风险 · 采纳挂「{person.name}」</span>
      </div>
      <div className="chat-list" ref={listRef}>
        {msgs.map((m, i) => <div key={i} className={`chat-bub ${m.role}`}>{m.text}</div>)}
        {busy && <div className="chat-bub assistant chat-typing">结合整张图思考中…</div>}
        {cardBusy && <div className="chat-bub assistant chat-typing">正在拟 行动 / 策略 / 风险 候选…</div>}
        {cands.map((c, i) => {
          const meta = META[c.kind];
          return (
            <div className={`adv-cand adv-cand-${c.kind}`} key={i}>
              <div className="adv-cand-top">
                <span className="adv-cand-title">{meta.ic} {c.title}</span>
                {c.accepted ? <span className="adv-cand-done">✓ 已采纳</span> : <span className="sb2-stamp">{meta.tag}·待采纳</span>}
              </div>
              {c.kind === 'action' && (<>
                <div className="adv-cand-meta"><b>目的</b>{c.purpose}</div>
                {c.resources && <div className="adv-cand-meta"><b>资源</b>{c.resources}</div>}
                {c.cautions && <div className="adv-cand-meta"><b>注意</b>{c.cautions}</div>}
              </>)}
              {c.kind === 'card' && (<>
                <div className="adv-cand-meta"><b>依据</b>{c.basis}</div>
                {c.gapItem && <div className="adv-cand-meta"><b>缺口</b>{c.gapItem}</div>}
              </>)}
              {c.kind === 'risk' && (
                <div className="adv-cand-meta"><b>等级</b>{c.severity === 'high' ? '高' : c.severity === 'mid' ? '中' : '低'}</div>
              )}
              {c.accepted
                ? <div className="adv-cand-hint">{meta.done}</div>
                : (
                  <div className="sb2-cand-acts">
                    <button className="btn primary xs" onClick={() => acceptCard(i)}>采纳</button>
                    <button className="btn ghost xs" onClick={() => ignoreCard(i)}>忽略</button>
                  </div>
                )}
            </div>
          );
        })}
      </div>
      <div className="chat-input">
        <textarea rows={1} value={input} placeholder={`问参谋关于「${person.name}」…（Enter 发送）`}
          onChange={(e) => setInput(e.target.value)} onKeyDown={onKey} disabled={busy} />
        <button className="chat-send" onClick={() => ask(input)} disabled={busy || !input.trim()} title="发送" aria-label="发送">➤</button>
      </div>
    </div>
  );
}
