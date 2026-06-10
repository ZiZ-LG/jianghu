// 商机策划 · 行动排期日历（V2：年/月/周三视图 + 三栏布局）。关系地图的孪生镜头。
// 布局：顶栏(镜头切换 ViewTabs + 年月周切换 + 翻页) | 左栏(三类事件+商机泳道显隐) | 中间(日历) | 右栏(常驻事件编辑，替代弹出抽屉)。
// 拖拽中本地 preview 覆盖、pointerup 才 dispatch（不每帧打云端）。触点(VisitNote)只读叠加。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Half } from '../types';
import type { Action } from '../store';
import { newPlanAction, newMilestone, newOppStage } from '../store';
import { ViewTabs, type CustomerView } from './ViewTabs';
import { usePersistentState } from '../ui';

// ── 日期工具（YYYY-MM-DD 全程字符串）──
const p2 = (n: number) => String(n).padStart(2, '0');
const D = (s: string) => new Date(s + 'T00:00:00');
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const addDays = (s: string, n: number) => { const d = D(s); d.setDate(d.getDate() + n); return ymd(d); };
const diffDays = (a: string, b: string) => Math.round((D(b).getTime() - D(a).getTime()) / 864e5);
const dowMon = (d: Date) => (d.getDay() + 6) % 7; // 周一=0
const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];

type Kind = 'action' | 'milestone' | 'touch';
type CalView = 'year' | 'month' | 'week';
interface CalEvent { id: string; kind: Kind; oppId: string; start: string; end: string; half: Half; title: string; done?: boolean; }

const KIND_ICON: Record<Kind, string> = { action: '🎯', milestone: '🚩', touch: '📌' };
const KIND_LABEL: Record<Kind, string> = { action: '行动计划', milestone: '里程碑', touch: '历史触点' };
// 线条眼睛图标（睁眼=显示 / 闭眼划线=隐藏），视觉弱、无填充
function EyeIcon({ off }: { off: boolean }) {
  return off ? (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24M6.06 6.06A18.46 18.46 0 0 0 1 12s4 8 11 8a9.12 9.12 0 0 0 5.94-2.06" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
const EDITABLE = (k: Kind) => k === 'action' || k === 'milestone';
const CAL_VIEWS: { id: CalView; label: string }[] = [{ id: 'year', label: '年' }, { id: 'month', label: '月' }, { id: 'week', label: '周' }];

// 阶段段（年视图模型 B）
export const STAGES = ['需求引导', '方案认可', '客户立项', '招投标', '合同谈判', '合同双签'];
export const STAGE_L = [73, 64, 56, 48, 41, 34]; // 6 档明度，越推进越深（年视图用）

// 商机色系：≤4 取 4 hue，第 5 起循环（§11-3）
const OPP_HUES = [217, 28, 145, 275, 340, 190];
const oppHue = (i: number) => OPP_HUES[((i % OPP_HUES.length) + OPP_HUES.length) % OPP_HUES.length];
const stageColor = (hue: number, k: number) => `hsl(${hue} ${k < 2 ? 58 : 62}% ${STAGE_L[k]}%)`;
const stageInk = (k: number) => (STAGE_L[k] > 54 ? '#1e293b' : '#fff');

function monthWeeks(cur: string) {
  const c = D(cur), y = c.getFullYear(), mo = c.getMonth();
  const lead = dowMon(new Date(y, mo, 1));
  const start = addDays(ymd(new Date(y, mo, 1)), -lead);
  const dim = new Date(y, mo + 1, 0).getDate();
  const rows = Math.ceil((lead + dim) / 7);
  const weeks: string[][] = [];
  for (let r = 0; r < rows; r++) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(start, r * 7 + i)));
  return { weeks, mo, y };
}
function weekDays(cur: string) { const mon = addDays(cur, -dowMon(D(cur))); return Array.from({ length: 7 }, (_, i) => addDays(mon, i)); }

const HALVES: { id: Half; label: string }[] = [{ id: 'am', label: '🌅 上午' }, { id: 'pm', label: '🌇 下午' }, { id: 'eve', label: '🌙 晚上' }];

interface EditorState { mode: 'create' | 'edit'; kind: Kind; editId?: string; oppId: string; title: string; start: string; end: string; half: Half; done: boolean; }

const laneH = 22, headH = 24, padB = 6;

export function DealPlanner({ account, dispatch, view, onChangeView, theme, onToggleTheme }: { account: Account; dispatch: (a: Action) => void; view: CustomerView; onChangeView: (v: CustomerView) => void; theme: 'light' | 'dark'; onToggleTheme: () => void }) {
  const [TODAY] = useState(() => ymd(new Date()));
  const [calView, setCalView] = usePersistentState<CalView>('jianghu.plannerView', 'month');
  const [cursor, setCursor] = useState(() => TODAY.slice(0, 8) + '01');
  const [sel, setSel] = useState<string | null>(null);
  const [hideKind, setHideKind] = useState<Set<Kind>>(() => new Set());
  const [hideOpp, setHideOpp] = useState<Set<string>>(() => new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<{ id: string; start: string; end: string } | null>(null);
  const [stageModal, setStageModal] = useState<{ mode: 'create' | 'edit'; oid: string; stageId?: string; k: number; start: string; end: string } | null>(null);

  const opps = account.opportunities;
  const oppIndex = useMemo(() => { const m: Record<string, number> = {}; opps.forEach((o, i) => (m[o.id] = i)); return m; }, [opps]);

  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = [];
    for (const a of account.planActions ?? []) out.push({ id: a.id, kind: 'action', oppId: a.opportunityId, start: a.startDate, end: a.endDate || a.startDate, half: a.half, title: a.title || '(未命名行动)', done: a.done });
    for (const m of account.milestones ?? []) out.push({ id: m.id, kind: 'milestone', oppId: m.opportunityId, start: m.startDate, end: m.endDate || m.startDate, half: m.half, title: m.title || '(未命名里程碑)' });
    for (const v of account.visitNotes ?? []) if (v.opportunityId && v.date) out.push({ id: v.id, kind: 'touch', oppId: v.opportunityId, start: v.date, end: v.date, half: 'pm', title: v.topic || (v.summary ? v.summary.slice(0, 18) : '触点') });
    return out.filter((e) => e.start);
  }, [account.planActions, account.milestones, account.visitNotes]);

  // 阶段段（年视图）：按商机分组，stageOfDay 找覆盖某日的段（多段重叠取最后定义）
  const stagesByOpp = useMemo(() => {
    const m: Record<string, { k: number; s: string; e: string; id: string }[]> = {};
    for (const st of account.oppStages ?? []) { const k = STAGES.indexOf(st.stageKey); (m[st.opportunityId] ??= []).push({ k: k < 0 ? 0 : k, s: st.startDate, e: st.endDate, id: st.id }); }
    return m;
  }, [account.oppStages]);
  const stageOfDay = (oid: string, ds: string) => { const segs = stagesByOpp[oid] || []; let r: { k: number; s: string; e: string; id: string } | null = null; for (const seg of segs) if (seg.s && ds >= seg.s && ds <= seg.e) r = seg; return r; };

  const visOpps = opps.filter((o) => !hideOpp.has(o.id));
  const laneOf: Record<string, number> = {}; visOpps.forEach((o, i) => (laneOf[o.id] = i));
  const visEvents = events.filter((e) => !hideKind.has(e.kind) && !hideOpp.has(e.oppId) && e.oppId in laneOf);
  const dispEv = (e: CalEvent): [string, string] => (preview && preview.id === e.id ? [preview.start, preview.end] : [e.start, e.end]);

  // ── 落库 / 选中 / 编辑（右栏） ──
  const commitDates = (e: CalEvent, start: string, end: string) => {
    if (e.kind === 'action') dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId: e.id, patch: { startDate: start, endDate: end } });
    else if (e.kind === 'milestone') dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId: e.id, patch: { startDate: start, endDate: end } });
  };
  const openEdit = (e: CalEvent) => { const [s, en] = dispEv(e); setSel(e.id); setEditor({ mode: 'edit', kind: e.kind, editId: e.id, oppId: e.oppId, title: e.title.startsWith('(') ? '' : e.title, start: s, end: en, half: e.half, done: !!e.done }); };
  const openCreate = (date: string, half: Half = 'am') => { setSel(null); setEditor({ mode: 'create', kind: 'action', oppId: visOpps[0]?.id ?? opps[0]?.id ?? '', title: '', start: date, end: date, half, done: false }); };
  const clickEvent = (id: string) => { const e = events.find((x) => x.id === id); if (!e) return; if (!EDITABLE(e.kind)) { setSel((s) => (s === id ? null : id)); return; } if (sel === id) openEdit(e); else setSel(id); };
  const commitHalf = (e: CalEvent, half: Half) => {
    if (e.kind === 'action') dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId: e.id, patch: { half } });
    else if (e.kind === 'milestone') dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId: e.id, patch: { half } });
  };
  const apiRef = useRef({ events, commitDates, commitHalf, clickEvent, calView });
  apiRef.current = { events, commitDates, commitHalf, clickEvent, calView };

  // ── 拖拽（月/周共享；周视图整体拖动可垂直跨带改时段；pointerup 才提交） ──
  type Drag = { id: string; mode: 'move' | 'start' | 'end' | 'tap'; dayPx: number; x0: number; oStart: string; oEnd: string; oHalf: Half; curHalf: Half; moved: boolean; curStart: string; curEnd: string };
  const dragRef = useRef<Drag | null>(null);
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const dg = dragRef.current; if (!dg) return;
      const dpx = ev.clientX - dg.x0; if (Math.abs(dpx) > 4) dg.moved = true;
      if (!dg.moved || dg.mode === 'tap') return;
      const dd = Math.round(dpx / dg.dayPx);
      let s = dg.oStart, e = dg.oEnd;
      if (dg.mode === 'move') { s = addDays(s, dd); e = addDays(e, dd); }
      else if (dg.mode === 'start') { s = addDays(s, dd); if (s > e) s = e; }
      else { e = addDays(e, dd); if (e < s) e = s; }
      dg.curStart = s; dg.curEnd = e;
      if (apiRef.current.calView === 'week' && dg.mode === 'move') { // 垂直落在哪个时段带 → 改 half
        const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const band = hit?.closest?.('[data-half]') as HTMLElement | null;
        if (band?.dataset.half) dg.curHalf = band.dataset.half as Half;
      }
      setPreview({ id: dg.id, start: s, end: e });
    };
    const onUp = () => {
      const dg = dragRef.current; if (!dg) return;
      dragRef.current = null; setPreview(null);
      const api = apiRef.current;
      if (dg.moved && dg.mode !== 'tap') {
        const e = api.events.find((x) => x.id === dg.id);
        if (e && EDITABLE(e.kind)) { api.commitDates(e, dg.curStart, dg.curEnd); if (dg.curHalf !== dg.oHalf) api.commitHalf(e, dg.curHalf); }
      } else if (!dg.moved) api.clickEvent(dg.id);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, []);
  const startDrag = (ev: React.PointerEvent, e: CalEvent, mode: Drag['mode']) => {
    ev.preventDefault(); ev.stopPropagation();
    const realMode: Drag['mode'] = EDITABLE(e.kind) ? mode : 'tap';
    const track = (ev.currentTarget as HTMLElement).closest('[data-track]') as HTMLElement | null;
    const dayPx = track ? track.clientWidth / 7 : 90;
    const [s, en] = dispEv(e);
    dragRef.current = { id: e.id, mode: realMode, dayPx, x0: ev.clientX, oStart: s, oEnd: en, oHalf: e.half, curHalf: e.half, moved: false, curStart: s, curEnd: en };
  };

  // ── 保存 / 删除 / 完成（右栏编辑器） ──
  const saveEditor = () => {
    if (!editor) return;
    const d = editor; const start = d.start || TODAY; const end = d.end && d.end >= start ? d.end : start;
    const title = d.title.trim() || (d.kind === 'action' ? '新行动' : '新里程碑');
    if (d.mode === 'create') {
      if (d.kind === 'action') dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: d.oppId, planAction: { ...newPlanAction(account.id, d.oppId, start, end, d.half), title, done: d.done, doneAt: d.done ? TODAY : undefined } });
      else dispatch({ type: 'ADD_MILESTONE', accId: account.id, oppId: d.oppId, milestone: { ...newMilestone(account.id, d.oppId, start, d.half), title, endDate: end } });
    } else if (d.editId) {
      if (d.kind === 'action') dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId: d.editId, patch: { title, startDate: start, endDate: end, half: d.half, done: d.done, doneAt: d.done ? TODAY : undefined } });
      else dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId: d.editId, patch: { title, startDate: start, endDate: end, half: d.half } });
    }
    setEditor(null); setSel(null);
  };
  const delEditor = () => {
    if (!editor?.editId) return;
    if (editor.kind === 'action') dispatch({ type: 'DELETE_PLAN_ACTION', accId: account.id, actionId: editor.editId });
    else if (editor.kind === 'milestone') dispatch({ type: 'DELETE_MILESTONE', accId: account.id, milestoneId: editor.editId });
    setEditor(null); setSel(null);
  };

  // 阶段段（年视图）
  const openStageCreate = (oid: string, ws: string, we: string) => setStageModal({ mode: 'create', oid, k: 0, start: ws, end: we });
  const openStageEdit = (oid: string, stageId: string) => { const seg = (stagesByOpp[oid] || []).find((s) => s.id === stageId); if (seg) setStageModal({ mode: 'edit', oid, stageId, k: seg.k, start: seg.s, end: seg.e }); };
  const saveStage = () => {
    if (!stageModal) return; const m = stageModal; const start = m.start; const end = m.end && m.end >= start ? m.end : start; const stageKey = STAGES[m.k];
    if (m.mode === 'create') dispatch({ type: 'ADD_OPP_STAGE', accId: account.id, oppId: m.oid, stage: newOppStage(account.id, m.oid, stageKey, start, end) });
    else if (m.stageId) dispatch({ type: 'UPDATE_OPP_STAGE', accId: account.id, stageId: m.stageId, patch: { stageKey, startDate: start, endDate: end } });
    setStageModal(null);
  };
  const delStage = () => { if (stageModal?.stageId) dispatch({ type: 'DELETE_OPP_STAGE', accId: account.id, stageId: stageModal.stageId }); setStageModal(null); };

  // ── 导航 ──
  const { weeks, mo, y } = monthWeeks(cursor);
  const shift = (dir: number) => {
    setSel(null);
    if (calView === 'month') setCursor(ymd(new Date(y, mo + dir, 1)));
    else if (calView === 'week') setCursor(addDays(cursor, dir * 7));
    else setCursor(ymd(new Date(y + dir, mo, 1)));
  };
  const goToday = () => { setSel(null); setCursor(calView === 'week' ? TODAY : TODAY.slice(0, 8) + '01'); };
  const periodTitle = calView === 'year' ? `${y}年` : calView === 'month' ? `${y}年${mo + 1}月` : (() => { const ds = weekDays(cursor); return `${D(ds[0]).getMonth() + 1}月${D(ds[0]).getDate()}日 – ${D(ds[6]).getMonth() + 1}月${D(ds[6]).getDate()}日`; })();
  const tog = <T,>(set: Set<T>, k: T) => { const n = new Set(set); n.has(k) ? n.delete(k) : n.add(k); return n; };
  const statusMark = (e: CalEvent) => { if (e.kind !== 'action') return null; if (e.done) return <span className="dp-ok">✓</span>; if (e.end < TODAY) return <span className="dp-late">✕</span>; return null; };

  // ── 月视图 ──
  function renderMonth() {
    const bodyH = headH + opps.length * laneH + padB;
    return (
      <div className="dp-cal" onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.dp-bar')) setSel(null); }}>
        <div className="dp-dow">{WEEK_CN.map((w, i) => <div key={w} className={i >= 5 ? 'we' : ''}>周{w}</div>)}</div>
        <div className="dp-weeks">
          {weeks.map((wk) => {
            const wStart = wk[0], wEnd = wk[6];
            return (
              <div className="dp-week" key={wStart} style={{ minHeight: bodyH }}>
                <div className="dp-cells">
                  {wk.map((ds) => { const d = D(ds); const out = d.getMonth() !== mo; const we = d.getDay() === 0 || d.getDay() === 6;
                    return <div key={ds} className={`dp-cell${out ? ' out' : ''}${we ? ' we' : ''}`} onDoubleClick={() => openCreate(ds)}><div className={`dp-dnum${ds === TODAY ? ' today' : ''}`}>{d.getDate()}</div></div>; })}
                </div>
                <div className="dp-bars" data-track style={{ height: bodyH }}>
                  {visEvents.map((e) => {
                    const [es, ee] = dispEv(e);
                    if (ee < wStart || es > wEnd) return null;
                    const segS = es < wStart ? wStart : es, segE = ee > wEnd ? wEnd : ee;
                    const col = diffDays(wStart, segS), span = diffDays(segS, segE) + 1, top = headH + (laneOf[e.oppId] ?? 0) * laneH;
                    const selected = sel === e.id, showL = selected && EDITABLE(e.kind) && es >= wStart, showR = selected && EDITABLE(e.kind) && ee <= wEnd;
                    return (
                      <div key={e.id} className={`dp-bar k-${e.kind}${e.done ? ' done' : ''}${selected ? ' sel' : ''}`} title={e.title}
                        style={{ left: `calc(${(col / 7) * 100}% + 3px)`, width: `calc(${(span / 7) * 100}% - 6px)`, top, ['--hue' as any]: oppHue(oppIndex[e.oppId] ?? 0) }}
                        onPointerDown={(ev) => startDrag(ev, e, selected ? 'move' : 'tap')}>
                        <span className="dp-ic" aria-hidden>{KIND_ICON[e.kind]}</span><span className="dp-tx">{e.title}</span>{statusMark(e)}
                        {showL && <span className="dp-handle l" onPointerDown={(ev) => startDrag(ev, e, 'start')} />}
                        {showR && <span className="dp-handle r" onPointerDown={(ev) => startDrag(ev, e, 'end')} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderWeek() {
    const days = weekDays(cursor); const a = days[0], b = days[6];
    const laneHW = 28, padW = 8, bandH = Math.max(150, padW + opps.length * laneHW);
    const dblNew = (ev: React.MouseEvent, half: Half) => { const r = (ev.currentTarget as HTMLElement).getBoundingClientRect(); const day = Math.max(0, Math.min(6, Math.floor((ev.clientX - r.left) / (r.width / 7)))); openCreate(addDays(a, day), half); };
    return (
      <div className="dp-cal" onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.dp-bar')) setSel(null); }}>
        <div className="dp-wk">
          <div className="dp-wk-head">
            <div className="dp-wk-corner" />
            {days.map((ds) => { const d = D(ds); const we = d.getDay() === 0 || d.getDay() === 6;
              return <div key={ds} className={`dp-wk-wh${we ? ' we' : ''}`}><div className="dow">周{WEEK_CN[dowMon(d)]}</div><div className={`dn${ds === TODAY ? ' today' : ''}`}>{d.getDate()}</div></div>; })}
          </div>
          {HALVES.map((hf) => {
            const lab = hf.id === 'am' ? '上午' : hf.id === 'pm' ? '下午' : '晚上';
            return (
              <div className="dp-wk-band" key={hf.id}>
                <div className="dp-wk-axis">{lab}</div>
                <div className="dp-wk-track" data-track data-half={hf.id} style={{ minHeight: bandH }} onDoubleClick={(ev) => { if (!(ev.target as HTMLElement).closest('.dp-bar')) dblNew(ev, hf.id); }}>
                  <div className="dp-wk-grid">{days.map((ds) => <div key={ds} className={D(ds).getDay() === 0 || D(ds).getDay() === 6 ? 'we' : ''} />)}</div>
                  {TODAY >= a && TODAY <= b && <div className="dp-wk-today" style={{ left: `${(diffDays(a, TODAY) + 0.5) / 7 * 100}%` }} />}
                  {visEvents.filter((e) => (e.half || 'am') === hf.id).map((e) => {
                    const [es, ee] = dispEv(e);
                    if (ee < a || es > b) return null;
                    const segS = es < a ? a : es, segE = ee > b ? b : ee;
                    const col = diffDays(a, segS), span = diffDays(segS, segE) + 1, top = padW / 2 + (laneOf[e.oppId] ?? 0) * laneHW;
                    const selected = sel === e.id, showL = selected && EDITABLE(e.kind) && es >= a, showR = selected && EDITABLE(e.kind) && ee <= b;
                    return (
                      <div key={e.id} className={`dp-bar k-${e.kind}${e.done ? ' done' : ''}${selected ? ' sel' : ''}`} title={e.title}
                        style={{ left: `calc(${col / 7 * 100}% + 3px)`, width: `calc(${span / 7 * 100}% - 6px)`, top, ['--hue' as any]: oppHue(oppIndex[e.oppId] ?? 0) }}
                        onPointerDown={(ev) => startDrag(ev, e, selected ? 'move' : 'tap')}>
                        <span className="dp-ic" aria-hidden>{KIND_ICON[e.kind]}</span><span className="dp-tx">{e.title}</span>{statusMark(e)}
                        {showL && <span className="dp-handle l" onPointerDown={(ev) => startDrag(ev, e, 'start')} />}
                        {showR && <span className="dp-handle r" onPointerDown={(ev) => startDrag(ev, e, 'end')} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }
  function renderYear() {
    return (
      <div className="dp-cal dp-year">
        <div className="dp-yr-grid">
          {Array.from({ length: 12 }, (_, m) => {
            const { weeks } = monthWeeks(`${y}-${p2(m + 1)}-01`);
            const cnt = visEvents.filter((e) => e.start.startsWith(`${y}-${p2(m + 1)}`)).length;
            return (
              <div className="dp-ym" key={m}>
                <div className="dp-ym-t">{m + 1}月 {cnt > 0 && <span className="cnt">{cnt}事项</span>}</div>
                <div className="dp-ym-mat" style={{ gridTemplateColumns: `38px repeat(${weeks.length}, 1fr)` }}>
                  <div />
                  {weeks.map((_, i) => <div className="dp-ym-hd" key={i}>W{i + 1}</div>)}
                  {visOpps.map((o) => {
                    let prevK: number | null = null;
                    return (
                      <Fragment key={o.id}>
                        <div className="dp-ym-name" title={o.name}><span className="dp-lg-bar" style={{ background: `hsl(${oppHue(oppIndex[o.id] ?? 0)} 70% 48%)` }} />{o.name.slice(0, 4)}</div>
                        {weeks.map((wk, wi) => {
                          const rep = wk.find((ds) => D(ds).getMonth() === m) || wk[3];
                          const seg = stageOfDay(o.id, rep);
                          const wEvs = visEvents.filter((e) => e.oppId === o.id && e.end >= wk[0] && e.start <= wk[6]);
                          const icons = wEvs.slice(0, 4).map((e) => <span key={e.id} title={e.title} onClick={(ev) => { ev.stopPropagation(); openEdit(e); }}>{KIND_ICON[e.kind]}</span>);
                          if (seg) {
                            const label = seg.k === prevK ? '' : STAGES[seg.k]; prevK = seg.k;
                            return <div className="dp-ym-cell" key={wi} style={{ background: stageColor(oppHue(oppIndex[o.id] ?? 0), seg.k), color: stageInk(seg.k) }} title={STAGES[seg.k]} onClick={() => openStageEdit(o.id, seg.id)} onDoubleClick={() => openStageCreate(o.id, wk[0], wk[6])}><div className="stg">{label}</div><div className="evs">{icons}</div></div>;
                          }
                          prevK = null;
                          return <div className="dp-ym-cell empty" key={wi} onDoubleClick={() => openStageCreate(o.id, wk[0], wk[6])}><div className="stg">＋阶段</div><div className="evs">{icons}</div></div>;
                        })}
                      </Fragment>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="dp-root">
      <header className="module-top">
        <ViewTabs view={view} onChange={onChangeView} />
        <span className="mt-account">{account.name}</span>
        <div className="dp-vtabs">
          {CAL_VIEWS.map((v) => <button key={v.id} className={`dp-vtab${calView === v.id ? ' active' : ''}`} onClick={() => { setSel(null); setCalView(v.id); }}>{v.label}</button>)}
        </div>
        <div className="dp-nav"><button onClick={() => shift(-1)} aria-label="上一页">‹</button><button className="dp-today" onClick={goToday}>今天</button><button onClick={() => shift(1)} aria-label="下一页">›</button></div>
        <div className="dp-period">{periodTitle}</div>
        <span className="dp-hint">{calView === 'month' ? '双击空白新增 · 单击选中拖锚点改期 · 再点编辑' : calView === 'week' ? '上午/下午/晚上分带' : '双击格新建阶段段'}</span>
        <button className="theme-toggle mt-theme" onClick={onToggleTheme} title={theme === 'dark' ? '切换到白天模式' : '切换到黑夜模式'}>{theme === 'dark' ? '☀️' : '🌙'}</button>
      </header>

      <div className="dp-body">
        <aside className="dp-left">
          <h4>事件三类 · 显示/隐藏</h4>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <div key={k} className={`dp-lg${hideKind.has(k) ? ' off' : ''}`}>
              <span className="dp-lg-ic">{KIND_ICON[k]}</span><span className="dp-lg-name">{KIND_LABEL[k]}</span>
              <button className="dp-eye" onClick={() => setHideKind((s) => tog(s, k))} aria-label={hideKind.has(k) ? '显示' : '隐藏'}><EyeIcon off={hideKind.has(k)} /></button>
            </div>
          ))}
          <h4>商机泳道 · 显示/隐藏</h4>
          {opps.length === 0 && <div className="dp-empty-hint">该客户还没有商机</div>}
          {opps.map((o, i) => (
            <div key={o.id} className={`dp-lg${hideOpp.has(o.id) ? ' off' : ''}`}>
              <span className="dp-lg-bar" style={{ background: `hsl(${oppHue(i)} 70% 48%)` }} /><span className="dp-lg-name">{o.name}</span>
              <button className="dp-eye" onClick={() => setHideOpp((s) => tog(s, o.id))} aria-label={hideOpp.has(o.id) ? '显示' : '隐藏'}><EyeIcon off={hideOpp.has(o.id)} /></button>
            </div>
          ))}
          <h4>行动事项 · 点选编辑</h4>
          {events.filter((e) => e.kind === 'action').length === 0 && <div className="dp-empty-hint">暂无行动，双击日历新增或从策略沙盘派发</div>}
          {events.filter((e) => e.kind === 'action').map((e) => (
            <div key={e.id} className={`dp-action-item${sel === e.id ? ' active' : ''}${e.done ? ' done' : ''}`} onClick={() => openEdit(e)}>
              <span className="dp-ai-dot" style={{ background: `hsl(${oppHue(oppIndex[e.oppId] ?? 0)} 70% 48%)` }} />
              <span className="dp-ai-name">{e.title}</span>
              <span className="dp-ai-date">{(e.start || '').slice(5)}</span>
            </div>
          ))}
        </aside>

        {calView === 'month' ? renderMonth() : calView === 'week' ? renderWeek() : renderYear()}

        <aside className="dp-right">
          {editor ? (
            <div className="dp-editor">
              <div className="dp-ed-head">{editor.mode === 'create' ? '新增事件' : '编辑事件'}</div>
              <div className="dp-fld"><span>事件类型</span>
                <div className="dp-pick">{(['action', 'milestone'] as Kind[]).map((k) => <button key={k} className={editor.kind === k ? 'on' : ''} disabled={editor.mode === 'edit'} onClick={() => setEditor({ ...editor, kind: k })}>{KIND_ICON[k]} {KIND_LABEL[k]}</button>)}</div>
              </div>
              <div className="dp-fld"><span>所属商机</span><select value={editor.oppId} onChange={(e) => setEditor({ ...editor, oppId: e.target.value })}>{opps.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
              <div className="dp-fld"><span>标题</span><input value={editor.title} placeholder={editor.kind === 'action' ? '如：拜访钱大钧·摸招标参数' : '如：开标 / 立项评审'} onChange={(e) => setEditor({ ...editor, title: e.target.value })} /></div>
              <div className="dp-row2"><div className="dp-fld"><span>开始</span><input type="date" value={editor.start} onChange={(e) => setEditor({ ...editor, start: e.target.value })} /></div><div className="dp-fld"><span>结束</span><input type="date" value={editor.end} onChange={(e) => setEditor({ ...editor, end: e.target.value })} /></div></div>
              <div className="dp-fld"><span>时段</span><div className="dp-pick">{HALVES.map((h) => <button key={h.id} className={editor.half === h.id ? 'on' : ''} onClick={() => setEditor({ ...editor, half: h.id })}>{h.label}</button>)}</div></div>
              {editor.kind === 'action' && <label className="dp-done"><input type="checkbox" checked={editor.done} onChange={(e) => setEditor({ ...editor, done: e.target.checked })} /> 标记为已完成（仅行动）</label>}
              <div className="dp-ed-foot">
                {editor.mode === 'edit' && <button className="dp-del" onClick={delEditor}>🗑 删除</button>}
                <button className="dp-btn ghost" onClick={() => { setEditor(null); setSel(null); }}>取消</button>
                <button className="dp-btn primary" onClick={saveEditor}>保存</button>
              </div>
            </div>
          ) : (
            <div className="dp-ed-empty">
              <div className="dp-ed-empty-ic">🗓️</div>
              <div>双击日历空白处<b>新增</b>事件<br />或点击事件<b>编辑</b></div>
              <div className="dp-tip">事件颜色 = <b>所属商机色系</b>，类型靠形态区分（行动实心条 / 里程碑描边 / 触点虚线）。触点来自拜访记录、只读叠加。</div>
            </div>
          )}
        </aside>
      </div>
      {stageModal && (
        <div className="dp-modal-mask" onClick={() => setStageModal(null)}>
          <div className="dp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="dp-ed-head">{stageModal.mode === 'create' ? '新建阶段段（可降级回退）' : '编辑阶段段'}</div>
            <div className="dp-fld"><span>商机</span><input value={opps.find((o) => o.id === stageModal.oid)?.name || ''} disabled /></div>
            <div className="dp-fld"><span>阶段（可重复，用于降级回退）</span><select value={stageModal.k} onChange={(e) => setStageModal({ ...stageModal, k: +e.target.value })}>{STAGES.map((s, i) => <option key={i} value={i}>{i + 1}. {s}</option>)}</select></div>
            <div className="dp-row2"><div className="dp-fld"><span>开始</span><input type="date" value={stageModal.start} onChange={(e) => setStageModal({ ...stageModal, start: e.target.value })} /></div><div className="dp-fld"><span>结束</span><input type="date" value={stageModal.end} onChange={(e) => setStageModal({ ...stageModal, end: e.target.value })} /></div></div>
            <div className="dp-ed-foot">{stageModal.mode === 'edit' && <button className="dp-del" onClick={delStage}>🗑 删除此段</button>}<button className="dp-btn ghost" onClick={() => setStageModal(null)}>取消</button><button className="dp-btn primary" onClick={saveStage}>保存</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
