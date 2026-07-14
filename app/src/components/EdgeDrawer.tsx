import { useEffect, useRef, useState } from 'react';
import type { Edge, Person, Layer, EdgeShape } from '../types';
import { LAYER_LABEL, LAYER_HINT } from '../types';
import type { MutationCoordinator } from '../lib/sync/mutationCoordinator';
import { SyncStatus } from './SyncStatus';

const COLORS = [
  { v: '#2563eb', n: '蓝·汇报' }, { v: '#16a34a', n: '绿·同盟' }, { v: '#ef4444', n: '红·冲突' },
  { v: '#f97316', n: '橙·牵制' }, { v: '#9333ea', n: '紫·影响' }, { v: '#1f2937', n: '深灰·授意' }, { v: '#94a3b8', n: '灰·默认' },
];
const SHAPES: { v: EdgeShape; n: string }[] = [
  { v: 'straight', n: '直线' }, { v: 'orthogonal', n: '折线' }, { v: 'curved', n: '曲线' },
];

/** 双击连线打开的右侧边栏：编辑这条关系的各种属性（viewer=只读呈现，编辑控件不渲染） */
export function EdgeDrawer({
  edge, persons, onUpdate, onDraftUpdate, onDraftFlush, onDelete, onClose, readonly = false, coordinator, onViewCloud,
}: {
  edge: Edge;
  persons: Person[];
  onUpdate: (patch: Partial<Edge>) => void;
  onDraftUpdate?: (patch: Partial<Edge>) => void;
  onDraftFlush?: () => void | Promise<void>;
  onDelete: () => void;
  onClose: () => void;
  readonly?: boolean;
  coordinator?: MutationCoordinator;
  onViewCloud?: () => void | Promise<void>;
}) {
  const nameOf = (id: string) => persons.find((p) => p.id === id)?.name ?? '?';
  const shape: EdgeShape = edge.shape ?? (edge.layer === 'L1' ? 'orthogonal' : 'straight');
  const [labelDraft, setLabelDraft] = useState(edge.label);
  const dirty = useRef(false);
  const edgeId = useRef(edge.id);
  const pendingFlush = useRef<(() => void | Promise<void>) | undefined>(undefined);
  useEffect(() => setLabelDraft((current) => {
    if (edgeId.current !== edge.id || !dirty.current || current === edge.label) {
      edgeId.current = edge.id;
      dirty.current = false;
      return edge.label;
    }
    return current;
  }), [edge.id, edge.label]);
  useEffect(() => () => { void pendingFlush.current?.(); pendingFlush.current = undefined; }, [edge.id]);
  const viewCloud = async () => { await onViewCloud?.(); dirty.current = false; };

  if (readonly) {
    return (
      <div className="drawer edge-drawer">
        <div className="drawer-head">
          <div className="t">关系详情</div>
          <button className="x-btn" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-body">
          <div className="rel-head-txt">{nameOf(edge.source)} <b>{edge.directed ? '→' : '—'}</b> {nameOf(edge.target)}</div>
          <div className="ro-line"><span className="ro-k">关系层</span><span className="ro-v">{LAYER_LABEL[edge.layer]}</span></div>
          <div className="hint-text">{LAYER_HINT[edge.layer]}</div>
          <div className="ro-line"><span className="ro-k">关系标签</span><span className="ro-v">{edge.label || '—'}</span></div>
          <div className="ro-line"><span className="ro-k">线型</span><span className="ro-v">{edge.style === 'dashed' ? '虚线（待确认/弱）' : '实线（已确认）'}</span></div>
        </div>
      </div>
    );
  }

  return (
    <div className="drawer edge-drawer">
      <div className="drawer-head">
        <div className="t">关系编辑</div>
        <button className="x-btn" onClick={onClose}>✕</button>
      </div>
      {coordinator && <SyncStatus coordinator={coordinator} entityKey={`edge:${edge.id}`} onViewCloud={viewCloud} />}
      <div className="drawer-body">
        <div className="rel-head-txt">{nameOf(edge.source)} <b>{edge.directed ? '→' : '—'}</b> {nameOf(edge.target)}</div>

        <div className="edit-row">
          <label>起点
            <select value={edge.source} onChange={(e) => onUpdate({ source: e.target.value })}>
              {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>终点
            <select value={edge.target} onChange={(e) => onUpdate({ target: e.target.value })}>
              {persons.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        </div>

        <div className="fld sm"><span>关系层</span>
          <select value={edge.layer} onChange={(e) => onUpdate({ layer: e.target.value as Layer })}>
            {(['L1', 'L2', 'L3', 'L4'] as Layer[]).map((l) => <option key={l} value={l}>{LAYER_LABEL[l]}</option>)}
          </select>
        </div>
        <div className="hint-text">{LAYER_HINT[edge.layer]}</div>

        <div className="fld sm"><span>关系标签</span>
          <input value={labelDraft} onChange={(e) => { dirty.current = true; pendingFlush.current = onDraftFlush; setLabelDraft(e.target.value); (onDraftUpdate ?? onUpdate)({ label: e.target.value }); }}
            onBlur={() => { void pendingFlush.current?.(); pendingFlush.current = undefined; }} placeholder="如：直属/技术否决/校友/利益输送" />
        </div>

        <div className="fld-row">
          <label className="fld sm"><span>颜色</span>
            <select value={edge.color ?? '#94a3b8'} onChange={(e) => onUpdate({ color: e.target.value })}>
              {COLORS.map((c) => <option key={c.v} value={c.v}>{c.n}</option>)}
            </select>
          </label>
          <label className="fld sm"><span>线型</span>
            <select value={edge.style ?? 'solid'} onChange={(e) => onUpdate({ style: e.target.value as 'solid' | 'dashed' })}>
              <option value="solid">实线（已确认）</option><option value="dashed">虚线（待确认/弱）</option>
            </select>
          </label>
        </div>

        <div className="fld-row">
          <label className="fld sm"><span>形状</span>
            <select value={shape} onChange={(e) => onUpdate({ shape: e.target.value as EdgeShape })}>
              {SHAPES.map((s) => <option key={s.v} value={s.v}>{s.n}</option>)}
            </select>
          </label>
          <label className="fld sm" style={{ alignSelf: 'flex-end' }}>
            <label className="chk-line"><input type="checkbox" checked={!!edge.directed} onChange={(e) => onUpdate({ directed: e.target.checked })} />箭头</label>
          </label>
        </div>

        <button className="btn ghost" style={{ width: '100%', marginTop: 14, color: '#b91c1c' }} onClick={onDelete}>🗑 删除这条关系</button>
      </div>
    </div>
  );
}
