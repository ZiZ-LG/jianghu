import { useMemo, useRef, useState } from 'react';
import type { Account, Opportunity, Layer, Edge, OppRole, Person } from '../types';
import { ROLE_COLOR, SENTIMENT_CHAR, SENTIMENT_COLOR, FAMILY_7Q } from '../types';

const NODE_R = 30;
const ARROW_COLORS = ['#94a3b8', '#ef4444', '#b91c1c', '#f97316', '#16a34a', '#9333ea', '#2563eb', '#1f2937'];
const markerId = (c: string) => `arw-${(c || '#94a3b8').replace('#', '')}`;

function completeness(p: Person): number {
  const dims = [p.form.family, p.form.occupation, p.form.recreation, p.form.moneyMotivation].filter((d) => d.trim()).length;
  const fam = FAMILY_7Q.filter((q) => (p.form.family7[q] ?? '').trim()).length;
  return Math.round((dims / 4) * 50 + (fam / 7) * 50);
}
interface Pt { x: number; y: number; }

export function Canvas({
  account, opp, layer, selectedId, onSelectPerson, onMovePerson, suggestions = [],
}: {
  account: Account;
  opp: Opportunity;
  layer: Layer;
  selectedId: string | null;
  onSelectPerson: (id: string) => void;
  onMovePerson: (id: string, x: number, y: number) => void;
  suggestions?: { source: string; target: string }[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ tx: 40, ty: 30, scale: 1 });
  const [dragPt, setDragPt] = useState<{ id: string; x: number; y: number } | null>(null);
  const drag = useRef<null | { mode: 'pan' | 'node'; id?: string; mx: number; my: number; tx: number; ty: number; ox: number; oy: number }>(null);

  const roleByPerson = useMemo(() => {
    const m = new Map<string, OppRole>();
    for (const r of opp.roles) m.set(r.personId, r);
    return m;
  }, [opp]);

  const edges: Edge[] = useMemo(
    () => [...account.baseEdges, ...opp.edges].filter((e) => e.layer === layer),
    [account.baseEdges, opp.edges, layer],
  );

  const posOf = (p: Person): Pt => (dragPt && dragPt.id === p.id ? { x: dragPt.x, y: dragPt.y } : { x: p.x, y: p.y });
  const toWorld = (cx: number, cy: number): Pt => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: (cx - r.left - view.tx) / view.scale, y: (cy - r.top - view.ty) / view.scale };
  };

  const onDownBg = (e: React.MouseEvent) => { drag.current = { mode: 'pan', mx: e.clientX, my: e.clientY, tx: view.tx, ty: view.ty, ox: 0, oy: 0 }; };
  const onDownNode = (e: React.MouseEvent, p: Person) => {
    e.stopPropagation();
    onSelectPerson(p.id);
    const w = toWorld(e.clientX, e.clientY);
    drag.current = { mode: 'node', id: p.id, mx: e.clientX, my: e.clientY, tx: 0, ty: 0, ox: w.x - p.x, oy: w.y - p.y };
  };
  const onMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === 'pan') setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.mx), ty: d.ty + (e.clientY - d.my) }));
    else if (d.mode === 'node' && d.id) { const w = toWorld(e.clientX, e.clientY); setDragPt({ id: d.id, x: w.x - d.ox, y: w.y - d.oy }); }
  };
  const onUp = () => {
    if (drag.current?.mode === 'node' && dragPt) onMovePerson(dragPt.id, Math.round(dragPt.x), Math.round(dragPt.y));
    setDragPt(null);
    drag.current = null;
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

  return (
    <div ref={wrapRef} className={`canvas-wrap${drag.current?.mode === 'pan' ? ' grabbing' : ''}`}
      onMouseDown={onDownBg} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onWheel={onWheel}>
      {account.persons.length === 0 && (
        <div className="canvas-empty">👤 还没有干系人<br /><span>点左侧「干系人 ＋」把第一个人加到墙上</span></div>
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
            const sp = account.persons.find((p) => p.id === e.source), tp = account.persons.find((p) => p.id === e.target);
            if (!sp || !tp) return null;
            const s = posOf(sp), t = posOf(tp);
            const color = e.color || '#94a3b8';
            const useColor = ARROW_COLORS.includes(color) ? color : '#94a3b8';
            const mid = { x: (s.x + t.x) / 2, y: (s.y + t.y) / 2 };
            const marker = e.directed ? `url(#${markerId(useColor)})` : undefined;
            let d: string;
            if (e.layer === 'L1') {
              const midY = (s.y + t.y) / 2;
              d = `M ${s.x} ${s.y} V ${midY} H ${t.x} V ${t.y - NODE_R - 2}`;
            } else {
              const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
              d = `M ${s.x + (dx / len) * NODE_R} ${s.y + (dy / len) * NODE_R} L ${t.x - (dx / len) * (NODE_R + 4)} ${t.y - (dy / len) * (NODE_R + 4)}`;
            }
            return (
              <g key={e.id}>
                <path d={d} fill="none" stroke={color} strokeWidth={e.width || 1.5} strokeDasharray={e.style === 'dashed' ? '5,5' : undefined} markerEnd={marker} />
                {e.label && (
                  <text className="edge-label" x={mid.x} y={mid.y - 4} textAnchor="middle" fill={color}
                    stroke="#fff" strokeWidth={3} style={{ paintOrder: 'stroke' } as React.CSSProperties}>{e.label}</text>
                )}
              </g>
            );
          })}

          {/* AI 候选关系：灰虚线 + ❓（待确认，未写入） */}
          {suggestions.map((s, i) => {
            const sp = account.persons.find((p) => p.id === s.source), tp = account.persons.find((p) => p.id === s.target);
            if (!sp || !tp) return null;
            const a = posOf(sp), b = posOf(tp);
            const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            return (
              <g key={`sug${i}`} opacity={0.75}>
                <path d={`M ${a.x + (dx / len) * NODE_R} ${a.y + (dy / len) * NODE_R} L ${b.x - (dx / len) * NODE_R} ${b.y - (dy / len) * NODE_R}`}
                  fill="none" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="2,4" />
                <circle cx={mid.x} cy={mid.y} r={8} fill="#fff" stroke="#94a3b8" strokeWidth={1.5} />
                <text x={mid.x} y={mid.y + 3.5} textAnchor="middle" fontSize={11} fontWeight={800} fill="#64748b">?</text>
              </g>
            );
          })}

          {account.persons.map((p) => {
            const pt = posOf(p);
            const role = roleByPerson.get(p.id);
            const selected = selectedId === p.id;
            return (
              <g key={p.id} data-pid={p.id} transform={`translate(${pt.x},${pt.y})`} style={{ cursor: 'pointer' }} onMouseDown={(e) => onDownNode(e, p)}>
                <circle r={NODE_R} fill={p.isCompetitor ? '#1f2937' : '#fff'} stroke={selected ? '#2563eb' : '#cbd5e1'} strokeWidth={selected ? 3 : 2} />
                <text textAnchor="middle" y={4} className="node-name" fill={p.isCompetitor ? '#fff' : '#1e293b'} fontSize={p.isCompetitor ? 11 : 12}>
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
                    <rect width={44} height={4} rx={2} fill="#e2e8f0" />
                    <rect width={(44 * completeness(p)) / 100} height={4} rx={2} fill="#2563eb" />
                  </g>
                )}
                <text textAnchor="middle" y={NODE_R + 22} className="node-title" stroke="#f1f5f9" strokeWidth={3} style={{ paintOrder: 'stroke' } as React.CSSProperties}>{p.title}</text>
              </g>
            );
          })}
        </g>
      </svg>

      <div className="zoom-controls">
        <button onClick={() => zoomBy(1.15)}>+</button>
        <button onClick={() => zoomBy(0.87)}>−</button>
        <button onClick={() => setView({ tx: 40, ty: 30, scale: 1 })} style={{ fontSize: 12 }}>⤢</button>
      </div>
    </div>
  );
}
