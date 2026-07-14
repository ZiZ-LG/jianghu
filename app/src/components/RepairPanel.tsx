import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, Note, Opportunity, VisitNote } from '../types';
import { CUSTOMER_TYPE_LABEL } from '../types';
import { api, newIdempotencyKey, type AccountRepairPatch, type PersonMergeDecision, type PersonMergePreview, type PersonMergeRoleDecision, type RepairContext } from '../api';
import { Modal } from './Modal';

export type RepairTarget =
  | { kind: 'account'; account: Account }
  | { kind: 'opportunity'; account: Account; opportunity: Opportunity }
  | { kind: 'visitNote'; record: VisitNote }
  | { kind: 'note'; record: Note };

function targetId(target: RepairTarget): string {
  if (target.kind === 'account') return target.account.id;
  if (target.kind === 'opportunity') return target.opportunity.id;
  return target.record.id;
}

const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : '暂无';

export function toAccountRepairPatch(account: Account, value: {
  name: string;
  customerType: 1 | 2 | 3 | 4;
  primaryOwnerUserId: string;
  ownerChanged: boolean;
}): AccountRepairPatch {
  const patch: AccountRepairPatch = {
    base: {
      name: account.name,
      customerType: account.customerType,
      primaryOwner: account.primaryOwner ?? '',
      primaryOwnerUserId: account.primaryOwnerUserId ?? null,
    },
  };
  const name = value.name.trim();
  if (name !== account.name) patch.name = name;
  if (value.customerType !== account.customerType) patch.customerType = value.customerType;
  if (value.ownerChanged) patch.primaryOwnerUserId = value.primaryOwnerUserId || null;
  return patch;
}

export async function completeCommittedRepair(
  onClose: () => void,
  onChanged: () => void | Promise<void>,
  onRefreshError: (message: string) => void,
): Promise<void> {
  onClose();
  try {
    await onChanged();
  } catch {
    onRefreshError('纠错已保存，但刷新失败；请稍后重新进入客户。');
  }
}

export async function submitPersonMergeOnce(
  lock: { current: boolean },
  submit: () => Promise<void>,
  afterCommit: () => Promise<void>,
): Promise<'committed' | 'ignored'> {
  if (lock.current) return 'ignored';
  lock.current = true;
  try {
    await submit();
    await afterCommit();
    return 'committed';
  } finally {
    lock.current = false;
  }
}

type StablePersonMergeKeyCache = { current: { signature: string; key: string } | null };

export function stablePersonMergeKey(
  cache: StablePersonMergeKeyCache,
  payload: PersonMergeDecision,
  createKey: () => string = newIdempotencyKey,
): string {
  const signature = JSON.stringify([
    payload.targetPersonId,
    payload.sourcePersonId,
    Object.entries(payload.roleConflictByOpportunity).sort(([left], [right]) => left.localeCompare(right)),
  ]);
  if (cache.current?.signature !== signature) cache.current = { signature, key: createKey() };
  return cache.current.key;
}

export function clearStablePersonMergeKey(cache: StablePersonMergeKeyCache): void {
  cache.current = null;
}

export function RepairPanel({ target, accounts, onClose, onChanged, onEditOpportunity, onRepairRecord, onRefreshError = () => undefined }: {
  target: RepairTarget;
  accounts: Account[];
  onClose: () => void;
  onChanged: () => void | Promise<void>;
  onEditOpportunity?: () => void;
  onRepairRecord?: (kind: 'visitNote' | 'note', id: string) => void;
  onRefreshError?: (message: string) => void;
}) {
  const [context, setContext] = useState<RepairContext | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const account = target.kind === 'account' ? target.account : undefined;
  const record = target.kind === 'visitNote' || target.kind === 'note' ? target.record : undefined;
  const [name, setName] = useState(account?.name ?? '');
  const [customerType, setCustomerType] = useState<1 | 2 | 3 | 4>(account?.customerType ?? 2);
  const [primaryOwnerUserId, setPrimaryOwnerUserId] = useState(account?.primaryOwnerUserId ?? '');
  const [ownerChanged, setOwnerChanged] = useState(false);
  const [members, setMembers] = useState<Array<{ id: string; name: string }>>([]);
  const [accountId, setAccountId] = useState(record?.accountId ?? accounts[0]?.id ?? '');
  const [opportunityId, setOpportunityId] = useState(record?.opportunityId ?? '');
  const mergePeople = account?.persons ?? [];
  const [mergeTargetId, setMergeTargetId] = useState(mergePeople[0]?.id ?? '');
  const [mergeSourceId, setMergeSourceId] = useState(mergePeople.find((person) => person.id !== mergePeople[0]?.id)?.id ?? '');
  const [mergePreview, setMergePreview] = useState<PersonMergePreview | null>(null);
  const [mergeDecisions, setMergeDecisions] = useState<Record<string, PersonMergeRoleDecision>>({});
  const mergeSubmitting = useRef(false);
  const mergeIdempotency = useRef<{ signature: string; key: string } | null>(null);
  const id = targetId(target);
  const loadContext = useCallback(async () => {
    setError('');
    try { setContext(await api.repairContext(target.kind, id)); }
    catch (cause: any) { setError(cause?.message || '溯源信息加载失败'); }
  }, [id, target.kind]);
  useEffect(() => { void loadContext(); }, [loadContext]);
  useEffect(() => {
    if (target.kind !== 'account') return;
    let alive = true;
    api.members()
      .then(({ members: loaded }) => { if (alive) setMembers(loaded.map(({ id, name }) => ({ id, name }))); })
      .catch((cause: any) => { if (alive) setError(cause?.message || '负责人列表加载失败'); });
    return () => { alive = false; };
  }, [target.kind]);
  useEffect(() => {
    if (target.kind !== 'account' || !mergeTargetId || !mergeSourceId || mergeTargetId === mergeSourceId) {
      setMergePreview(null);
      setMergeDecisions({});
      return;
    }
    let alive = true;
    setMergePreview(null);
    setMergeDecisions({});
    api.repairPersonMergePreview(mergeTargetId, mergeSourceId)
      .then((preview) => { if (alive) setMergePreview(preview); })
      .catch((cause: any) => { if (alive) setError(cause?.message || '人物合并预览失败'); });
    return () => { alive = false; };
  }, [mergeSourceId, mergeTargetId, target.kind]);
  const opportunities = accounts.find((item) => item.id === accountId)?.opportunities ?? [];
  useEffect(() => {
    if (opportunityId && !opportunities.some((item) => item.id === opportunityId)) setOpportunityId('');
  }, [opportunities, opportunityId]);

  const finish = async () => {
    await onChanged();
    await loadContext();
  };
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (target.kind === 'account') {
        const patch = toAccountRepairPatch(target.account, { name, customerType, primaryOwnerUserId, ownerChanged });
        if (Object.keys(patch).length === 1) {
          setError('未检测到需要保存的修正');
          return;
        }
        await api.repairAccount(target.account.id, patch);
        await completeCommittedRepair(onClose, onChanged, onRefreshError);
        return;
      } else if (target.kind === 'visitNote' || target.kind === 'note') {
        await api.repairRebind({ kind: target.kind, id: target.record.id, accountId, opportunityId: opportunityId || null });
      }
      await finish();
    } catch (cause: any) {
      setError(cause?.message || '纠错失败');
    } finally { setBusy(false); }
  };
  const archive = async () => {
    if (target.kind !== 'account' && target.kind !== 'opportunity') return;
    const entity = target.kind === 'account' ? target.account : target.opportunity;
    const reason = prompt(`归档「${entity.name}」？数据可由管理员恢复。\n\n请填写原因：`, '纠错撤回点');
    if (!reason?.trim()) return;
    setBusy(true); setError('');
    try {
      await api.archive(target.kind, entity.id, reason.trim());
      await onChanged();
      onClose();
    } catch (cause: any) { setError(cause?.message || '归档失败'); }
    finally { setBusy(false); }
  };
  const mergePerson = async () => {
    if (mergeSubmitting.current || !mergePreview || mergeTargetId === mergeSourceId) return;
    if (mergePreview.conflicts.some((conflict) => !mergeDecisions[conflict.opportunityId])) {
      setError('请先为每个角色冲突选择保留哪条记录');
      return;
    }
    setBusy(true); setError('');
    try {
      const decision: PersonMergeDecision = {
        targetPersonId: mergeTargetId,
        sourcePersonId: mergeSourceId,
        roleConflictByOpportunity: mergeDecisions,
      };
      const idempotencyKey = stablePersonMergeKey(mergeIdempotency, decision);
      await submitPersonMergeOnce(
        mergeSubmitting,
        async () => {
          await api.repairPersonMerge(decision, idempotencyKey);
          clearStablePersonMergeKey(mergeIdempotency);
        },
        () => completeCommittedRepair(onClose, onChanged, onRefreshError),
      );
    } catch (cause: any) {
      setError(cause?.message || '人物合并失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="🛠️ 纠错与溯源" width={600} onClose={onClose}
      footer={<>
        {(target.kind === 'account' || target.kind === 'opportunity') && <button className="btn ghost" disabled={busy} onClick={() => void archive()}>归档</button>}
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={onClose}>关闭</button>
        {(target.kind === 'account' || target.kind === 'visitNote' || target.kind === 'note') && <button className="btn primary" disabled={busy || !accountId && target.kind !== 'account'} onClick={() => void save()}>{busy ? '保存中…' : '保存修正'}</button>}
      </>}>
      {error && <div role="alert" style={{ color: 'var(--accent-ink)', marginBottom: 10 }}>{error}</div>}
      {target.kind === 'account' && <>
        <label className="fld"><span>客户名称</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="fld-row">
          <label className="fld"><span>客户类型</span><select value={customerType} onChange={(event) => setCustomerType(Number(event.target.value) as 1 | 2 | 3 | 4)}>{([1, 2, 3, 4] as const).map((value) => <option key={value} value={value}>{CUSTOMER_TYPE_LABEL[value]}</option>)}</select></label>
          <label className="fld"><span>负责人</span><select value={primaryOwnerUserId} onChange={(event) => { setPrimaryOwnerUserId(event.target.value); setOwnerChanged(true); }}>
            <option value="">未分配</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select></label>
        </div>
        {mergePeople.length >= 2 && <div style={{ marginTop: 14 }}>
          <div className="section-t">合并重复人物</div>
          <div className="empty-hint" style={{ marginBottom: 10 }}>方向不可逆：源人物会被归档，全部正式引用迁移到目标人物；每个角色冲突都必须明确选择。</div>
          <div className="fld-row">
            <label className="fld"><span>源人物（将归档）</span><select value={mergeSourceId} onChange={(event) => setMergeSourceId(event.target.value)}>
              {mergePeople.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.title}</option>)}
            </select></label>
            <label className="fld"><span>目标人物（保留）</span><select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)}>
              {mergePeople.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.title}</option>)}
            </select></label>
          </div>
          {mergeTargetId === mergeSourceId && <div role="alert" className="empty-hint">源人物和目标人物不能相同。</div>}
          {mergePreview?.conflicts.map((conflict) => <label className="fld" key={conflict.opportunityId}>
            <span>{conflict.opportunityName}{conflict.archived ? '（已归档商机）' : ''}：目标 {conflict.targetRole.role} / 源 {conflict.sourceRole.role}</span>
            <select value={mergeDecisions[conflict.opportunityId] ?? ''} onChange={(event) => setMergeDecisions((current) => ({ ...current, [conflict.opportunityId]: event.target.value as PersonMergeRoleDecision }))}>
              <option value="">请选择</option>
              <option value="keep_target">保留目标人物的完整角色记录</option>
              <option value="keep_source">保留源人物的完整角色记录并迁移</option>
            </select>
          </label>)}
          <button className="btn primary sm" disabled={busy || !mergePreview || mergeTargetId === mergeSourceId || mergePreview.conflicts.some((conflict) => !mergeDecisions[conflict.opportunityId])} onClick={() => void mergePerson()}>
            {busy ? '处理中…' : '确认合并并归档源人物'}
          </button>
        </div>}
      </>}
      {target.kind === 'opportunity' && <div style={{ marginBottom: 14 }}>
        <div>商机：{target.opportunity.name}</div>
        <button className="btn primary sm" style={{ marginTop: 8 }} onClick={onEditOpportunity}>编辑允许的关键字段</button>
      </div>}
      {(target.kind === 'visitNote' || target.kind === 'note') && <>
        <div className="empty-hint" style={{ marginBottom: 10 }}>仅修正客户/商机挂载；带人物引用的笔记不可跨客户隐式迁移。</div>
        <div className="fld-row">
          <label className="fld"><span>客户</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label className="fld"><span>商机</span><select value={opportunityId} onChange={(event) => setOpportunityId(event.target.value)}><option value="">仅挂客户</option>{opportunities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        </div>
      </>}

      {(target.kind === 'account' || target.kind === 'opportunity') && (() => {
        const recordAccount = target.account;
        const opportunityFilter = target.kind === 'opportunity' ? target.opportunity.id : null;
        const visits = (recordAccount.visitNotes ?? []).filter((item) => !opportunityFilter || item.opportunityId === opportunityFilter);
        const notes = (recordAccount.notes ?? []).filter((item) => !opportunityFilter || item.opportunityId === opportunityFilter);
        return <>
          <div className="section-t">记录挂载</div>
          {visits.length === 0 && notes.length === 0
            ? <div className="empty-hint">当前范围暂无拜访或笔记</div>
            : <div style={{ display: 'grid', gap: 8 }}>
              {visits.map((item) => <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ flex: 1 }}>拜访 · {item.topic || item.date}</span>
                <button className="btn ghost sm" onClick={() => onRepairRecord?.('visitNote', item.id)}>修正挂载</button>
              </div>)}
              {notes.map((item) => <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ flex: 1 }}>笔记 · {item.content.slice(0, 40)}</span>
                <button className="btn ghost sm" onClick={() => onRepairRecord?.('note', item.id)}>修正挂载</button>
              </div>)}
            </div>}
        </>;
      })()}

      <div className="section-t">溯源</div>
      {!context ? <div className="empty-hint">加载中…</div> : <>
        <div style={{ display: 'grid', gap: 5, fontSize: 13 }}>
          <div>来源：{context.source || '未识别'}</div>
          <div>sourceRef：{context.sourceRef || '无'}</div>
          <div>最近同步：{time(context.syncedAt)}</div>
        </div>
        <div className="section-t">SyncRun</div>
        {context.syncRuns.length === 0 ? <div className="empty-hint">无相关同步回执</div> : context.syncRuns.map((run) => <div key={run.id} style={{ fontSize: 12, marginBottom: 6 }}>{run.status} · {time(run.updatedAt)} · {run.id}</div>)}
        <div className="section-t">最近 AuditEvent</div>
        {context.auditEvents.length === 0 ? <div className="empty-hint">暂无审计记录</div> : context.auditEvents.map((event) => <div key={event.id} style={{ fontSize: 12, marginBottom: 6 }}>{event.action} · {event.changedFields.join(', ') || '无字段'} · {time(event.createdAt)}</div>)}
      </>}
    </Modal>
  );
}
