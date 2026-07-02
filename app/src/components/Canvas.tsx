import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Opportunity, Layer, Edge, OppRole, Person, EdgeShape, PlanAction } from '../types';
import { ROLE_COLOR, ROLE_LABEL, SENTIMENT_CHAR, SENTIMENT_COLOR, SENTIMENT_LABEL, FAMILY_7Q } from '../types';
import { personContributions } from '../lib/g64111';

// 人物卡片尺寸（world 坐标，中心锚点）
const CARD_W = 168, CARD_H = 92, CHW = CARD_W / 2, CHH = CARD_H / 2;
const ARROW_GAP = 4;          // 箭头与目标节点的留白
const ANCHOR_GAP = 13;        // 锚点离节点边缘的距离
const NEW_NODE_DIST = 240;    // 点锚点(非拖拽)沿方向生成新节点的距离（按卡片宽度留间距）
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
// bend 含义随形状不同：折线=中段横线的 y 偏移(默认0)；曲线=控制点垂直偏移(默认40)；直线不用
const resolveBend = (e: Edge): number => e.bend ?? (resolveShape(e) === 'curved' ? 40 : 0);

/** 中心连线与卡片矩形边框的交点（borderPt），pad 为箭头留白 */
function rectClip(c: Pt, toward: Pt, pad = 0): Pt {
  const dx = toward.x - c.x, dy = toward.y - c.y;
  if (!dx && !dy) return { x: c.x, y: c.y };
  const sx = dx ? (CHW + pad) / Math.abs(dx) : Infinity;
  const sy = dy ? (CHH + pad) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

/** 连线几何：路径 d + 两端可拖拽点 a/b + 中间控制点 mid，端点按卡片矩形边框裁剪 */
function edgeGeom(s: Pt, t: Pt, shape: EdgeShape, bend: number) {
  if (shape === 'orthogonal') {
    const midY = (s.y + t.y) / 2 + bend;
    const sy = s.y + Math.sign(midY - s.y || 1) * CHH;
    const ty = t.y - Math.sign(t.y - midY || 1) * (CHH + ARROW_GAP);
    return { d: `M ${s.x} ${sy} V ${midY} H ${t.x} V ${ty}`, a: { x: s.x, y: sy }, b: { x: t.x, y: ty }, mid: { x: (s.x + t.x) / 2, y: midY } };
  }
  const a = rectClip(s, t);
  const b = rectClip(t, s, ARROW_GAP);
  if (shape === 'curved') {
    const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const cx = mx + px * bend, cy = my + py * bend;
    const qx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x, qy = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
    return { d: `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`, a, b, mid: { x: qx, y: qy } };
  }
  return { d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`, a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

type Gesture =
  | { kind: 'pan'; csx: number; csy: number; tx: number; ty: number }
  | { kind: 'node'; id: string; csx: number; csy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'link'; sourceId: string; dir: Dir; csx: number; csy: number; moved: boolean }
  | { kind: 'endpoint'; edgeId: string; end: 'source' | 'target'; csx: number; csy: number }
  | { kind: 'bend'; edgeId: string; csx: number; csy: number }
  | { kind: 'edge'; edgeId: string; csx: number; csy: number }
  | { kind: 'marquee'; csx: number; csy: number; x0: number; y0: number; append: boolean }
  | { kind: 'pinch' }
  | { kind: 'action'; actionId: string; csx: number; csy: number }
  | { kind: 'actionfb'; actionId: string; outcome: string; csx: number; csy: number };

export function Canvas({
  account, opp, planActions, visibleLayers, selectedId, selectedEdgeId,
  onSelectPerson, onSelectEdge, onOpenPerson, onOpenEdge, onOpenAction, onActionFeedback,
  onMovePerson, onAddPersonAt, onAddConnectedNode, onConnect,
  onUpdateEdge, onDeleteEdge, onUpdatePerson, onDeletePerson, suggestions = [],
  immersive = false, onToggleImmersive, secondTapOpens = false,
}: {
  account: Account;
  opp: Opportunity;
  visibleLayers: Set<Layer>;
  selectedId: string | null;
  selectedEdgeId: string | null;
  onSelectPerson: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onOpenPerson: (id: string) => void;
  onOpenEdge: (id: string) => void;
  onOpenAction?: (id: string) => void; // 点行动牌 → 开坞编辑抽屉
  onActionFeedback?: (id: string, outcome: 'up' | 'flat' | 'down') => void; // 牌上就地反馈：完成 + 态度 → 录证据
  onMovePerson: (id: string, x: number, y: number) => void;
  onAddPersonAt: (x: number, y: number) => string;
  onAddConnectedNode: (sourceId: string, x: number, y: number) => string;
  onConnect: (sourceId: string, targetId: string) => void;
  onUpdateEdge: (edgeId: string, patch: Partial<Edge>) => void;
  onDeleteEdge: (edgeId: string) => void;
  onUpdatePerson: (id: string, patch: Partial<Person>) => void;
  onDeletePerson: (id: string) => void;
  suggestions?: { source: string; target: string }[];
  planActions?: PlanAction[]; // 挂责任人节点旁的行动牌（主线：战场+行动令）
  immersive?: boolean;
  onToggleImmersive?: () => void;
  secondTapOpens?: boolean;   // 选中后再次单击即进入详情（桌面+手机统一；双击仍兼容）
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ tx: 40, ty: 30, scale: 1 });
  const [dragPt, setDragPt] = useState<{ id: string; x: number; y: number } | null>(null);
  const [linkPt, setLinkPt] = useState<{ x: number; y: number } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [endpointPt, setEndpointPt] = useState<{ edgeId: string; end: 'source' | 'target'; x: number; y: number } | null>(null);
  const [bendPreview, setBendPreview] = useState<{ edgeId: string; bend: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()); // 框选多选（节点）
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null); // 框选矩形(world)

  const gesture = useRef<Gesture | null>(null);
  const [fbAction, setFbAction] = useState<string | null>(null); // 画布牌就地反馈：正在选态度的行动 id
  const pointers = useRef<Map<number, Pt>>(new Map());
  const pinch = useRef<null | { dist: number; scale: number; tx: number; ty: number }>(null);
  const lastTap = useRef<null | { t: number; kind: string; id: string }>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const roleByPerson = useMemo(() => {
    const m = new Map<string, OppRole>();
    for (const r of opp.roles) m.set(r.personId, r);
    return m;
  }, [opp]);

  // 逐人贡献分（展示层分解，引擎口径见 docs/牌桌视图-设计方案.md §4）
  const contributions = useMemo(() => personContributions(account, opp), [account, opp]);

  // 商机级人物可见性：memberScoped 商机只显示成员集(含竞品)；存量商机(false/缺省)全员可见
  const visible = useMemo(
    () => (opp.memberScoped ? account.persons.filter((p) => (opp.memberIds ?? []).includes(p.id)) : account.persons),
    [account.persons, opp.memberScoped, opp.memberIds],
  );
  const visibleIds = useMemo(() => new Set(visible.map((p) => p.id)), [visible]);

  const edges: Edge[] = useMemo(
    () => [...account.baseEdges, ...opp.edges].filter((e) => visibleLayers.has(e.layer) && visibleIds.has(e.source) && visibleIds.has(e.target)),
    [account.baseEdges, opp.edges, visibleLayers, visibleIds],
  );
  const personById = useMemo(() => {
    const m = new Map<string, Person>();
    for (const p of visible) m.set(p.id, p);
    return m;
  }, [visible]);

  const posOf = (p: Person): Pt => (dragPt && dragPt.id === p.id ? { x: dragPt.x, y: dragPt.y } : { x: p.x, y: p.y });
  const toWorld = (cx: number, cy: number): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.scale, y: (cy - r.top - view.ty) / view.scale };
  };
  const toScreen = (wx: number, wy: number): Pt => ({ x: wx * view.scale + view.tx, y: wy * view.scale + view.ty });
  const nodeAt = (w: Pt, exclude?: string): string | null => {
    for (let i = visible.length - 1; i >= 0; i--) {
      const p = visible[i];
      if (p.id === exclude) continue;
      const pt = posOf(p);
      if (Math.abs(w.x - pt.x) <= CHW + 4 && Math.abs(w.y - pt.y) <= CHH + 4) return p.id;
    }
    return null;
  };

  // 聚焦内联命名输入框
  useEffect(() => {
    if (editing && editInputRef.current) { editInputRef.current.focus(); editInputRef.current.select(); }
  }, [editing?.id]);
  // 切层 / 商机 / 客户 → 清空框选多选
  useEffect(() => { setSelectedIds(new Set()); setMarquee(null); }, [visibleLayers, opp.id, account.id]);

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
  // 统一交互：已选中后再次单击 → 打开详情（桌面+手机一致，secondTapOpens）；双击仍可直接打开。
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
    const actionH = el.closest('[data-action]'); // 行动牌（挂节点旁）→ 点开编辑抽屉，优先于节点
    const actionFbH = el.closest('[data-action-fb]'); // 牌上就地反馈热区，最优先

    if (actionFbH) {
      gesture.current = { kind: 'actionfb', actionId: actionFbH.getAttribute('data-action-fb')!, outcome: actionFbH.getAttribute('data-fb-outcome') || 'trigger', csx: e.clientX, csy: e.clientY };
    } else if (actionH) {
      gesture.current = { kind: 'action', actionId: actionH.getAttribute('data-action')!, csx: e.clientX, csy: e.clientY };
    } else if (bendH) {
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
    } else if (e.button === 0 && e.shiftKey) {
      const w = toWorld(e.clientX, e.clientY);
      gesture.current = { kind: 'marquee', csx: e.clientX, csy: e.clientY, x0: w.x, y0: w.y, append: false }; // Shift+左键拖 = 框选
    } else {
      gesture.current = { kind: 'pan', csx: e.clientX, csy: e.clientY, tx: view.tx, ty: view.ty }; // 左键/中键空白拖 = 平移画布
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
    } else if (g.kind === 'marquee') {
      const w = toWorld(e.clientX, e.clientY);
      setMarquee({ x0: g.x0, y0: g.y0, x1: w.x, y1: w.y });
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
      if (!moved) return; // 仅在真正拖动后才生效，避免点击抖动误改
      const edge = edges.find((x) => x.id === g.edgeId);
      if (!edge) return;
      const s = posOf(personById.get(edge.source)!), t = posOf(personById.get(edge.target)!);
      const w = toWorld(e.clientX, e.clientY);
      let bend: number;
      if (resolveShape(edge) === 'orthogonal') {
        bend = w.y - (s.y + t.y) / 2;                   // 折线：上下拖动中段横线（不改形状）
      } else {
        const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
        const px = -dy / len, py = dx / len;
        const mx = (s.x + t.x) / 2, my = (s.y + t.y) / 2;
        bend = ((w.x - mx) * px + (w.y - my) * py) * 2;  // 曲线：调曲率
      }
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

    if (g.kind === 'actionfb') {
      if (!moved) { if (g.outcome === 'trigger') setFbAction(g.actionId); else { onActionFeedback?.(g.actionId, g.outcome as 'up' | 'flat' | 'down'); setFbAction(null); } }
    } else if (g.kind === 'action') {
      if (!moved) onOpenAction?.(g.actionId);
    } else if (g.kind === 'pan') {
      if (!moved) handleTap('empty', '', w);
    } else if (g.kind === 'marquee') {
      if (moved) {
        // 框内（节点完全在框内）→ 多选；竞品同样可框选；按 Shift 则并入已选
        const x0 = Math.min(g.x0, w.x), x1 = Math.max(g.x0, w.x), y0 = Math.min(g.y0, w.y), y1 = Math.max(g.y0, w.y);
        const ids = visible.filter((p) => { const pt = posOf(p); return pt.x - CHW >= x0 && pt.x + CHW <= x1 && pt.y - CHH >= y0 && pt.y + CHH <= y1; }).map((p) => p.id);
        setSelectedIds((s) => (g.append ? new Set([...s, ...ids]) : new Set(ids))); onSelectPerson(null); onSelectEdge(null);
      } else if (!g.append) { setSelectedIds(new Set()); handleTap('empty', '', w); } // Shift 空点不清，保留已选
      setMarquee(null);
    } else if (g.kind === 'edge') {
      if (!moved) handleTap('edge', g.edgeId, w);
    } else if (g.kind === 'node') {
      if (g.moved && dragPt) onMovePerson(g.id, Math.round(dragPt.x), Math.round(dragPt.y));
      else if (e.shiftKey) setSelectedIds((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n; }); // Shift+点 → 在已选上加/减该节点
      else { setSelectedIds(new Set()); handleTap('node', g.id, w); }
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
      // 只更新 bend（折线=中段位置 / 曲线=曲率），不改形状——拖中点不会把折线变成曲线
      if (moved && bendPreview) onUpdateEdge(g.edgeId, { bend: bendPreview.bend });
      setBendPreview(null);
    }
  };

  // 缩放走 native wheel 监听（passive:false）以 preventDefault——否则触控板双指捏合(=ctrl+wheel)会被浏览器解释为「整页缩放」
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const mx = e.clientX - r.left, my = e.clientY - r.top;
      // 指数映射 + 夹紧：触控板(deltaY 小)连续顺滑、鼠标滚轮(deltaY 大)不过冲
      const factor = Math.min(1.6, Math.max(0.6, Math.exp(-e.deltaY * 0.0075)));
      setView((v) => {
        const scale = Math.max(0.3, Math.min(2.5, v.scale * factor));
        return { scale, tx: mx - ((mx - v.tx) / v.scale) * scale, ty: my - ((my - v.ty) / v.scale) * scale };
      });
    };
    wrap.addEventListener('wheel', handler, { passive: false });
    return () => wrap.removeEventListener('wheel', handler);
  }, []);
  const zoomBy = (f: number) => setView((v) => ({ ...v, scale: Math.max(0.3, Math.min(2.5, v.scale * f)) }));
  // 总览：自适应缩放 + 居中，把全部节点完整纳入视口（竖屏/横屏通用，避开顶部菜单与底部药丸）
  const fitAll = () => {
    const ps = visible;
    const r = wrapRef.current?.getBoundingClientRect();
    if (!ps.length || !r) { setView({ tx: 40, ty: 30, scale: 1 }); return; }
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    const minX = Math.min(...xs) - CHW, maxX = Math.max(...xs) + CHW;
    const minY = Math.min(...ys) - CHH, maxY = Math.max(...ys) + CHH;
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const padX = 24, padTop = 64, padBottom = 76;  // 避开顶部菜单 + 底部药丸/缩放
    const availW = Math.max(1, r.width - padX * 2), availH = Math.max(1, r.height - padTop - padBottom);
    const scale = Math.max(0.3, Math.min(2.5, Math.min(availW / w, availH / h)));
    setView({ scale, tx: padX + (availW - w * scale) / 2 - minX * scale, ty: padTop + (availH - h * scale) / 2 - minY * scale });
  };

  const selEdge = selectedEdgeId ? edges.find((e) => e.id === selectedEdgeId) ?? null : null;
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  // 框选多选 → 对齐/分布（批量 onMovePerson，世界坐标）。对齐=居中成一线；分布=首尾不动、等间距。
  const alignSelected = (mode: 'hAlign' | 'vAlign' | 'hDist' | 'vDist') => {
    const ps = visible.filter((p) => selectedIds.has(p.id));
    if (ps.length < 2) return;
    if (mode === 'hAlign') { const c = Math.round(ps.reduce((s, p) => s + p.y, 0) / ps.length); ps.forEach((p) => { if (p.y !== c) onMovePerson(p.id, p.x, c); }); }
    else if (mode === 'vAlign') { const c = Math.round(ps.reduce((s, p) => s + p.x, 0) / ps.length); ps.forEach((p) => { if (p.x !== c) onMovePerson(p.id, c, p.y); }); }
    else if (mode === 'hDist') { const a = [...ps].sort((x, y) => x.x - y.x); const min = a[0].x, step = (a[a.length - 1].x - min) / (a.length - 1); a.forEach((p, i) => { const nx = Math.round(min + step * i); if (p.x !== nx) onMovePerson(p.id, nx, p.y); }); }
    else { const a = [...ps].sort((x, y) => x.y - y.y); const min = a[0].y, step = (a[a.length - 1].y - min) / (a.length - 1); a.forEach((p, i) => { const ny = Math.round(min + step * i); if (p.y !== ny) onMovePerson(p.id, p.x, ny); }); }
  };
  // 选中包围盒「中心·上沿」的屏幕坐标，用于浮动对齐工具栏定位
  const selBox = (() => {
    const ps = visible.filter((p) => selectedIds.has(p.id));
    if (ps.length < 2) return null;
    const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
    return toScreen((Math.min(...xs) + Math.max(...xs)) / 2, Math.min(...ys) - CHH);
  })();

  return (
    <div ref={wrapRef} className="canvas-wrap"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer}>
      {visible.length === 0 && (
        <div className="canvas-empty">👤 这个商机还没有干系人<br /><span>在空白处<b>双击</b>新建人物，或点左侧「干系人 ＋」</span></div>
      )}
      <svg>
        <defs>
          {ARROW_COLORS.map((c) => (
            <marker key={c} id={markerId(c)} markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill={c} />
            </marker>
          ))}
        </defs>
        <g style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`, transformOrigin: '0 0', willChange: 'transform' }}>
          {marquee && (() => {
            const x = Math.min(marquee.x0, marquee.x1), y = Math.min(marquee.y0, marquee.y1);
            const w = Math.abs(marquee.x1 - marquee.x0), h = Math.abs(marquee.y1 - marquee.y0);
            return <rect x={x} y={y} width={w} height={h} fill="var(--accent)" fillOpacity={0.08} stroke="var(--accent)" strokeWidth={1} strokeDasharray="4,3" vectorEffect="non-scaling-stroke" style={{ pointerEvents: 'none' }} />;
          })()}
          {edges.map((e) => {
            const sp = personById.get(e.source), tp = personById.get(e.target);
            if (!sp || !tp) return null;
            let s = posOf(sp), t = posOf(tp);
            // 端点改接预览
            if (endpointPt && endpointPt.edgeId === e.id) { if (endpointPt.end === 'source') s = endpointPt; else t = endpointPt; }
            const shape = resolveShape(e);
            const bend = bendPreview && bendPreview.edgeId === e.id ? bendPreview.bend : resolveBend(e);
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
            const sa = rectClip(a, b);
            const sb = rectClip(b, a);
            return (
              <g key={`sug${i}`} opacity={0.75} style={{ pointerEvents: 'none' }}>
                <path d={`M ${sa.x} ${sa.y} L ${sb.x} ${sb.y}`}
                  fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="2,4" />
                <circle cx={mid.x} cy={mid.y} r={8} fill="var(--node-fill)" stroke="#94a3b8" strokeWidth={1.5} />
                <text x={mid.x} y={mid.y + 3.5} textAnchor="middle" fontSize={11} fontWeight={800} fill="#64748b">?</text>
              </g>
            );
          })}

          {visible.map((p) => {
            const pt = posOf(p);
            const role = roleByPerson.get(p.id);
            const selected = selectedId === p.id || selectedIds.has(p.id);
            const isHover = hoverNode === p.id;
            const anchors = selected && !editing && (['top', 'right', 'bottom', 'left'] as Dir[]).map((dir) => {
              const v = DIR_VEC[dir];
              return (
                <circle key={dir} data-anchor={dir} data-anchor-node={p.id}
                  cx={v.x * (CHW + ANCHOR_GAP)} cy={v.y * (CHH + ANCHOR_GAP)} r={6}
                  className="node-anchor" fill="var(--accent)" stroke="#fff" strokeWidth={2} style={{ cursor: 'crosshair' }} />
              );
            });

            // ── 拟物人物卡片（规格见 docs/牌桌视图-设计方案.md §3）──
            const contrib = contributions.get(p.id);
              const gapAlert = !!role && (role.role === 'A' || role.role === 'D') && role.sentiment === 'unknown';
              const unverified = !p.isCompetitor && (p.logs ?? []).some((l) => (l.content ?? '').includes('待核实'));
              const bleeding = (contrib?.nominal ?? 0) < 0;
              const badge = bleeding ? { text: '失血', color: '#b91c1c' }
                : gapAlert ? { text: '缺口', color: '#dc2626' }
                : unverified ? { text: '待核实', color: '#b45309' }
                : role?.isKeyInfluencer ? { text: '★P4', color: '#b45309' } : null;
              const badgeW = badge ? badge.text.replace('★', '').length * 9 + (badge.text.includes('★') ? 12 : 0) + 12 : 0;
              const sentColor = role ? SENTIMENT_COLOR[role.sentiment] : 'var(--node-stroke)';
              const nominal = contrib?.nominal ?? 0;
              const nomText = contrib ? (nominal > 0 ? `+${nominal}` : String(nominal)) : '';
              const nomColor = nominal > 0 ? '#16a34a' : nominal < 0 ? '#b91c1c' : 'var(--node-text)';
              const isD = role?.role === 'D';
              const formFilled = isD ? FAMILY_7Q.filter((q) => (p.form.family7[q] ?? '').trim() !== '').length : 0;
              return (
                <g key={p.id} data-node={p.id} transform={`translate(${pt.x},${pt.y})`} style={{ cursor: dragPt?.id === p.id ? 'grabbing' : 'pointer' }}>
                  {p.isCompetitor ? (
                    <>
                      <rect x={-CHW} y={-CHH} width={CARD_W} height={CARD_H} rx={8} fill="#1f2937"
                        stroke={selected || isHover ? 'var(--accent)' : 'var(--node-stroke)'} strokeWidth={selected || isHover ? 2.5 : 1.5} />
                      <text textAnchor="middle" y={-8} fontSize={10.5} fill="#94a3b8">友商</text>
                      <text textAnchor="middle" y={14} fontSize={15} fontWeight={600} fill="#fff">{clipText(p.name, 8)}</text>
                    </>
                  ) : (
                    <>
                      <rect x={-CHW} y={-CHH} width={CARD_W} height={CARD_H} rx={8} fill="var(--node-fill)"
                        stroke={selected || isHover ? 'var(--accent)' : gapAlert ? '#dc2626' : (p.color || 'var(--node-stroke)')}
                        strokeWidth={selected || isHover || gapAlert ? 2.5 : p.color ? 2 : 1.5}
                        strokeDasharray={unverified ? '6,4' : undefined} />
                      <rect x={-CHW} y={-CHH + 8} width={3.5} height={CARD_H - 16} rx={1.75} fill={sentColor} />
                      {role ? (
                        <>
                          <g transform={`translate(-66,-31)`}>
                            <rect x={-12} y={-8.5} width={24} height={17} rx={3} fill="none" stroke={ROLE_COLOR[role.role]} strokeWidth={1.5} />
                            <text textAnchor="middle" y={3.5} fontSize={10} fontWeight={700} fill={ROLE_COLOR[role.role]}>{role.role}</text>
                          </g>
                          <text x={-48} y={-27.5} fontSize={9.5} fill="var(--node-text)" opacity={0.55}>{ROLE_LABEL[role.role]}{role.role === 'C' && p.coachLevel ? ` L${p.coachLevel}` : ''}</text>
                        </>
                      ) : (
                        <text x={-74} y={-27.5} fontSize={9.5} fill="var(--node-text)" opacity={0.45}>未指派角色</text>
                      )}
                      {badge && (
                        <g transform={`translate(${CHW - 6 - badgeW},-39)`}>
                          <rect width={badgeW} height={16} rx={3} fill={badge.color} opacity={0.12} />
                          <rect width={badgeW} height={16} rx={3} fill="none" stroke={badge.color} strokeWidth={1} opacity={0.5} />
                          <text x={badgeW / 2} y={11.5} textAnchor="middle" fontSize={9} fontWeight={700} fill={badge.color}>{badge.text}</text>
                        </g>
                      )}
                      <text x={-74} y={-4} fontSize={15} fontWeight={600} fill="var(--node-text)">{clipText(p.name, 8)}</text>
                      <text x={-74} y={12} fontSize={10.5} fill="var(--node-text)" opacity={0.55}>{clipText(p.title || '—', 13)}</text>
                      {contrib ? (
                        <>
                          <text x={-74} y={30} fontSize={17} fontWeight={700} fill={nomColor}>{nomText}</text>
                          <text x={-74 + nomText.length * 10 + 6} y={30} fontSize={9.5} fill="var(--node-text)" opacity={0.55}>
                            / 满 {contrib.potential}{contrib.upside > 0 ? ` · 可再 +${contrib.upside}` : ''}
                          </text>
                        </>
                      ) : (
                        <text x={-74} y={30} fontSize={10} fill="var(--node-text)" opacity={0.45}>指派角色后参与计分</text>
                      )}
                      {role ? (
                        <text x={-74} y={42} fontSize={10.5} fontWeight={700} fill={sentColor}>
                          {SENTIMENT_CHAR[role.sentiment]} <tspan fontSize={9.5} fontWeight={400}>{SENTIMENT_LABEL[role.sentiment]}</tspan>
                        </text>
                      ) : null}
                      <text x={74} y={42} textAnchor="end" fontSize={9.5} fill="var(--node-text)" opacity={0.55}>
                        {isD ? `FORM ${formFilled}/7` : `完成度 ${completeness(p)}%`}
                      </text>
                    </>
                  )}
                  {/* 行动牌：挂责任人节点右侧（主线·战场+行动令）。第4刀：坞内草稿(draft)不上画布，上桌后才挂牌 */}
                  {(planActions ?? []).filter((a) => a.personId === p.id && a.opportunityId === opp.id && !a.draft).map((a, i) => (
                    <g key={a.id} transform={`translate(${CHW + 10},${-CHH + 8 + i * 26})`}>
                      <g data-action={a.id} style={{ cursor: 'pointer' }}>
                        <rect width={124} height={22} rx={5} fill="var(--node-fill)" stroke={a.done ? '#16a34a' : 'var(--accent)'} strokeWidth={1.2} />
                        <text x={20} y={14.5} fontSize={10} fill="var(--node-text)">{clipText(a.title || '未命名行动', 12)}</text>
                      </g>
                      {a.done
                        ? <circle cx={11} cy={11} r={3.5} fill="#16a34a" style={{ pointerEvents: 'none' }} />
                        : (
                          <g data-action-fb={a.id} data-fb-outcome="trigger" style={{ cursor: 'pointer' }} aria-label="标完成并反馈">
                            <circle cx={11} cy={11} r={8} fill="transparent" />
                            <circle cx={11} cy={11} r={3.5} fill="var(--accent)" />
                          </g>
                        )}
                      {fbAction === a.id && (
                        <g transform="translate(0,25)">
                          <rect width={124} height={22} rx={5} fill="var(--node-fill)" stroke="var(--accent)" strokeWidth={1.2} />
                          <text x={7} y={14.5} fontSize={9} fill="var(--node-text)" opacity={0.6}>完成·效果</text>
                          {(['up', 'flat', 'down'] as const).map((o, k) => (
                            <g key={o} data-action-fb={a.id} data-fb-outcome={o} transform={`translate(${46 + k * 25},0)`} style={{ cursor: 'pointer' }}>
                              <rect x={0} y={3} width={22} height={16} rx={4} fill="transparent" stroke="var(--node-stroke)" strokeWidth={1} />
                              <text x={11} y={15} textAnchor="middle" fontSize={11} fontWeight={700} fill={o === 'up' ? '#16a34a' : o === 'down' ? '#b91c1c' : 'var(--node-text)'}>{o === 'up' ? '↑' : o === 'down' ? '↓' : '—'}</text>
                            </g>
                          ))}
                        </g>
                      )}
                    </g>
                  ))}
                  {anchors}
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
            const bnd = bendPreview && bendPreview.edgeId === selEdge.id ? bendPreview.bend : resolveBend(selEdge);
            const gm = edgeGeom(s, t, shp, bnd);
            return (
              <g>
                <circle data-edge-h={selEdge.id} data-endpoint="source" cx={gm.a.x} cy={gm.a.y} r={7}
                  fill="var(--node-fill)" stroke="var(--accent)" strokeWidth={2.5} style={{ cursor: 'grab' }} />
                <circle data-edge-h={selEdge.id} data-endpoint="target" cx={gm.b.x} cy={gm.b.y} r={7}
                  fill="var(--node-fill)" stroke="var(--accent)" strokeWidth={2.5} style={{ cursor: 'grab' }} />
                {/* 中间控制点：折线=拖动调中段横线位置；曲线=拖动调曲率。直线无中点(无中段可调，也不会被误触转曲线) */}
                {(shp === 'curved' || shp === 'orthogonal') && (
                  <circle data-bend={selEdge.id} cx={gm.mid.x} cy={gm.mid.y} r={7}
                    fill="var(--accent)" stroke="#fff" strokeWidth={2.5}
                    style={{ cursor: shp === 'orthogonal' ? 'ns-resize' : 'move' }} />
                )}
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
        const g = edgeGeom(posOf(sp), posOf(tp), resolveShape(selEdge), resolveBend(selEdge));
        const sc = toScreen(g.mid.x, g.mid.y);
        const cur = resolveShape(selEdge);
        const SB = ({ s, label }: { s: EdgeShape; label: string }) => (
          <button className={`shape-btn${cur === s ? ' on' : ''}`} onPointerDown={stop}
            onClick={() => { if (cur !== s) onUpdateEdge(selEdge.id, { shape: s, bend: s === 'curved' ? 40 : 0 }); }}>{label}</button>
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

      {selBox && (
        <div className="align-toolbar" onPointerDown={stop} style={{ left: selBox.x, top: Math.max(8, selBox.y - 44), transform: 'translateX(-50%)' }}>
          <span className="at-count">{selectedIds.size} 选中</span>
          <button className="at-icon" onClick={() => alignSelected('hAlign')} title="水平对齐：选中节点排到同一水平线">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><line x1="2" y1="12" x2="22" y2="12" stroke="currentColor" strokeWidth="1.4" /><circle cx="6" cy="12" r="2.6" fill="currentColor" /><circle cx="12" cy="12" r="2.6" fill="currentColor" /><circle cx="18" cy="12" r="2.6" fill="currentColor" /></svg>
          </button>
          <button className="at-icon" onClick={() => alignSelected('vAlign')} title="垂直对齐：选中节点排到同一垂直线">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><line x1="12" y1="2" x2="12" y2="22" stroke="currentColor" strokeWidth="1.4" /><circle cx="12" cy="6" r="2.6" fill="currentColor" /><circle cx="12" cy="12" r="2.6" fill="currentColor" /><circle cx="12" cy="18" r="2.6" fill="currentColor" /></svg>
          </button>
          <button className="at-icon" onClick={() => alignSelected('hDist')} title="水平分布：选中节点水平方向等间距">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M2 8 L2 16 M22 8 L22 16" stroke="currentColor" strokeWidth="1.4" /><circle cx="7" cy="12" r="2.6" fill="currentColor" /><circle cx="12" cy="12" r="2.6" fill="currentColor" /><circle cx="17" cy="12" r="2.6" fill="currentColor" /></svg>
          </button>
          <button className="at-icon" onClick={() => alignSelected('vDist')} title="垂直分布：选中节点垂直方向等间距">
            <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M8 2 L16 2 M8 22 L16 22" stroke="currentColor" strokeWidth="1.4" /><circle cx="12" cy="7" r="2.6" fill="currentColor" /><circle cx="12" cy="12" r="2.6" fill="currentColor" /><circle cx="12" cy="17" r="2.6" fill="currentColor" /></svg>
          </button>
          <button className="at-clear" onClick={() => setSelectedIds(new Set())} title="取消框选">✕</button>
        </div>
      )}

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
