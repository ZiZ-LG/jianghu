import { useState } from 'react';
import type { Account, Opportunity } from '../types';
import { Modal } from './Modal';
import { api } from '../api';

/**
 * 录入情报：销售用 Typeless 口述→转文字→粘贴→一键自动整理成 客户/商机/干系人/关系。
 * 双轨（见 docs/录入情报-设计方案.md）：口述明说直落正式库；AI 补充进「🔮 荐关系」候选。
 * 两态：输入 → 回执（不逐项二次确认）。
 */
export function IntelCapture({ account, opportunity, onClose, onDone }: {
  account: Account;
  opportunity?: Opportunity | null;
  onClose: () => void;
  onDone: () => void; // 落库后通知 App 重新拉取 state
}) {
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'opp' | 'acc'>(opportunity ? 'opp' : 'acc');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [receipt, setReceipt] = useState<any>(null);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await api.voiceExtract({ text: text.trim(), accountId: account.id, opportunityId: scope === 'opp' ? opportunity?.id : undefined });
      setReceipt(r);
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
    return (
      <Modal title="🎙️ 录入情报 · 已录入" width={520} onClose={onClose}
        footer={<>
          <button className="btn ghost" onClick={onClose}>完成</button>
          <button className="btn primary" onClick={() => { setReceipt(null); setText(''); }}>＋ 再记一条</button>
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
          {c.visitNote && <div className="ir-row">📝 拜访纪要已存档</div>}
          {c.notes?.length > 0 && <div className="ir-row">📌 {c.notes.length} 条线索已记入干系人备注（待核实）：{c.notes.map((n: any) => `${n.person}「${n.content}」`).join('；')}</div>}
          {builtNothing && !c.needConfig && <div className="ir-row" style={{ color: 'var(--muted)' }}>这段话里没识别到可建的客户/干系人。</div>}
          {cands.length > 0 && (
            <div className="ir-candidates">
              ⚠️ {cands.length} 条我拿不准的，已放进「🔮 荐关系」等你定夺：
              {cands.map((s, i) => <span key={i} className="cand-chip">{s}</span>)}
            </div>
          )}
        </div>
      </Modal>
    );
  }

  // ── 输入视图 ──
  return (
    <Modal title="🎙️ 录入情报 · 一句话理清客户 / 商机 / 关系" width={560} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={submit} disabled={busy || !text.trim()}>{busy ? '整理中…' : '📥 录入成图'}</button>
      </>}>
      <label className="fld">
        <span>把这次拜访用 Typeless 口述、确认文字后粘到这里</span>
        <textarea autoFocus rows={6} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'例如："今天见了中石油王总，分管信息化的副总，对我们方案挺认可；他下面李处长管采购，李处长跟竞品有点老关系……"'} />
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
    </Modal>
  );
}
