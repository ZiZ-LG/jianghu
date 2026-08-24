import { useState, useEffect } from 'react';
import type { Account } from '../types';
import { customerTypeLabel, ROLE_LABEL } from '../types';
import { Modal } from './Modal';
import { CUSTOMER_SKELETONS, type SkeletonRole } from '../data/skeletons';

/**
 * 新建商机弹窗：① 按客户类型生成决策链骨架(M2，默认) ② 空白白板 ③ 从已有商机克隆。
 * 骨架=按 customerType 预置 A/D/U/R/C 占位节点(支持度未知)，建后双击改真名——把「对着白纸画组织图」变成「填空+删减」。
 * 人物客户级共享、角色/关系商机级独立（克隆=在新商机复制商机级数据，改新商机不影响源）。
 */
export function NewOpportunityDialog({ account, onClose, onCreate }: {
  account: Account;
  onClose: () => void;
  onCreate: (params: { name: string; fromOppId?: string; personIds: string[]; withEdges: boolean; skeleton?: SkeletonRole[] }) => void;
}) {
  const hasOpps = account.opportunities.length > 0;
  const [name, setName] = useState('');
  const hasSalesClassification = account.customerType !== null;
  const [mode, setMode] = useState<'skeleton' | 'blank' | 'clone'>(hasSalesClassification ? 'skeleton' : 'blank');
  const [fromOppId, setFromOppId] = useState(account.opportunities[0]?.id ?? '');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [withEdges, setWithEdges] = useState(true);

  // 骨架：按客户类型取典型决策链（docs/G64111-评分规格.md §1），默认全选
  const skeletonRoles = account.customerType === null ? [] : CUSTOMER_SKELETONS[account.customerType];
  const [skelSel, setSkelSel] = useState<Set<number>>(new Set(skeletonRoles.map((_, i) => i)));

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
  const toggleSkel = (i: number) => setSkelSel((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  const submit = () => {
    if (!name.trim()) return;
    if (mode === 'skeleton') {
      onCreate({ name: name.trim(), personIds: [], withEdges: false, skeleton: skeletonRoles.filter((_, i) => skelSel.has(i)) });
    } else if (mode === 'clone' && fromOpp) {
      onCreate({ name: name.trim(), fromOppId, personIds: [...sel], withEdges });
    } else {
      onCreate({ name: name.trim(), personIds: [], withEdges: false });
    }
  };

  return (
    <Modal title="＋ 新建商机" width={480} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={submit} disabled={!name.trim() || (mode === 'skeleton' && skelSel.size === 0)}>创建</button>
    </>}>
      <label className="fld"><span>商机名称</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder="如：二期数字化扩容" />
      </label>
      <div className="fld"><span>初始干系人</span>
        <div className="intel-scope">
          <label className="chk-line"><input type="radio" checked={mode === 'skeleton'} disabled={!hasSalesClassification} onChange={() => setMode('skeleton')} />按客户类型生成决策链骨架（推荐）</label>
          {!hasSalesClassification && <div className="intel-demo-hint">{customerTypeLabel(account.customerType)}：请先选择销售分类后再使用典型决策链。</div>}
          <label className="chk-line"><input type="radio" checked={mode === 'blank'} onChange={() => setMode('blank')} />空白白板（从零搭建）</label>
          {hasOpps && <label className="chk-line"><input type="radio" checked={mode === 'clone'} onChange={() => setMode('clone')} />从已有商机克隆</label>}
        </div>
      </div>

      {mode === 'skeleton' && (
        <div className="fld">
          <span>{customerTypeLabel(account.customerType)} · 典型决策链（{skelSel.size}/{skeletonRoles.length}，占位待认领）</span>
          <div className="clone-people">
            {skeletonRoles.map((r, i) => (
              <label key={i} className="chk-line">
                <input type="checkbox" checked={skelSel.has(i)} onChange={() => toggleSkel(i)} />
                <span className={`skel-role-badge r-${r.role}`}>{r.role}</span>{r.title}
                <span style={{ color: 'var(--muted)' }}> · {ROLE_LABEL[r.role]}</span>
              </label>
            ))}
          </div>
          <div className="intel-demo-hint" style={{ marginTop: 8 }}>按层级摆好 {skelSel.size} 个占位节点（支持度=未知）。建后双击改成真人姓名、删掉用不上的——不必从白纸开始。</div>
        </div>
      )}

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
