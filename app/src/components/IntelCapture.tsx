import { useState, useRef } from 'react';
import type { ReactNode, PointerEvent as ReactPointerEvent } from 'react';
import type { Account, Opportunity } from '../types';
import { api } from '../api';

/** 可拖动悬浮面板：替代 Modal 的居中遮罩——无遮罩、默认右上角、拖标题栏移动，便于边录边看墙。 */
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
export function IntelCapture({ account, opportunity, onClose, onDone, onEnterAccount }: {
  account?: Account | null;
  opportunity?: Opportunity | null;
  onClose: () => void;
  onDone: () => void; // 落库后通知 App 重新拉取 state
  onEnterAccount?: (accId: string) => void; // 从零口述建客户后，回执里「进入客户」用
}) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'opp' | 'acc'>(opportunity ? 'opp' : 'acc');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState<any>(null);
  const [priorText, setPriorText] = useState(''); // 多轮增量：累积已提交口述，供「再补一句」给 LLM 消解指代
  const [lockedAccountId, setLockedAccountId] = useState<string | null>(null); // fromScratch 首轮建客户后锁定，后续轮复用同一客户
  const fromScratch = !account; // Hub 入口：无 account，据口述自动新建客户

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const accId = account?.id ?? lockedAccountId ?? undefined; // fromScratch 多轮：首轮建的客户后续复用
      const r = await api.voiceExtract({ text: text.trim(), accountId: accId, opportunityId: scope === 'opp' ? opportunity?.id : undefined, priorText: priorText || undefined });
      setReceipt(r);
      if (!accId && r?.account?.id) setLockedAccountId(r.account.id); // 首轮从零建客户 → 锁定，「再补一句」补到同一客户
      setPriorText((prev) => (prev ? prev + '\n' : '') + text.trim()); // 累积上文供下一轮指代消解
      onDone();
    } catch (e: any) { setErr(e?.message || '录入失败'); }
    finally { setBusy(false); }
  };

  // ── 回执视图 ──
  if (receipt) {
    const c = receipt;
    const cands = [
      ...(c.candidates?.persons ?? []).map((p: any) => `${p.name}?`),
      ...(c.candidates?.relationships ?? []).map((r: any) => `${r.source}↔${r.target}?`),
    ];
    const builtNothing = !c.account && !c.opportunity && !(c.personsCreated?.length) && !(c.edgesCreated?.length) && !cands.length;
    const canEnter = Boolean(fromScratch && c.account?.id && onEnterAccount); // 从零建客户成功 → 可一键进入
    return (
      <FloatPanel title="🎙️ 录入情报 · 已录入" width={420} onClose={onClose}
        footer={<>
          <button className="btn ghost" onClick={onClose}>完成</button>
          <button className={canEnter ? 'btn ghost' : 'btn primary'} onClick={() => { setReceipt(null); setText(''); }}>＋ 再记一条</button>
          {canEnter && <button className="btn primary" onClick={() => onEnterAccount!(c.account.id)}>🗺️ 进入客户</button>}
        </>}>
        {(c.needConfig || c.demo) && (
          <div className="intel-demo-hint">未配 AI 模型，已先把口述存为拜访纪要。配置「🧠 AI 模型」后即可自动抽取客户/商机/干系人/关系。</div>
        )}
        <div className="intel-receipt">
          {c.account && <div className="ir-row">🏢 客户：<b>{c.account.name}</b>（{c.account.status === 'created' ? '新建' : '已关联'}）</div>}
          {c.opportunity && <div className="ir-row">🎯 商机：<b>{c.opportunity.name}</b>（{c.opportunity.status === 'created' ? '新建' : '已关联'}）</div>}
          {c.personsCreated?.length > 0 && <div className="ir-row">👤 新建干系人：<b>{c.personsCreated.map((p: any) => p.name).join('、')}</b> — 已上墙</div>}
          {c.rolesSet?.length > 0 && <div className="ir-row">🎭 角色：{c.rolesSet.map((r: any) => `${r.name}(${r.role})`).join('、')}</div>}
          {c.edgesCreated?.length > 0 && <div className="ir-row">🔗 关系：{c.edgesCreated.map((e: any) => `${e.source}→${e.target}`).join('、')} — 已上墙</div>}
          {c.burningIssues?.length > 0 && <div className="ir-row">🔥 燃眉之急：{c.burningIssues.map((b: any) => b.person).join('、')}</div>}
          {c.ucvs?.length > 0 && <div className="ir-row">💎 独特价值：{c.ucvs.map((u: any) => `${u.person}(${u.status})`).join('、')}</div>}
          {c.visitNote && <div className="ir-row">📝 拜访纪要已存档</div>}
          {c.notes?.length > 0 && <div className="ir-row">📌 {c.notes.length} 条线索已记入干系人备注（待核实）：{c.notes.map((n: any) => `${n.person}「${n.content}」`).join('；')}</div>}
          {builtNothing && !c.needConfig && <div className="ir-row" style={{ color: 'var(--muted)' }}>{c.note || (fromScratch ? '没听出客户名称——请在口述里说明是哪家客户，再试一次。' : '这段话里没识别到可建的客户/干系人。')}</div>}
          {cands.length > 0 && (
            <div className="ir-candidates">
              ⚠️ {cands.length} 条我拿不准的，已放进「🔮 荐关系」等你定夺：
              {cands.map((s, i) => <span key={i} className="cand-chip">{s}</span>)}
            </div>
          )}
          {c.dupWarnings?.length > 0 && (
            <div className="ir-candidates">
              ⚠️ 疑似重复（已按新建上墙；如与现有是同一个，请到画布 / 客户档案合并）：
              {c.dupWarnings.map((w: any, i: number) => <span key={i} className="cand-chip">{w.name} ≈ {w.similarTo}</span>)}
            </div>
          )}
        </div>
      </FloatPanel>
    );
  }

  // ── 输入视图 ──
  return (
    <FloatPanel title={priorText ? '🎙️ 录入情报 · 再补一句（接着上文理解）' : fromScratch ? '🎙️ 录入情报 · 口述一段，自动建客户 + 干系人 + 关系' : '🎙️ 录入情报 · 一句话理清客户 / 商机 / 关系'} width={440} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit} disabled={busy || !text.trim()}>{busy ? '整理中…' : '📥 录入成图'}</button>
      </>}>
      {priorText
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
          </div>
        </div>
      )}
      {err && <div className="intel-err">{err}</div>}
    </FloatPanel>
  );
}
