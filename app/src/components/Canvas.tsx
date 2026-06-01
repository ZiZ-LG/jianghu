import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Opportunity, Layer, Edge, OppRole, Person, EdgeShape } from '../types';
import { ROLE_COLOR, SENTIMENT_CHAR, SENTIMENT_COLOR, FAMILY_7Q } from '../types';

const NODE_R = 30;
const ARROW_GAP = 4;          // 箭头与目标节点的留白
const ANCHOR_GAP = 13;        // 锚点离节点边缘的距离
const NEW_NODE_DIST = 150;    // 点锚点(非拖拽)沿方向生成新节点的距离
const TAP_MOVE = 5;           // 屏幕位移 < 此值视为「点击」而非「拖拽」
const DOUBLE_MS = 300;        // 双击/双触时间窗
const ARROW_COLORS = ['#94a3b8', '#ef4444', '#b91c1c', '#f97316', '#16a34a', '#9333ea', '#2563eb', '#1f2937'];
const NODE_COLORS = ['#ef4444', '#f97316', '#16a34a', '#2563eb', '#9333ea', '#64748b']; // 节点高亮色（均配白字可读）
const markerId = (c: string) => `arw-${(c || '#94a3b8').replace('#', '')}`;

type Dir = 'top' | 'right' | 'bottom' | 'left';
const DIR_VEC: Record<Dir, { x: number; y: number }> = {
  top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 },
};

function completeness(p: Person): number {
  const dims = [p.form.family, p.form.occupation, p.form.recreation, p.form.moneyMotivation].filter((d) => d.trim()).length;
  const fam = FAMILY_7Q.filter((q) => (p.form.family7[q] ?? '').trim()).length;
  return Math.round((dims / 4) * 50 + (fam / 7) * 50);
}

interface Pt { x: number; y: number; }
const resolveShape = (e: Edge): EdgeShape => e.shape ?? (e.layer === 'L1' ? 'orthogonal' : 'straight');

/** 计算一条连线的路径 d + 两端可拖拽点 a/b + 中间控制点 mid（屏幕用 world 坐标） */
function edgeGeom(s: Pt, t: Pt, shape: EdgeShape, bend: number) {
  const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  if (shape === 'orthogonal') {
    const midY = (s.y + t.y) / 2;
    const sy = s.y + Math.sign(midY - s.y || 1) * NODE_R;
    const ty = t.y - Math.sign(t.y - midY || 1) * (NODE_R + ARROW_GAP);
    return { d: `M ${s.x} ${sy} V ${midY} H ${t.x} V ${ty}`, a: { x: s.x, y: sy }, b: { x: t.x, y: ty }, mid: { x: (s.x + t.x) / 2, y: midY } };
  }
  const a = { x: s.x + ux * NODE_R, y: s.y + uy * NODE_R };
  const b = { x: t.x - ux * (NODE_R + ARROW_GAP), y: t.y - uy * (NODE_R + ARROW_GAP) };
  if (shape === 'curved') {
    const px = -uy, py = ux;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const cx = mx + px * bend, cy = my + py * bend;
    const qx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x, qy = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
    return { d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`, a, b, mid: { x: qx, y: qy } };
  }
  return { d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

type Gesture =
  | { kind: 'pan'; csx: number; csy: number; tx: number; ty: number }
  | { kind: 'node'; id: string; csx: number; csy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'link'; sourceId: string; dir: Dir; csx: number; csy: number; moved: boolean }
  | { kind: 'endpoint'; edgeId: string; end: 'source' | 'target'; csx: number; csy: number }
  | { kind: 'bend'; edgeId: string; csx: number; csy: number }
  | { kind: 'edge'; edgeId: string; csx: number; csy: number }
  | { kind: 'pinch' };

export function Canvas({
  account, opp, layer, selectedId, selectedEdgeId,
  onSelectPerson, onSelectEdge, onOpenPerson, onOpenEdge,
  onMovePerson, onAddPersonAt, onAddConnectedNode, onConnect,
  onUpdateEdge, onDeleteEdge, onUpdatePerson, onDeletePerson, suggestions = [],
  immersive = false, onToggleImmersive, secondTapOpens = false,
}: {
  account: Account;
  opp: Opportunity;
  layer: Layer;
  selectedId: string | null;
  selectedEdgeId: string | null;
  onSelectPerson: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onOpenPerson: (id: string) => void;
  onOpenEdge: (id: string) => void;
  onMovePerson: (id: string, x: number, y: number) => void;
  onAddPersonAt: (x: number, y: number) => string;
  onAddConnectedNode: (sourceId: string, x: number, y: number) => string;
  onConnect: (sourceId: string, targetId: string) => void;
  onUpdateEdge: (edgeId: string, patch: Partial<Edge>) => void;
  onDeleteEdge: (edgeId: string) => void;
  onUpdatePerson: (id: string, patch: Partial<Person>) => void;
  onDeletePerson: (id: string) => void;
  suggestions?: { source: string; target: string }[];
  immersive?: boolean;
  onToggleImmersive?: () => void;
  secondTapOpens?: boolean;   // 手机端：已选中后再次单击即进入详情（替代双击）
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ tx: 40, ty: 30, scale: 1 });
  const [dragPt, setDragPt] = useState<{ id: string; x: number; y: number } | null>(null);
  const [linkPt, setLinkPt] = useState<{ x: number; y: number } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [endpointPt, setEndpointPt] = useState<{ edgeId: string; end: 'source' | 'target'; x: number; y: number } | null>(null);
  const [bendPreview, setBendPreview] = useState<{ edgeId: string; bend: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const gesture = useRef<Gesture | null>(null);
  const pointers = useRef<Map<number, Pt>>(new Map());
  const pinch = useRef<null | { dist: number; scale: number; tx: number; ty: number }>(null);
  const lastTap = useRef<null | { t: number; kind: string; id: string }>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const roleByPerson = useMemo(() => {
    const m = new Map<string, OppRole>();
    for (const r of opp.roles) m.set(r.personId, r);
    return m;
  }, [opp]);

  const edges: Edge[] = useMemo(
    () => [...account.baseEdges, ...opp.edges].filter((e) => e.layer === layer),
    [account.baseEdges, opp.edges, layer],
  );
  const personById = useMemo(() => {
    const m = new Map<string, Person>();
    for (const p of account.persons) m.set(p.id, p);
    return m;
  }, [account.persons]);

  const posOf = (p: Person): Pt => (dragPt && dragPt.id === p.id ? { x: dragPt.x, y: dragPt.y } : { x: p.x, y: p.y });
  const toWorld = (cx: number, cy: number): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.scale, y: (cy - r.top - view.ty) / view.scale };
  };
  const toScreen = (wx: number, wy: number): Pt => ({ x: wx * view.scale + view.tx, y: wy * view.scale + view.ty });
  const nodeAt = (w: Pt, exclude?: string): string | null => {
    for (let i = account.persons.length - 1; i >= 0; i--) {
      const p = account.persons[i];
      if (p.id === exclude) continue;
      const pt = posOf(p);
      if (Math.hypot(w.x - pt.x, w.y - pt.y) <= NODE_R + 4) return p.id;
    }
    return null;
  };

  // 聚焦内联命名输入框
  useEffect(() => {
    if (editing && editInputRef.current) { editInputRef.current.focus(); editInputRef.current.select(); }
  }, [editing?.id]);

  const commitEdit = () => {
    if (!editing) return;
    onUpdatePerson(editing.id, { name: editing.value.trim() || '新成员' });
    setEditing(null);
  };
  const beginEdit = (id: string) => {
    const p = personById.get(id);
    setEditing({ id, value: p?.name ?? '' });
  };

  // ── 点击/双击落点（不拖拽）→ 选中 / 打开右侧栏 / 空白双击建点 ──
  // 手机端(secondTapOpens)：小目标难双击，改为「已选中后再次单击 → 打开详情」；桌面仍走双击。
  const handleTap = (kind: 'empty' | 'node' | 'edge', id: string, world: Pt) => {
    const now = Date.now();
    const last = lastTap.current;
    const isDouble = !!last && now - last.t < DOUBLE_MS && last.kind === kind && last.id === id;
    if (kind === 'empty') {
      if (isDouble) { const nid = onAddPersonAt(Math.round(world.x), Math.round(world.y)); beginEdit(nid); lastTap.current = null; return; }
      if (editing) commitEdit();
      onSelectPerson(null); onSelectEdge(null);
    } else if (kind === 'node') {
      if (isDouble || (secondTapOpens && selectedId === id)) { onOpenPerson(id); lastTap.current = null; return; }
      onSelectPerson(id);
    } else {
      if (isDouble || (secondTapOpens && selectedEdgeId === id)) { onOpenEdge(id); lastTap.current = null; return; }
      onSelectEdge(id);
    }
    lastTap.current = { t: now, kind, id };
  };

  // ───────── pointer 事件（鼠标 / 触摸 / 触控笔统一）─────────
  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { wrapRef.current?.setPointerCapture(e.pointerId); } catch { /* 合成事件/无 active pointer 时忽略 */ }

    if (pointers.current.size === 2) {
      const ps = [...pointers.current.values()];
      const dist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) || 1;
      pinch.current = { dist, scale: view.scale, tx: view.tx, ty: view.ty };
      gesture.current = { kind: 'pinch' };
      return;
    }

    const el = e.target as Element;
    const bendH = el.closest('[data-bend]');
    const endpH = el.closest('[data-endpoint]');
    const anchorH = el.closest('[data-anchor]');
    const nodeH = el.closest('[data-node]');
    const edgeH = el.closest('[data-edge]');

    if (bendH) {
      gesture.current = { kind: 'bend', edgeId: bendH.getAttribute('data-bend')!, csx: e.clientX, csy: e.clientY };
    } else if (endpH) {
      gesture.current = { kind: 'endpoint', edgeId: endpH.getAttribute('data-edge-h')!, end: endpH.getAttribute('data-endpoint') as 'source' | 'target', csx: e.clientX, csy: e.clientY };
    } else if (anchorH) {
      gesture.current = { kind: 'link', sourceId: anchorH.getAttribute('data-anchor-node')!, dir: anchorH.getAttribute('data-anchor') as Dir, csx: e.clientX, csy: e.clientY, moved: false };
    } else if (nodeH) {
      const id = nodeH.getAttribute('data-node')!;
      const p = personById.get(id)!;
      const w = toWorld(e.clientX, e.clientY);
      gesture.current = { kind: 'node', id, csx: e.clientX, csy: e.clientY, ox: w.x - p.x, oy: w.y - p.y, moved: false };
    } else if (edgeH) {
      gesture.current = { kind: 'edge', edgeId: edgeH.getAttribute('data-edge')!, csx: e.clientX, csy: e.clientY };
    } else {
      gesture.current = { kind: 'pan', csx: e.clientX, csy: e.clientY, tx: view.tx, ty: view.ty };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;

    if (g.kind === 'pinch' && pinch.current && pointers.current.size >= 2) {
      const ps = [...pointers.current.values()];
      const r = wrapRef.current!.getBoundingClientRect();
      const dist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y) || 1;
      const midX = (ps[0].x + ps[1].x) / 2 - r.left, midY = (ps[0].y + ps[1].y) / 2 - r.top;
      const p0 = pinch.current;
      const scale = Math.max(0.3, Math.min(2.5, p0.scale * (dist / p0.dist)));
      const wx = (midX - p0.tx) / p0.scale, wy = (midY - p0.ty) / p0.scale;
      setView({ scale, tx: midX - wx * scale, ty: midY - wy * scale });
      return;
    }

    const moved = Math.hypot(e.clientX - (g as any).csx, e.clientY - (g as any).csy) > TAP_MOVE;
    if (g.kind === 'pan') {
      setView((v) => ({ ...v, tx: g.tx + (e.clientX - g.csx), ty: g.ty + (e.clientY - g.csy) }));
    } else if (g.kind === 'node') {
      if (moved) g.moved = true;
      const w = toWorld(e.clientX, e.clientY);
      setDragPt({ id: g.id, x: w.x - g.ox, y: w.y - g.oy });
    } else if (g.kind === 'link') {
      if (moved) g.moved = true;
      const w = toWorld(e.clientX, e.clientY);
      setLinkPt(w);
      setHoverNode(nodeAt(w, g.sourceId));
    } else if (g.kind === 'endpoint') {
      const w = toWorld(e.clientX, e.clientY);
      setEndpointPt({ edgeId: g.edgeId, end: g.end, x: w.x, y: w.y });
      const edge = edges.find((x) => x.id === g.edgeId);
      setHoverNode(nodeAt(w, g.end === 'source' ? edge?.target : edge?.source));
    } else if (g.kind === 'bend') {
      if (!moved) return; // 仅在真正拖动后才弯曲，避免「点击带抖动」误转曲线
      const edge = edges.find((x) => x.id === g.edgeId);
      if (!edge) return;
      const s = posOf(personById.get(edge.source)!), t = posOf(personById.get(edge.target)!);
      const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
      const px = -dy / len, py = dx / len;
      const w = toWorld(e.clientX, e.clientY);
      const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
      const bend = ((w.x - mx) * px + (w.y - my) * py) * 2;
      setBendPreview({ edgeId: g.edgeId, bend: Math.round(bend) });
    }
  };

  const endPointer = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (pointers.current.size < 2 && g?.kind === 'pinch') { pinch.current = null; gesture.current = null; }
    if (!g || g.kind === 'pinch') return;
    gesture.current = null;
    const moved = Math.hypot(e.clientX - (g as any).csx, e.clientY - (g as any).csy) > TAP_MOVE;
    const w = toWorld(e.clientX, e.clientY);

    if (g.kind === 'pan') {
      if (!moved) handleTap('empty', '', w);
    } else if (g.kind === 'edge') {
      if (!moved) handleTap('edge', g.edgeId, w);
    } else if (g.kind === 'node') {
      if (g.moved && dragPt) onMovePerson(g.id, Math.round(dragPt.x), Math.round(dragPt.y));
      else handleTap('node', g.id, w);
      setDragPt(null);
    } else if (g.kind === 'link') {
      const target = nodeAt(w, g.sourceId);
      if (target) {
        onConnect(g.sourceId, target);
      } else if (g.moved) {
        const nid = onAddConnectedNode(g.sourceId, Math.round(w.x), Math.round(w.y)); beginEdit(nid);
      } else {
        const src = personById.get(g.sourceId)!; const v = DIR_VEC[g.dir];
        const nid = onAddConnectedNode(g.sourceId, Math.round(src.x + v.x * NEW_NODE_DIST), Math.round(src.y + v.y * NEW_NODE_DIST)); beginEdit(nid);
      }
      setLinkPt(null); setHoverNode(null);
    } else if (g.kind === 'endpoint') {
      const edge = edges.find((x) => x.id === g.edgeId);
      const other = g.end === 'source' ? edge?.target : edge?.source;
      const target = nodeAt(w, other);
      if (moved && target && target !== other) onUpdateEdge(g.edgeId, { [g.end]: target } as Partial<Edge>);
      setEndpointPt(null); setHoverNode(null);
    } else if (g.kind === 'bend') {
      if (moved && bendPreview) onUpdateEdge(g.edgeId, { shape: 'curved', bend: bendPreview.bend });
      setBendPreview(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = wrapRef.current!.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    setView((v) => {
      const scale = Math.max(0.3, Math.min(2.5, v.scale * factor));
      return { scale, tx: mx - ((mx - v.tx) / v.scale) * scale, ty: my - ((my - v.ty) / v.scale) * scale };
    });
  };
  const zoomBy = (f: number) => setView((v) => ({ ...v, scale: Math.max(0.3, Math.min(2.5, v.scale * f)) }));
  // 总览：自适应缩放 + 居中，把全部节点完整纳入视口（竖屏/横屏通用，避开顶部菜单与底部药丸）
  const fitAll = () => {
    const ps = account.persons;
    const r = wrapRef.current?.getBoundingClientRect();
    if (!ps.length || !r) { setView({ tx: 40, ty: 30, scale: 1 }); return; }
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    const minX = Math.min(...xs) - NODE_R, maxX = Math.max(...xs) + NODE_R;
    const minY = Math.min(...ys) - NODE_R, maxY = Math.max(...ys) + NODE_R + 24; // 下方留出节点标题
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const padX = 24, padTop = 64, padBottom = 76;  // 避开顶部菜单 + 底部药丸/缩放
    const availW = Math.max(1, r.width - padX * 2), availH = Math.max(1, r.height - padTop - padBottom);
    const scale = Math.max(0.3, Math.min(2.5, Math.min(availW / w, availH / h)));
    setView({ scale, tx: padX + (availW - w * scale) / 2 - minX * scale, ty: padTop + (availH - h * scale) / 2 - minY * scale });
  };

  const selEdge = selectedEdgeId ? edges.find((e) => e.id === selectedEdgeId) ?? null : null;
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div ref={wrapRef} className="canvas-wrap"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onWheel={onWheel}>
      {account.persons.length === 0 && (
        <div className="canvas-empty">👤 还没有干系人<br /><span>在空白处<b>双击</b>新建人物，或点左侧「干系人 ＋」</span></div>
      )}
      <svg>
        <defs>
          {ARROW_COLORS.map((c) => (
            <marker key={c} id={markerId(c)} markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill={c} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.scale})`}>
          {edges.map((e) => {
            const sp = personById.get(e.source), tp = personById.get(e.target);
            if (!sp || !tp) return null;
            let s = posOf(sp), t = posOf(tp);
            // 端点改接预览
            if (endpointPt && endpointPt.edgeId === e.id) { if (endpointPt.end === 'source') s = endpointPt; else t = endpointPt; }
            const shape = resolveShape(e);
            const bend = bendPreview && bendPreview.edgeId === e.id ? bendPreview.bend : (e.bend ?? 40);
            const geom = edgeGeom(s, t, shape, bend);
            const color = e.color || '#94a3b8';
            const useColor = ARROW_COLORS.includes(color) ? color : '#94a3b8';
            const marker = e.directed ? `url(#${markerId(useColor)})` : undefined;
            const sel = selectedEdgeId === e.id;
            return (
              <g key={e.id}>
                <path d={geom.d} fill="none" stroke={color} strokeWidth={(e.width || 1.5) + (sel ? 1 : 0)}
                  strokeDasharray={e.style === 'dashed' ? '5,5' : undefined} markerEnd={marker} style={{ pointerEvents: 'none' }} />
                {/* 加宽透明命中区，便于点选 */}
                <path data-edge={e.id} d={geom.d} fill="none" stroke="transparent" strokeWidth={16}
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }} />
                {e.label && (
                  <text className="edge-label" x={geom.mid.x} y={geom.mid.y - 6} textAnchor="middle" fill={color}
                    stroke="var(--node-halo)" strokeWidth={3} style={{ paintOrder: 'stroke', pointerEvents: 'none' } as React.CSSProperties}>{e.label}</text>
                )}
              </g>
            );
          })}

          {/* 连线建立中的橡皮筋 */}
          {linkPt && gesture.current?.kind === 'link' && (() => {
            const src = personById.get((gesture.current as any).sourceId); if (!src) return null;
            const s = posOf(src);
            return <line x1={s.x} y1={s.y} x2={linkPt.x} y2={linkPt.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray="4,4" style={{ pointerEvents: 'none' }} />;
          })()}

          {/* AI 候选关系：灰虚线 + ❓ */}
          {suggestions.map((s, i) => {
            const sp = personById.get(s.source), tp = personById.get(s.target);
            if (!sp || !tp) return null;
            const a = posOf(sp), b = posOf(tp);
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            return (
              <g key={`sug${i}`} opacity={0.75} style={{ pointerEvents: 'none' }}>
                <path d={`M ${a.x + (dx / len) * NODE_R} ${a.y + (dy / len) * NODE_R} L ${b.x - (dx / len) * NODE_R} ${b.y - (dy / len) * NODE_R}`}
                  fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="2,4" />
                <circle cx={mid.x} cy={mid.y} r={8} fill="var(--node-fill)" stroke="#94a3b8" strokeWidth={1.5} />
                <text x={mid.x} y={mid.y + 3.5} textAnchor="middle" fontSize={11} fontWeight={800} fill="#64748b">?</text>
              </g>
            );
          })}

          {account.persons.map((p) => {
            const pt = posOf(p);
            const role = roleByPerson.get(p.id);
            const selected = selectedId === p.id;
            const isHover = hoverNode === p.id;
            return (
              <g key={p.id} data-node={p.id} transform={`translate(${pt.x},${pt.y})`} style={{ cursor: dragPt?.id === p.id ? 'grabbing' : 'pointer' }}>
                <circle r={NODE_R} fill={p.isCompetitor ? '#1f2937' : (p.color || 'var(--node-fill)')}
                  stroke={isHover ? 'var(--accent)' : selected ? 'var(--accent)' : 'var(--node-stroke)'} strokeWidth={selected || isHover ? 3 : 2} />
                <text textAnchor="middle" y={4} className="node-name" fill={(p.isCompetitor || p.color) ? '#fff' : 'var(--node-text)'} fontSize={p.isCompetitor ? 11 : 12}>
                  {p.isCompetitor ? '友商' : p.name}
                </text>
                {role && !p.isCompetitor && (
                  <g transform={`translate(${-NODE_R + 4},${-NODE_R + 4})`}>
                    <circle r={10} fill={ROLE_COLOR[role.role]} stroke="#fff" strokeWidth={1.5} />
                    <text textAnchor="middle" y={3.5} fontSize={9} fontWeight={700} fill="#fff">{role.role}</text>
                  </g>
                )}
                {role && !p.isCompetitor && (
                  <g transform={`translate(${NODE_R - 4},${-NODE_R + 4})`}>
                    <circle r={10} fill="#fff" stroke={SENTIMENT_COLOR[role.sentiment]} strokeWidth={1.5} />
                    <text textAnchor="middle" y={3.5} fontSize={11} fontWeight={800} fill={SENTIMENT_COLOR[role.sentiment]}>{SENTIMENT_CHAR[role.sentiment]}</text>
                  </g>
                )}
                {!p.isCompetitor && (
                  <g transform={`translate(${-22},${NODE_R + 4})`}>
                    <rect width={44} height={4} rx={2} fill="var(--node-stroke)" />
                    <rect width={(44 * completeness(p)) / 100} height={4} rx={2} fill="var(--accent)" />
                  </g>
                )}
                <text textAnchor="middle" y={NODE_R + 22} className="node-title" stroke="var(--node-halo)" strokeWidth={3} style={{ paintOrder: 'stroke', pointerEvents: 'none' } as React.CSSProperties}>{p.title}</text>

                {/* 选中 → 四周锚点：点/拖生成连线（关系） */}
                {selected && !editing && (['top', 'right', 'bottom', 'left'] as Dir[]).map((dir) => {
                  const v = DIR_VEC[dir];
                  return (
                    <circle key={dir} data-anchor={dir} data-anchor-node={p.id}
                      cx={v.x * (NODE_R + ANCHOR_GAP)} cy={v.y * (NODE_R + ANCHOR_GAP)} r={6}
                      className="node-anchor" fill="var(--accent)" stroke="#fff" strokeWidth={2} style={{ cursor: 'crosshair' }} />
                  );
                })}
              </g>
            );
          })}

          {/* 选中连线的可拖拽控制点：渲染在节点之上，避免被节点遮挡而点不到 */}
          {selEdge && (() => {
            const sp = personById.get(selEdge.source), tp = personById.get(selEdge.target);
            if (!sp || !tp) return null;
            let s = posOf(sp), t = posOf(tp);
            if (endpointPt && endpointPt.edgeId === selEdge.id) { if (endpointPt.end === 'source') s = endpointPt; else t = endpointPt; }
            const shp = resolveShape(selEdge);
            const bnd = bendPreview && bendPreview.edgeId === selEdge.id ? bendPreview.bend : (selEdge.bend ?? 40);
            const gm = edgeGeom(s, t, shp, bnd);
            return (
              <g>
                <circle data-edge-h={selEdge.id} data-endpoint="source" cx={gm.a.x} cy={gm.a.y} r={7}
                  fill="var(--node-fill)" stroke="var(--accent)" strokeWidth={2.5} style={{ cursor: 'grab' }} />
                <circle data-edge-h={selEdge.id} data-endpoint="target" cx={gm.b.x} cy={gm.b.y} r={7}
                  fill="var(--node-fill)" stroke="var(--accent)" strokeWidth={2.5} style={{ cursor: 'grab' }} />
                <circle data-bend={selEdge.id} cx={gm.mid.x} cy={gm.mid.y} r={7}
                  fill="var(--accent)" stroke="#fff" strokeWidth={2.5} style={{ cursor: 'move' }} />
              </g>
            );
          })()}
        </g>
      </svg>

      {/* 内联命名输入（建点后即可输入） */}
      {editing && (() => {
        const p = personById.get(editing.id); if (!p) return null;
        const sc = toScreen(posOf(p).x, posOf(p).y);
        return (
          <input ref={editInputRef} className="node-edit-input" value={editing.value}
            onPointerDown={stop} onChange={(ev) => setEditing({ id: editing.id, value: ev.target.value })}
            onKeyDown={(ev) => { if (ev.key === 'Enter') commitEdit(); else if (ev.key === 'Escape') setEditing(null); }}
            onBlur={commitEdit}
            style={{ left: sc.x, top: sc.y, transform: 'translate(-50%,-50%)' }} />
        );
      })()}

      {/* 选中连线 → 附近浮出「直线/折线/曲线」+ 删除（不含关系语义样式） */}
      {selEdge && (() => {
        const sp = personById.get(selEdge.source), tp = personById.get(selEdge.target);
        if (!sp || !tp) return null;
        const g = edgeGeom(posOf(sp), posOf(tp), resolveShape(selEdge), selEdge.bend ?? 40);
        const sc = toScreen(g.mid.x, g.mid.y);
        const cur = resolveShape(selEdge);
        const SB = ({ s, label }: { s: EdgeShape; label: string }) => (
          <button className={`shape-btn${cur === s ? ' on' : ''}`} onPointerDown={stop}
            onClick={() => onUpdateEdge(selEdge.id, { shape: s })}>{label}</button>
        );
        return (
          <div className="edge-toolbar" onPointerDown={stop} style={{ left: sc.x, top: sc.y - 40, transform: 'translate(-50%,-100%)' }}>
            <SB s="straight" label="直线" /><SB s="orthogonal" label="折线" /><SB s="curved" label="曲线" />
            <span className="edge-tb-sep" />
            <button className="shape-btn del" onPointerDown={stop} onClick={() => { onDeleteEdge(selEdge.id); onSelectEdge(null); }} title="删除连线">🗑</button>
          </div>
        );
      })()}

      {/* 选中节点 → 浮出「改色 + 删除」工具框（友商=预设样式，仅给删除，不提供改色） */}
      {selectedId && !editing && (() => {
        const p = personById.get(selectedId); if (!p) return null;
        const sc = toScreen(posOf(p).x, posOf(p).y);
        return (
          <div className="node-toolbar" onPointerDown={stop} style={{ left: sc.x, top: sc.y - 56, transform: 'translate(-50%,-100%)' }}>
            {!p.isCompetitor && (
              <>
                {NODE_COLORS.map((c) => (
                  <button key={c} className={`node-swatch${p.color === c ? ' on' : ''}`} title="高亮该节点"
                    style={{ background: c }} onPointerDown={stop} onClick={() => onUpdatePerson(p.id, { color: c })} />
                ))}
                <button className={`node-swatch clear${!p.color ? ' on' : ''}`} title="默认（清除颜色）"
                  onPointerDown={stop} onClick={() => onUpdatePerson(p.id, { color: '' })}>⊘</button>
                <span className="edge-tb-sep" />
              </>
            )}
            <button className="shape-btn del" onPointerDown={stop} onClick={() => onDeletePerson(p.id)} title="删除节点">🗑</button>
          </div>
        );
      })()}

      <div className="zoom-controls" onPointerDown={stop}>
        {!immersive && <button onClick={() => zoomBy(1.15)} title="放大">+</button>}
        {!immersive && <button onClick={() => zoomBy(0.87)} title="缩小">−</button>}
        {!immersive && <button onClick={fitAll} style={{ fontSize: 13 }} title="总览 · 显示完整图谱">⤢</button>}
        {onToggleImmersive && (
          <button className="fs-btn" onClick={onToggleImmersive} style={{ fontSize: 14 }}
            title={immersive ? '退出全屏' : '全屏 · 只看白板'}>{immersive ? '✕' : '⛶'}</button>
        )}
      </div>
    </div>
  );
}
