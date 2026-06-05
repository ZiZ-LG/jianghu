import { useState, useEffect } from 'react';
import type { Account } from '../types';
import { Modal } from './Modal';

/**
 * 新建商机弹窗：空白白板，或从已有商机【克隆】选定的人物（连带角色/支持度）+ 可选关系线。
 * 人物客户级共享、角色/关系商机级独立——克隆=在新商机复制商机级数据，改新商机不影响源（见 docs/录入情报-设计方案 / opp.ts）。
 */
export function NewOpportunityDialog({ account, onClose, onCreate }: {
  account: Account;
  onClose: () => void;
  onCreate: (params: { name: string; fromOppId?: string; personIds: string[]; withEdges: boolean }) => void;
}) {
  const hasOpps = account.opportunities.length > 0;
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'blank' | 'clone'>('blank');
  const [fromOppId, setFromOppId] = useState(account.opportunities[0]?.id ?? '');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [withEdges, setWithEdges] = useState(true);

  const fromOpp = account.opportunities.find((o) => o.id === fromOppId) ?? null;
  // 源商机可见人物：memberScoped 按成员集，否则该客户全部
  const srcPeople = fromOpp
    ? (fromOpp.memberScoped ? account.persons.filter((p) => (fromOpp.memberIds ?? []).includes(p.id)) : account.persons)
    : [];

  // 进入克隆模式 / 切换源商机时，默认全选其可见人物
  useEffect(() => {
    if (mode === 'clone' && fromOpp) setSel(new Set(srcPeople.map((p) => p.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, fromOppId]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const submit = () => {
    if (!name.trim()) return;
    onCreate(mode === 'clone' && fromOpp
      ? { name: name.trim(), fromOppId, personIds: [...sel], withEdges }
      : { name: name.trim(), personIds: [], withEdges: false });
  };

  return (
    <Modal title="＋ 新建商机" width={480} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={submit} disabled={!name.trim()}>创建</button>
    </>}>
      <label className="fld"><span>商机名称</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="如：二期数字化扩容" />
      </label>
      <div className="fld"><span>初始干系人</span>
        <div className="intel-scope">
          <label className="chk-line"><input type="radio" checked={mode === 'blank'} onChange={() => setMode('blank')} />空白白板（从零搭墙）</label>
          {hasOpps && <label className="chk-line"><input type="radio" checked={mode === 'clone'} onChange={() => setMode('clone')} />从已有商机克隆</label>}
        </div>
      </div>
      {mode === 'clone' && hasOpps && (
        <>
          <label className="fld"><span>克隆来源</span>
            <select value={fromOppId} onChange={(e) => setFromOppId(e.target.value)}>
              {account.opportunities.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <div className="fld"><span>勾选要克隆的人（{sel.size}/{srcPeople.length}）</span>
            <div className="clone-people">
              {srcPeople.map((p) => (
                <label key={p.id} className="chk-line">
                  <input type="checkbox" checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
                  {p.name}{p.isCompetitor ? '（竞品）' : ''}{p.title ? ` · ${p.title}` : ''}
                </label>
              ))}
              {srcPeople.length === 0 && <div style={{ color: 'var(--muted)' }}>该商机暂无可克隆的人</div>}
            </div>
          </div>
          <label className="chk-line"><input type="checkbox" checked={withEdges} onChange={(e) => setWithEdges(e.target.checked)} />同时克隆关系线（仅两端都勾选的）</label>
        </>
      )}
    </Modal>
  );
}
