import { useState } from 'react';
import type { Account, Opportunity, Edge, Layer } from '../types';
import { LAYER_LABEL, LAYER_HINT } from '../types';
import { uid } from '../store';
import { Modal } from './Modal';

const COLORS = [
  { v: '#2563eb', n: '蓝·汇报' }, { v: '#16a34a', n: '绿·同盟' }, { v: '#ef4444', n: '红·冲突' },
  { v: '#f97316', n: '橙·牵制' }, { v: '#9333ea', n: '紫·影响' }, { v: '#1f2937', n: '深灰·授意' }, { v: '#94a3b8', n: '灰·默认' },
];

export function RelationshipEditor({
  account, opp, layer, onAddEdge, onDeleteEdge, onClose,
}: {
  account: Account;
  opp: Opportunity;
  layer: Layer;
  onAddEdge: (e: Edge) => void;
  onDeleteEdge: (id: string) => void;
  onClose: () => void;
}) {
  const persons = account.persons;
  const nameOf = (id: string) => persons.find((p) => p.id === id)?.name ?? '?';
  const [source, setSource] = useState(persons[0]?.id ?? '');
  const [target, setTarget] = useState(persons[1]?.id ?? '');
  const [lyr, setLyr] = useState<Layer>(layer);
  const [label, setLabel] = useState('');
  const [color, setColor] = useState('#2563eb');
  const [style, setStyle] = useState<'solid' | 'dashed'>('solid');
  const [directed, setDirected] = useState(true);

  const allEdges: Edge[] = [...account.baseEdges, ...opp.edges];

  const add = () => {
    if (!source || !target || source === target) return;
    onAddEdge({ id: uid('e'), source, target, layer: lyr, label: label.trim() || LAYER_LABEL[lyr].slice(3), color, style, directed, origin: 'manual' });
    setLabel('');
  };

  return (
    <Modal title="关系编辑（侦探墙连线）" width={580} onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>完成</button>}>
      <div className="rel-form">
        <div className="fld-row">
          <label className="fld"><span>起点</span>
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
          <label className="fld"><span>终点</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
        </div>
        <div className="fld-row">
          <label className="fld"><span>关系层</span>
            <select value={lyr} onChange={(e) => setLyr(e.target.value as Layer)}>
              {(['L1', 'L2', 'L3', 'L4'] as Layer[]).map((l) => <option key={l} value={l}>{LAYER_LABEL[l]}</option>)}
            </select></label>
          <label className="fld"><span>标签</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="如：直属/技术否决/校友/利益输送" /></label>
        </div>
        <div className="hint-text">{LAYER_HINT[lyr]}</div>
        <div className="fld-row">
          <label className="fld"><span>颜色</span>
            <select value={color} onChange={(e) => setColor(e.target.value)}>
              {COLORS.map((c) => <option key={c.v} value={c.v}>{c.n}</option>)}
            </select></label>
          <label className="fld"><span>线型</span>
            <select value={style} onChange={(e) => setStyle(e.target.value as 'solid' | 'dashed')}>
              <option value="solid">实线（已确认）</option><option value="dashed">虚线（待确认/弱）</option>
            </select></label>
          <label className="fld" style={{ flex: '0 0 auto', alignSelf: 'flex-end' }}>
            <label className="chk-line"><input type="checkbox" checked={directed} onChange={(e) => setDirected(e.target.checked)} />有向</label>
          </label>
        </div>
        <button className="btn primary" style={{ width: '100%' }} onClick={add}
          disabled={!source || !target || source === target}>＋ 添加连线</button>
      </div>

      <div className="rel-list-title">已有连线（{allEdges.length}）</div>
      <div className="rel-list">
        {allEdges.length === 0 && <div className="empty-hint">还没有连线。用上面的表单建立第一条关系。</div>}
        {allEdges.map((e) => (
          <div key={e.id} className="rel-row">
            <span className="rel-lyr" style={{ background: e.color || '#94a3b8' }}>{e.layer}</span>
            <span className="rel-txt">{nameOf(e.source)} <b>{e.directed ? '→' : '—'}</b> {nameOf(e.target)} · {e.label}</span>
            <button className="rel-del" onClick={() => onDeleteEdge(e.id)} title="删除">🗑</button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
