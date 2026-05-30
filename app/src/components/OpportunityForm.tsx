import { useState } from 'react';
import type { Opportunity, PipelineStage, EngageStage, ChangeMode } from '../types';
import { PIPELINE_STAGES, ENGAGE_STAGES, CHANGE_MODES, C3_ITEMS, C5_ITEMS } from '../types';
import { Modal } from './Modal';

export function OpportunityForm({
  opp, onSave, onClose,
}: {
  opp: Opportunity;
  onSave: (patch: Partial<Opportunity>) => void;
  onClose: () => void;
}) {
  const [f, setF] = useState<Opportunity>(opp);
  const set = (patch: Partial<Opportunity>) => setF((p) => ({ ...p, ...patch }));
  const toggleC3 = (k: string) => set({ c3Items: { ...f.c3Items, [k]: !f.c3Items[k] } });
  const toggleC5 = (k: string) => set({ c5Items: { ...f.c5Items, [k]: !f.c5Items[k] } });

  return (
    <Modal title="编辑商机" width={560} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" onClick={() => { onSave(f); onClose(); }}>保存</button>
      </>}>
      <label className="fld"><span>商机名称</span>
        <input value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>

      <div className="fld-row">
        <label className="fld"><span>商机阶段（管线）</span>
          <select value={f.pipelineStage} onChange={(e) => set({ pipelineStage: e.target.value as PipelineStage })}>
            {PIPELINE_STAGES.map((s) => <option key={s}>{s}</option>)}
          </select></label>
        <label className="fld"><span>介入阶段（C4 · 越早越高）</span>
          <select value={f.engageStage} onChange={(e) => set({ engageStage: e.target.value as EngageStage })}>
            {ENGAGE_STAGES.map((s, i) => <option key={s} value={s}>{s}（{5 - i}分）</option>)}
          </select></label>
      </div>

      <label className="fld"><span>客户变化模式</span>
        <select value={f.changeMode ?? ''} onChange={(e) => set({ changeMode: (e.target.value || undefined) as ChangeMode })}>
          <option value="">未判断</option>
          {CHANGE_MODES.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
        </select></label>

      <label className="fld"><span>单一销售目标（第一问）</span>
        <textarea value={f.singleSalesGoal} onChange={(e) => set({ singleSalesGoal: e.target.value })} rows={2}
          placeholder="本项目要赢得的明确目标" /></label>
      <div className="fld-row">
        <label className="fld"><span>客户业务目标</span>
          <input value={f.customerBusinessGoal ?? ''} onChange={(e) => set({ customerBusinessGoal: e.target.value })} /></label>
        <label className="fld"><span>购买动机</span>
          <input value={f.buyingMotivation ?? ''} onChange={(e) => set({ buyingMotivation: e.target.value })} /></label>
      </div>

      <div className="check-block">
        <div className="check-title">C3 立项材料 7 项（已掌握打勾）</div>
        <div className="check-grid">
          {C3_ITEMS.map((k) => (
            <label key={k} className={`chk${f.c3Items[k] ? ' on' : ''}`}>
              <input type="checkbox" checked={!!f.c3Items[k]} onChange={() => toggleC3(k)} />{k}
            </label>
          ))}
        </div>
      </div>
      <div className="check-block">
        <div className="check-title">C5 招采事项 5 项（已掌握打勾）</div>
        <div className="check-grid">
          {C5_ITEMS.map((k) => (
            <label key={k} className={`chk${f.c5Items[k] ? ' on' : ''}`}>
              <input type="checkbox" checked={!!f.c5Items[k]} onChange={() => toggleC5(k)} />{k}
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
