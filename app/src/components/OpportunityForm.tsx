import { useEffect, useRef, useState } from 'react';
import type { Opportunity, PipelineStage, OpportunityStatus, CompetitiveSituation } from '../types';
import { PIPELINE_STAGES } from '../types';
import type { OpportunityRepairPatch } from '../api';
import { Modal } from './Modal';
import type { MutationCoordinator } from '../lib/sync/mutationCoordinator';
import { SyncStatus } from './SyncStatus';

export function toOpportunityRepairPatch(value: Opportunity, original: Opportunity): OpportunityRepairPatch {
  const patch: OpportunityRepairPatch = { baseVersion: original.version ?? 0 };
  if (value.name !== original.name) patch.name = value.name;
  if (value.pipelineStage !== original.pipelineStage) patch.pipelineStage = value.pipelineStage;
  if ((value.status ?? 'active') !== (original.status ?? 'active')) patch.status = value.status ?? 'active';
  if ((value.expectedAmountW ?? 0) !== (original.expectedAmountW ?? 0)) patch.expectedAmountW = value.expectedAmountW ?? 0;
  if ((value.expectedSignDate ?? '') !== (original.expectedSignDate ?? '')) patch.expectedSignDate = value.expectedSignDate ?? '';
  if (value.singleSalesGoal !== original.singleSalesGoal) patch.singleSalesGoal = value.singleSalesGoal;
  if ((value.competitiveSituation ?? '') !== (original.competitiveSituation ?? '')) patch.competitiveSituation = value.competitiveSituation ?? '';
  return patch;
}

export function repairFailureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : '商机纠错保存失败';
}

export function reconcileOpportunityDraft(
  current: Opportunity,
  incoming: Opportunity,
  baseline: Opportunity,
  dirty: boolean,
  openId: string,
): { draft: Opportunity; baseline: Opportunity; dirty: boolean; openId: string } {
  if (openId !== incoming.id || !dirty || JSON.stringify(current) === JSON.stringify(incoming)) {
    return { draft: incoming, baseline: incoming, dirty: false, openId: incoming.id };
  }
  return { draft: current, baseline, dirty: true, openId };
}

export function OpportunityForm({
  opp, onSave, onClose, coordinator, onViewCloud,
}: {
  opp: Opportunity;
  onSave: (patch: OpportunityRepairPatch) => void | Promise<void>;
  onClose: () => void;
  coordinator?: MutationCoordinator;
  onViewCloud?: () => void | Promise<void>;
}) {
  const [f, setF] = useState<Opportunity>(opp);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const dirty = useRef(false);
  const oppId = useRef(opp.id);
  const baseline = useRef(opp);
  useEffect(() => setF((current) => {
    const next = reconcileOpportunityDraft(current, opp, baseline.current, dirty.current, oppId.current);
    oppId.current = next.openId;
    dirty.current = next.dirty;
    baseline.current = next.baseline;
    return next.draft;
  }), [opp]);
  const set = (patch: Partial<Opportunity>) => { dirty.current = true; setF((current) => ({ ...current, ...patch })); };
  const viewCloud = async () => { await onViewCloud?.(); dirty.current = false; };
  const save = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const patch = toOpportunityRepairPatch(f, baseline.current);
      if (Object.keys(patch).length === 1) {
        setSaveError('未检测到需要保存的修正');
        return;
      }
      await onSave(patch);
      onClose();
    } catch (cause) {
      setSaveError(repairFailureMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="编辑商机关键字段" width={560} onClose={onClose}
      footer={<>
        <button className="btn ghost" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </>}>
      {coordinator && <SyncStatus coordinator={coordinator} entityKey={`opportunity:${opp.id}`} onViewCloud={viewCloud} />}
      {saveError && <div role="alert" style={{ color: 'var(--accent-ink)', marginBottom: 10 }}>{saveError}</div>}
      <div className="empty-hint" style={{ marginBottom: 12 }}>仅开放内部纠错必要字段，保存会写入审计记录。</div>
      <label className="fld"><span>商机名称</span>
        <input value={f.name} onChange={(event) => set({ name: event.target.value })} /></label>
      <div className="fld-row">
        <label className="fld"><span>商机阶段</span>
          <select value={f.pipelineStage} onChange={(event) => set({ pipelineStage: event.target.value as PipelineStage })}>
            {PIPELINE_STAGES.map((stage) => <option key={stage}>{stage}</option>)}
          </select></label>
        <label className="fld"><span>商机状态</span>
          <select value={f.status ?? 'active'} onChange={(event) => set({ status: event.target.value as OpportunityStatus })}>
            <option value="active">进行中</option><option value="paused">暂停</option><option value="won">赢单</option><option value="lost">丢单</option>
          </select></label>
      </div>
      <label className="fld"><span>单一销售目标</span>
        <textarea value={f.singleSalesGoal} onChange={(event) => set({ singleSalesGoal: event.target.value })} rows={2} /></label>
      <label className="fld"><span>竞争态势</span>
        <select value={f.competitiveSituation ?? ''} onChange={(event) => set({ competitiveSituation: event.target.value as CompetitiveSituation })}>
          <option value="">未识别</option><option value="领先">领先</option><option value="胶着">胶着</option><option value="落后">落后</option>
        </select></label>
      <div className="fld-row">
        <label className="fld"><span>预计签约日</span>
          <input type="date" value={f.expectedSignDate ?? ''} onChange={(event) => set({ expectedSignDate: event.target.value })} /></label>
        <label className="fld"><span>预计金额（万元）</span>
          <input type="number" min={0} value={f.expectedAmountW ?? ''}
            onChange={(event) => set({ expectedAmountW: event.target.value === '' ? 0 : Number(event.target.value) })} /></label>
      </div>
    </Modal>
  );
}
