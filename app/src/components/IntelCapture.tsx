import { useState, useRef, useMemo } from 'react';
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import type { Account, Opportunity } from '../types';
import { api, newIdempotencyKey } from '../api';
import { IntelReceipt } from './IntelReceipt';
import { visitAsks } from '../lib/gaps';

interface VoiceExtractPayload {
  text: string;
  accountId?: string;
  opportunityId?: string;
  personId?: string;
  priorText?: string;
}

export function buildVoiceExtractPayload(payload: VoiceExtractPayload): VoiceExtractPayload {
  return payload;
}

/** 可拖动悬浮面板：替代 Modal 的居中遮罩——无遮罩、默认右上角、拖标题栏移动，便于边录边看图。 */
function FloatPanel({ title, onClose, footer, width = 420, children }: {
  title: string; onClose: () => void; footer?: ReactNode; width?: number; children: ReactNode;
}) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null = CSS 默认（右上角）
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 某些环境无真实指针时忽略 */ }
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const x = Math.min(Math.max(8, e.clientX - drag.current.dx), window.innerWidth - 120);
    const y = Math.min(Math.max(8, e.clientY - drag.current.dy), window.innerHeight - 60);
    setPos({ x, y });
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => { drag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* noop */ } };
  return (
    <div className="intel-float" style={{ width, ...(pos ? { left: pos.x, top: pos.y, right: 'auto' } : {}) }}>
      <div className="intel-float-head" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <span>{title}</span>
        <button className="x-btn" onPointerDown={(e) => e.stopPropagation()} onClick={onClose}>×</button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-foot">{footer}</div>}
    </div>
  );
}

/**
 * 录入情报：销售用 Typeless 口述→转文字→粘贴→一键自动整理成 客户/商机/干系人/关系。
 * 双轨（见 docs/录入情报-设计方案.md）：口述明说直落正式库；AI 补充进「🔮 荐关系」候选。
 * 两态：输入 → 回执（不逐项二次确认）。
 */
export function IntelCapture({ account, opportunity, personId, onClose, onDone, onEnterAccount, embedded }: {
  account?: Account | null;
  opportunity?: Opportunity | null;
  personId?: string;
  onClose: () => void;
  onDone: () => void; // 落库后通知 App 重新拉取 state
  onEnterAccount?: (accId: string) => void; // 从零口述建客户后，回执里「进入客户」用
  embedded?: boolean; // true=嵌入「＋添加情报」单入口（去掉自带 FloatPanel 外壳，只出内容+底部按钮）
}) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'opp' | 'acc'>(opportunity ? 'opp' : 'acc');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [priorText, setPriorText] = useState(''); // 多轮增量：累积已提交口述，供「再补一句」给 LLM 消解指代
  const [askHint, setAskHint] = useState(''); // P1② 追问：点了回执里哪条追问，本轮口述＝对它的回答
  const [lockedAccountId, setLockedAccountId] = useState<string | null>(null); // fromScratch 首轮建客户后锁定，后续轮复用同一客户
  const fromScratch = !account; // Hub 入口：无 account，据口述自动新建客户
  const focusPerson = account?.persons.find((person) => person.id === personId);

  // P1② 我还想追问：抽取落库后按最新缺口出 1-3 条具体追问（visit 货架问句），这轮提到的人优先——单向倾倒变两回合对话
  const asks = useMemo(() => {
    if (!receipt || !account || !opportunity || scope !== 'opp') return [];
    const mentionNames = [
      ...(receipt.personsCreated ?? []).map((p: any) => p.name),
      ...(receipt.personsReused ?? []).map((p: any) => p.name),
      ...(receipt.rolesSet ?? []).map((r: any) => r.name),
    ];
    return visitAsks(account, opportunity, { mentionNames });
  }, [receipt, account, opportunity, scope]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const accId = account?.id ?? lockedAccountId ?? undefined; // fromScratch 多轮：首轮建的客户后续复用
      // 追问轮：把追问句拼进上文，LLM 才能消解「他挺支持的」这类对追问的指代式回答
      const prior = [
        focusPerson && `[本次拜访对象] ${focusPerson.name}${focusPerson.title ? `（${focusPerson.title}）` : ''}`,
        priorText,
        askHint && `[江湖追问] ${askHint}`,
      ].filter(Boolean).join('\n');
      const r = await api.voiceExtract(buildVoiceExtractPayload({
        text: text.trim(),
        accountId: accId,
        opportunityId: scope === 'opp' ? opportunity?.id : undefined,
        personId,
        priorText: prior || undefined,
      }), newIdempotencyKey());
      setReceipt(r);
      if (!accId && r?.account?.id) setLockedAccountId(r.account.id); // 首轮从零建客户 → 锁定，「再补一句」补到同一客户
      setPriorText((prev) => (prev ? prev + '\n' : '') + text.trim()); // 累积上文供下一轮指代消解
      setAskHint('');
      onDone();
    } catch (e: any) { setErr(e?.message || '录入失败'); }
    finally { setBusy(false); }
  };

  // 外壳：独立=可拖动悬浮面板 FloatPanel；embedded=嵌入「＋添加情报」单入口（只出内容 + 底部按钮）
  const shell = (title: string, width: number, footer: ReactNode, body: ReactNode) =>
    embedded
      ? <div className="intel-embed">{body}<div className="modal-foot">{footer}</div></div>
      : <FloatPanel title={title} width={width} onClose={onClose} footer={footer}>{body}</FloatPanel>;

  // ── 回执视图 ──
  if (receipt) {
    const c = receipt;
    const canEnter = Boolean(fromScratch && c.account?.id && onEnterAccount); // 从零建客户成功 → 可一键进入
    return shell('🎙️ 口述录入 · 已录入', 420,
      <>
        <button className="btn ghost" onClick={onClose}>完成</button>
        <button className={canEnter ? 'btn ghost' : 'btn primary'} onClick={() => { setReceipt(null); setText(''); setAskHint(''); }}>＋ 再记一条</button>
        {canEnter && <button className="btn primary" onClick={() => onEnterAccount!(c.account.id)}>🗺️ 进入客户</button>}
      </>,
      <>
        <IntelReceipt receipt={c} emptyHint={fromScratch ? '没听出客户名称——请在口述里说明是哪家客户，再试一次。' : '这段话里没识别到可建的客户/干系人。'} />
        {asks.length > 0 && (
          <div className="ir-asks">
            <div className="ir-asks-head">🤔 我还想追问——点一条，口头答我就行：</div>
            {asks.map((q) => (
              <button key={q} className="ir-ask" onClick={() => { setAskHint(q); setReceipt(null); setText(''); }}>{q}</button>
            ))}
          </div>
        )}
      </>,
    );
  }

  // ── 输入视图 ──
  const inTitle = askHint ? '🎙️ 口述录入 · 回答追问' : priorText ? '🎙️ 口述录入 · 再补一句（接着上文理解）' : fromScratch ? '🎙️ 口述录入 · 口述一段，自动建客户 + 干系人 + 关系' : '🎙️ 口述录入 · 一句话理清客户 / 商机 / 关系';
  return shell(inTitle, 440,
    <>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={submit} disabled={busy || !text.trim()}>{busy ? '整理中…' : '📥 录入成图'}</button>
    </>,
    <>
      {askHint
        ? <div className="intel-demo-hint">🤔 追问：<b>{askHint}</b><br />口头回答就行——「他 / 那位」这类指代江湖会接着上文理解，自动归位。</div>
        : priorText
        ? <div className="intel-demo-hint">接着上一条补充：可直接用「他 / 那位副总」等指代，江湖会结合上文理解，已建的人不会重复。</div>
        : fromScratch && <div className="intel-demo-hint">从零口述：请在文字里说出客户名称，江湖会据此自动新建客户，并整理干系人与关系。</div>}
      <label className="fld">
        <span>把这次拜访用 Typeless 口述、确认文字后粘到这里</span>
        <textarea autoFocus rows={6} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={fromScratch
            ? '例如："今天拜访了西部电力建设集团，见了分管信息化的王副总，对我们方案挺认可；他下面李处长管采购……"'
            : '例如："今天见了中石油王总，分管信息化的副总，对我们方案挺认可；他下面李处长管采购，李处长跟竞品有点老关系……"'} />
      </label>
      {opportunity && (
        <div className="fld">
          <span>归属</span>
          <div className="intel-scope">
            <label className="chk-line"><input type="radio" checked={scope === 'opp'} onChange={() => setScope('opp')} />当前商机「{opportunity.name}」</label>
            <label className="chk-line"><input type="radio" checked={scope === 'acc'} onChange={() => setScope('acc')} />仅记到客户（不关联商机）</label>
            {focusPerson && <div className="hint-text">本次拜访对象「{focusPerson.name}」</div>}
          </div>
        </div>
      )}
      {err && <div className="intel-err">{err}</div>}
    </>,
  );
}
