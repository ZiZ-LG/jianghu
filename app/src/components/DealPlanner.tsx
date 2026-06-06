// 商机策划 · 行动排期日历（V1 月视图）。关系地图的孪生镜头：把行动/里程碑/触点排到日历上。
// 交互移植自 docs/商机策划-原型.html：双击空白新增 · 单击选中出锚点 · 拖锚点/条身改期(可跨周) · 再点开抽屉 · 完成态 · 右栏显隐。
// 拖拽中用本地 preview 覆盖显示，pointerup 才 dispatch 一次（不每帧打云端）。触点(VisitNote)按 V1 只读叠加。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Account, Half } from '../types';
import type { Action } from '../store';
import { newPlanAction, newMilestone } from '../store';

// ── 日期工具（YYYY-MM-DD 全程字符串）──
const p2 = (n: number) => String(n).padStart(2, '0');
const D = (s: string) => new Date(s + 'T00:00:00');
const ymd = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const addDays = (s: string, n: number) => { const d = D(s); d.setDate(d.getDate() + n); return ymd(d); };
const diffDays = (a: string, b: string) => Math.round((D(b).getTime() - D(a).getTime()) / 864e5);
const dowMon = (d: Date) => (d.getDay() + 6) % 7; // 周一=0
const WEEK_CN = ['一', '二', '三', '四', '五', '六', '日'];

type Kind = 'action' | 'milestone' | 'touch';
interface CalEvent { id: string; kind: Kind; oppId: string; start: string; end: string; half: Half; title: string; done?: boolean; }

const KIND_ICON: Record<Kind, string> = { action: '🎯', milestone: '🚩', touch: '📌' };
const KIND_LABEL: Record<Kind, string> = { action: '行动计划', milestone: '里程碑', touch: '历史触点' };
const EDITABLE = (k: Kind) => k === 'action' || k === 'milestone'; // 触点只读叠加

// 商机色系：≤4 直接取 4 hue，第 5 个起循环复用（§11-3）
const OPP_HUES = [217, 28, 145, 275, 340, 190];
const oppHue = (i: number) => OPP_HUES[((i % OPP_HUES.length) + OPP_HUES.length) % OPP_HUES.length];

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

const HALVES: { id: Half; label: string }[] = [{ id: 'am', label: '🌅 上午' }, { id: 'pm', label: '🌇 下午' }, { id: 'eve', label: '🌙 晚上' }];

interface DrawerState {
  mode: 'create' | 'edit'; kind: Kind; editId?: string;
  oppId: string; title: string; start: string; end: string; half: Half; done: boolean;
}

const laneH = 22, headH = 24, padB = 6;

export function DealPlanner({ account, dispatch }: { account: Account; dispatch: (a: Action) => void }) {
  const [TODAY] = useState(() => ymd(new Date()));
  const [cursor, setCursor] = useState(() => TODAY.slice(0, 8) + '01'); // 当月 1 号
  const [sel, setSel] = useState<string | null>(null);
  const [hideKind, setHideKind] = useState<Set<Kind>>(() => new Set());
  const [hideOpp, setHideOpp] = useState<Set<string>>(() => new Set());
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [preview, setPreview] = useState<{ id: string; start: string; end: string } | null>(null);

  const opps = account.opportunities;
  const oppIndex = useMemo(() => { const m: Record<string, number> = {}; opps.forEach((o, i) => (m[o.id] = i)); return m; }, [opps]);

  // 聚合三类事件
  const events = useMemo<CalEvent[]>(() => {
    const out: CalEvent[] = [];
    for (const a of account.planActions ?? []) out.push({ id: a.id, kind: 'action', oppId: a.opportunityId, start: a.startDate, end: a.endDate || a.startDate, half: a.half, title: a.title || '(未命名行动)', done: a.done });
    for (const m of account.milestones ?? []) out.push({ id: m.id, kind: 'milestone', oppId: m.opportunityId, start: m.startDate, end: m.endDate || m.startDate, half: m.half, title: m.title || '(未命名里程碑)' });
    for (const v of account.visitNotes ?? []) if (v.opportunityId && v.date) out.push({ id: v.id, kind: 'touch', oppId: v.opportunityId, start: v.date, end: v.date, half: 'pm', title: v.topic || (v.summary ? v.summary.slice(0, 18) : '触点') });
    return out.filter((e) => e.start);
  }, [account.planActions, account.milestones, account.visitNotes]);

  const visOpps = opps.filter((o) => !hideOpp.has(o.id));
  const laneOf: Record<string, number> = {}; visOpps.forEach((o, i) => (laneOf[o.id] = i));
  const visEvents = events.filter((e) => !hideKind.has(e.kind) && !hideOpp.has(e.oppId) && e.oppId in laneOf);
  const dispEv = (e: CalEvent): [string, string] => (preview && preview.id === e.id ? [preview.start, preview.end] : [e.start, e.end]);

  const { weeks, mo, y } = monthWeeks(cursor);

  // ── 提交改期 / 选中 / 抽屉（用 ref 给 window 监听读最新值）──
  const commitDates = (e: CalEvent, start: string, end: string) => {
    if (e.kind === 'action') dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId: e.id, patch: { startDate: start, endDate: end } });
    else if (e.kind === 'milestone') dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId: e.id, patch: { startDate: start, endDate: end } });
  };
  const clickEvent = (id: string) => {
    const e = events.find((x) => x.id === id); if (!e) return;
    if (!EDITABLE(e.kind)) { setSel((s) => (s === id ? null : id)); return; } // 触点只高亮
    if (sel === id) openEdit(e); else setSel(id);
  };
  const apiRef = useRef({ events, commitDates, clickEvent });
  apiRef.current = { events, commitDates, clickEvent };

  // ── 拖拽（pointerdown 起、window 跟踪、up 提交）──
  type Drag = { id: string; mode: 'move' | 'start' | 'end' | 'tap'; dayPx: number; x0: number; oStart: string; oEnd: string; moved: boolean; curStart: string; curEnd: string };
  const dragRef = useRef<Drag | null>(null);
  useEffect(() => {
    const onMove = (ev: PointerEvent) => {
      const dg = dragRef.current; if (!dg) return;
      const dpx = ev.clientX - dg.x0; if (Math.abs(dpx) > 4) dg.moved = true;
      if (!dg.moved || dg.mode === 'tap') return; // tap=未选中：只选不改期
      const dd = Math.round(dpx / dg.dayPx);
      let s = dg.oStart, e = dg.oEnd;
      if (dg.mode === 'move') { s = addDays(s, dd); e = addDays(e, dd); }
      else if (dg.mode === 'start') { s = addDays(s, dd); if (s > e) s = e; }
      else { e = addDays(e, dd); if (e < s) e = s; }
      dg.curStart = s; dg.curEnd = e;
      setPreview({ id: dg.id, start: s, end: e });
    };
    const onUp = () => {
      const dg = dragRef.current; if (!dg) return;
      dragRef.current = null; setPreview(null);
      const { events: evs, commitDates: commit, clickEvent: click } = apiRef.current;
      if (dg.moved && dg.mode !== 'tap') { const e = evs.find((x) => x.id === dg.id); if (e && EDITABLE(e.kind)) commit(e, dg.curStart, dg.curEnd); }
      else if (!dg.moved) click(dg.id); // 未移动=单击：选中 / 再点开抽屉
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  }, []);

  const startDrag = (ev: React.PointerEvent, e: CalEvent, mode: 'move' | 'start' | 'end' | 'tap') => {
    ev.preventDefault(); ev.stopPropagation();
    const realMode: Drag['mode'] = EDITABLE(e.kind) ? mode : 'tap'; // 触点只读：只能选中，不改期
    const bars = (ev.currentTarget as HTMLElement).closest('.dp-bars') as HTMLElement | null;
    const dayPx = bars ? bars.clientWidth / 7 : 90;
    const [s, en] = dispEv(e);
    dragRef.current = { id: e.id, mode: realMode, dayPx, x0: ev.clientX, oStart: s, oEnd: en, moved: false, curStart: s, curEnd: en };
  };

  // ── 抽屉 ──
  const openCreate = (date: string) => { setSel(null); setDrawer({ mode: 'create', kind: 'action', oppId: visOpps[0]?.id ?? opps[0]?.id ?? '', title: '', start: date, end: date, half: 'am', done: false }); };
  const openEdit = (e: CalEvent) => { const [s, en] = dispEv(e); setDrawer({ mode: 'edit', kind: e.kind, editId: e.id, oppId: e.oppId, title: e.title.startsWith('(') ? '' : e.title, start: s, end: en, half: e.half, done: !!e.done }); };
  const closeDrawer = () => setDrawer(null);
  const saveDrawer = () => {
    if (!drawer) return;
    const d = drawer; const start = d.start || TODAY; const end = d.end && d.end >= start ? d.end : start;
    const title = d.title.trim() || (d.kind === 'action' ? '新行动' : '新里程碑');
    if (d.mode === 'create') {
      if (d.kind === 'action') { const a = { ...newPlanAction(account.id, d.oppId, start, end, d.half), title, done: d.done, doneAt: d.done ? TODAY : undefined }; dispatch({ type: 'ADD_PLAN_ACTION', accId: account.id, oppId: d.oppId, planAction: a }); }
      else { const m = { ...newMilestone(account.id, d.oppId, start, d.half), title, endDate: end }; dispatch({ type: 'ADD_MILESTONE', accId: account.id, oppId: d.oppId, milestone: m }); }
    } else if (d.editId) {
      if (d.kind === 'action') dispatch({ type: 'UPDATE_PLAN_ACTION', accId: account.id, actionId: d.editId, patch: { title, startDate: start, endDate: end, half: d.half, done: d.done, doneAt: d.done ? TODAY : undefined } });
      else dispatch({ type: 'UPDATE_MILESTONE', accId: account.id, milestoneId: d.editId, patch: { title, startDate: start, endDate: end, half: d.half } });
    }
    closeDrawer();
  };
  const delDrawer = () => {
    if (!drawer?.editId) return;
    if (drawer.kind === 'action') dispatch({ type: 'DELETE_PLAN_ACTION', accId: account.id, actionId: drawer.editId });
    else if (drawer.kind === 'milestone') dispatch({ type: 'DELETE_MILESTONE', accId: account.id, milestoneId: drawer.editId });
    setSel(null); closeDrawer();
  };

  const shift = (dir: number) => { setSel(null); setCursor(ymd(new Date(y, mo + dir, 1))); };
  const goToday = () => { setSel(null); setCursor(TODAY.slice(0, 8) + '01'); };
  const tog = <T,>(set: Set<T>, k: T) => { const n = new Set(set); n.has(k) ? n.delete(k) : n.add(k); return n; };

  const bodyH = headH + opps.length * laneH + padB;
  const statusMark = (e: CalEvent) => { if (e.kind !== 'action') return null; if (e.done) return <span className="dp-ok">✓</span>; if (e.end < TODAY) return <span className="dp-late">✕</span>; return null; };

  return (
    <div className="dp-root">
      <div className="dp-head">
        <div className="dp-nav"><button onClick={() => shift(-1)} aria-label="上个月">‹</button><button onClick={() => shift(1)} aria-label="下个月">›</button></div>
        <button className="dp-today" onClick={goToday}>今天</button>
        <div className="dp-period">{y}年{mo + 1}月</div>
        <span className="dp-hint">双击空白新增 · 单击选中拖锚点改期 · 再点开详情</span>
      </div>

      <div className="dp-body">
        <div className="dp-cal" onPointerDown={(e) => { if (!(e.target as HTMLElement).closest('.dp-bar')) setSel(null); }}>
          <div className="dp-dow">{WEEK_CN.map((w, i) => <div key={w} className={i >= 5 ? 'we' : ''}>周{w}</div>)}</div>
          <div className="dp-weeks">
            {weeks.map((wk) => {
              const wStart = wk[0], wEnd = wk[6];
              return (
                <div className="dp-week" key={wStart} style={{ minHeight: bodyH }}>
                  <div className="dp-cells">
                    {wk.map((ds) => { const d = D(ds); const out = d.getMonth() !== mo; const we = d.getDay() === 0 || d.getDay() === 6;
                      return (
                        <div key={ds} className={`dp-cell${out ? ' out' : ''}${we ? ' we' : ''}`} onDoubleClick={() => openCreate(ds)}>
                          <div className={`dp-dnum${ds === TODAY ? ' today' : ''}`}>{d.getDate()}</div>
                        </div>
                      ); })}
                  </div>
                  <div className="dp-bars" style={{ height: bodyH }}>
                    {visEvents.map((e) => {
                      const [es, ee] = dispEv(e);
                      if (ee < wStart || es > wEnd) return null;
                      const segS = es < wStart ? wStart : es, segE = ee > wEnd ? wEnd : ee;
                      const col = diffDays(wStart, segS), span = diffDays(segS, segE) + 1, top = headH + (laneOf[e.oppId] ?? 0) * laneH;
                      const hue = oppHue(oppIndex[e.oppId] ?? 0);
                      const selected = sel === e.id;
                      const cls = `dp-bar k-${e.kind}${e.done ? ' done' : ''}${selected ? ' sel' : ''}`;
                      const showL = selected && EDITABLE(e.kind) && es >= wStart, showR = selected && EDITABLE(e.kind) && ee <= wEnd;
                      return (
                        <div key={e.id} className={cls} title={e.title}
                          style={{ left: `calc(${(col / 7) * 100}% + 3px)`, width: `calc(${(span / 7) * 100}% - 6px)`, top, ['--hue' as any]: hue }}
                          onPointerDown={(ev) => startDrag(ev, e, selected ? 'move' : 'tap')}>
                          <span className="dp-ic" aria-hidden>{KIND_ICON[e.kind]}</span>
                          <span className="dp-tx">{e.title}</span>
                          {statusMark(e)}
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

        <aside className="dp-side">
          <h4>事件三类 · 显示/隐藏</h4>
          {(Object.keys(KIND_LABEL) as Kind[]).map((k) => (
            <div key={k} className={`dp-lg${hideKind.has(k) ? ' off' : ''}`}>
              <span className="dp-lg-ic">{KIND_ICON[k]}</span>
              <span className="dp-lg-name">{KIND_LABEL[k]}</span>
              <button className="dp-eye" onClick={() => setHideKind((s) => tog(s, k))} aria-label={hideKind.has(k) ? '显示' : '隐藏'}>{hideKind.has(k) ? '🚫' : '👁'}</button>
            </div>
          ))}
          <h4>商机泳道 · 显示/隐藏</h4>
          {opps.length === 0 && <div className="dp-empty-hint">该客户还没有商机</div>}
          {opps.map((o, i) => (
            <div key={o.id} className={`dp-lg${hideOpp.has(o.id) ? ' off' : ''}`}>
              <span className="dp-lg-bar" style={{ background: `hsl(${oppHue(i)} 70% 48%)` }} />
              <span className="dp-lg-name">{o.name}</span>
              <button className="dp-eye" onClick={() => setHideOpp((s) => tog(s, o.id))} aria-label={hideOpp.has(o.id) ? '显示' : '隐藏'}>{hideOpp.has(o.id) ? '🚫' : '👁'}</button>
            </div>
          ))}
          <div className="dp-tip">事件颜色 = <b>所属商机色系</b>，类型靠<b>形态</b>区分（行动实心条 / 里程碑描边 / 触点虚线）。触点来自拜访记录、只读叠加。</div>
        </aside>
      </div>

      {drawer && (
        <>
          <div className="dp-mask" onClick={closeDrawer} />
          <div className="dp-drawer">
            <div className="dp-dw-head"><span>{drawer.mode === 'create' ? '新增事件' : '事件详情 · 编辑'}</span><button className="dp-x" onClick={closeDrawer} aria-label="关闭">×</button></div>
            <div className="dp-dw-body">
              <div className="dp-fld"><span>事件类型</span>
                <div className="dp-pick">
                  {(['action', 'milestone'] as Kind[]).map((k) => (
                    <button key={k} className={drawer.kind === k ? 'on' : ''} disabled={drawer.mode === 'edit'} onClick={() => setDrawer({ ...drawer, kind: k })}>{KIND_ICON[k]} {KIND_LABEL[k]}</button>
                  ))}
                </div>
              </div>
              <div className="dp-fld"><span>所属商机</span>
                <select value={drawer.oppId} onChange={(e) => setDrawer({ ...drawer, oppId: e.target.value })}>
                  {opps.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="dp-fld"><span>标题</span><input value={drawer.title} placeholder={drawer.kind === 'action' ? '如：拜访钱大钧·摸招标参数' : '如：开标 / 立项评审'} onChange={(e) => setDrawer({ ...drawer, title: e.target.value })} /></div>
              <div className="dp-row2">
                <div className="dp-fld"><span>开始</span><input type="date" value={drawer.start} onChange={(e) => setDrawer({ ...drawer, start: e.target.value })} /></div>
                <div className="dp-fld"><span>结束</span><input type="date" value={drawer.end} onChange={(e) => setDrawer({ ...drawer, end: e.target.value })} /></div>
              </div>
              <div className="dp-fld"><span>时段</span>
                <div className="dp-pick">{HALVES.map((h) => <button key={h.id} className={drawer.half === h.id ? 'on' : ''} onClick={() => setDrawer({ ...drawer, half: h.id })}>{h.label}</button>)}</div>
              </div>
              {drawer.kind === 'action' && (
                <label className="dp-done"><input type="checkbox" checked={drawer.done} onChange={(e) => setDrawer({ ...drawer, done: e.target.checked })} /> 标记为已完成（仅行动）</label>
              )}
            </div>
            <div className="dp-dw-foot">
              {drawer.mode === 'edit' && <button className="dp-del" onClick={delDrawer}>🗑 删除</button>}
              <button className="dp-btn ghost" onClick={closeDrawer}>取消</button>
              <button className="dp-btn primary" onClick={saveDrawer}>保存</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
