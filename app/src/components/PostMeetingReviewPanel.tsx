import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentJobCard,
  AgentRunView,
  CommandContext,
  CrmContextSnapshot,
  PostMeetingReviewBatchDetail,
  PostMeetingReviewReceipt,
  PostMeetingSourceOption,
} from '@jianghu/domain-contracts';
import { ApiError, api, newIdempotencyKey, toApiError } from '../api';
import {
  buildPostMeetingReviewRequest,
  createPostMeetingDraft,
  parsePostMeetingReviewReceipt,
  patchPostMeetingDraftItem,
  postMeetingReviewNotice,
  rebasePostMeetingDraft,
  stablePostMeetingSubmission,
  type PostMeetingDraft,
  type PostMeetingDraftPatch,
  type StablePostMeetingSubmission,
} from '../lib/postMeetingReview';

export interface PostMeetingRunSummary {
  id: string;
  status: AgentRunView['status'];
  failureCode: string;
  createdAt: string;
  outputBatchId: string | null;
}

export interface PostMeetingReviewViewProps {
  crmContext: CrmContextSnapshot;
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  job: AgentJobCard | null;
  sources: PostMeetingSourceOption[];
  runs: PostMeetingRunSummary[];
  customerId: string;
  matterId: string;
  sourceId: string;
  detail: PostMeetingReviewBatchDetail | null;
  draft: PostMeetingDraft | null;
  activityKind: string;
  occurredAtLocal: string;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onCustomerChange: (id: string) => void;
  onMatterChange: (id: string) => void;
  onSourceChange: (id: string) => void;
  onControl: () => void;
  onRun: () => void;
  onOpenBatch: (id: string) => void;
  onPatchDraft: (itemRef: string, patch: PostMeetingDraftPatch) => void;
  onActivityKindChange: (value: string) => void;
  onOccurredAtChange: (value: string) => void;
  onSubmit: () => void;
}

const kindLabel = {
  person: '新建干系人',
  relation: '关系',
  field: '字段变更',
  evidence: '证据',
  commitment: '下一步承诺',
} as const;

const statusLabel = {
  pending: '待审',
  accepted: '已采纳',
  rejected: '已驳回',
} as const;

function endpointLabel(endpoint: { kind: 'existing_person'; personId: string } | { kind: 'new_person'; itemRef: string }) {
  return endpoint.kind === 'existing_person' ? endpoint.personId : `新人物 ${endpoint.itemRef}`;
}

function beforeAfter(item: PostMeetingReviewBatchDetail['items'][number]) {
  if (item.kind === 'person') return { before: '—', after: `${item.after.name}${item.after.title ? ` · ${item.after.title}` : ''}` };
  if (item.kind === 'relation') return {
    before: '—',
    after: `${endpointLabel(item.after.sourcePerson)} → ${endpointLabel(item.after.targetPerson)} · ${item.after.layer}${item.after.label ? ` · ${item.after.label}` : ''}`,
  };
  if (item.kind === 'field') return { before: item.before ?? '空', after: item.after ?? '空' };
  if (item.kind === 'evidence') return {
    before: '—',
    after: `${item.after.signalKey} · ${item.after.direction} · ${item.after.tier}`,
  };
  return { before: '—', after: `${item.after.commitment.title} · ${item.after.commitment.kind}` };
}

function ReviewEditor({
  item, draft, disabled, onPatch,
}: {
  item: PostMeetingReviewBatchDetail['items'][number];
  draft: PostMeetingDraft['items'][string];
  disabled: boolean;
  onPatch: (patch: PostMeetingDraftPatch) => void;
}) {
  if (item.kind === 'person' && draft.kind === 'person') {
    return <div className="post-meeting-edit-grid">
      <label>姓名<input value={draft.edit.name ?? item.after.name} disabled={disabled} onChange={(event) => onPatch({ edit: { ...draft.edit, name: event.target.value } })} /></label>
      <label>职务<input value={draft.edit.title ?? ''} disabled={disabled} onChange={(event) => onPatch({ edit: { ...draft.edit, title: event.target.value || null } })} /></label>
    </div>;
  }
  if (item.kind === 'relation' && draft.kind === 'relation') {
    return <div className="post-meeting-edit-grid">
      <label>层级<select value={draft.edit.layer ?? item.after.layer} disabled={disabled} onChange={(event) => onPatch({ edit: { ...draft.edit, layer: event.target.value as 'L1' | 'L2' | 'L3' | 'L4' } })}>
        {['L1', 'L2', 'L3', 'L4'].map((layer) => <option key={layer} value={layer}>{layer}</option>)}
      </select></label>
      <label>标签<input value={draft.edit.label ?? ''} disabled={disabled} onChange={(event) => onPatch({ edit: { ...draft.edit, label: event.target.value || null } })} /></label>
    </div>;
  }
  if (item.kind === 'field' && draft.kind === 'field') {
    return <label className="post-meeting-edit-field">确认新值
      <input
        value={draft.edit.value ?? ''}
        disabled={disabled}
        onChange={(event) => onPatch({ edit: { value: event.target.value || null } })}
      />
    </label>;
  }
  if (item.kind === 'evidence' && draft.kind === 'evidence') {
    return <div className="post-meeting-edit-grid">
      <label>方向<select value={draft.edit.direction ?? item.after.direction} disabled={disabled} onChange={(event) => onPatch({ edit: { ...draft.edit, direction: Number(event.target.value) as -1 | 0 | 1 } })}>
        <option value={1}>利好</option><option value={0}>中性</option><option value={-1}>不利</option>
      </select></label>
      <label>强度<select value={draft.edit.tier ?? item.after.tier} disabled={disabled} onChange={(event) => onPatch({ edit: { ...draft.edit, tier: event.target.value as 'weak' | 'mid' | 'strong' } })}>
        <option value="weak">弱</option><option value="mid">中</option><option value="strong">强</option>
      </select></label>
    </div>;
  }
  if (item.kind === 'commitment' && draft.kind === 'commitment') {
    return <div className="post-meeting-edit-grid">
      <label>承诺标题<input value={draft.edit.command.commitment.title} disabled={disabled} onChange={(event) => onPatch({ edit: {
        command: { ...draft.edit.command, commitment: { ...draft.edit.command.commitment, title: event.target.value } },
      } })} /></label>
      <label>类型<input value={draft.edit.command.commitment.kind} disabled={disabled} onChange={(event) => onPatch({ edit: {
        command: { ...draft.edit.command, commitment: { ...draft.edit.command.commitment, kind: event.target.value } },
      } })} /></label>
    </div>;
  }
  return null;
}

export function PostMeetingReviewView(props: PostMeetingReviewViewProps) {
  if (props.readonly || props.actorRole === 'viewer') return null;
  const customers = props.crmContext.customers.filter((customer) => customer.archivedAt === null);
  const matters = props.crmContext.matters.filter((matter) => (
    matter.archivedAt === null && matter.customerId === props.customerId
  ));
  const canControl = props.actorRole === 'owner' || props.actorRole === 'admin';
  const canRun = Boolean(
    props.job?.available && props.job.enabled && props.customerId && props.matterId && props.sourceId,
  ) && !props.busy;
  const selectedPending = props.detail?.items.filter((item) => (
    item.status === 'pending' && props.draft?.items[item.itemRef]?.selected
  )).length ?? 0;
  return (
    <section className="post-meeting-review" data-post-meeting-review={props.loading ? 'loading' : 'ready'}>
      <div className="post-meeting-heading">
        <div><span className="eyebrow">AI 候选 · 人工确认</span><h2>会后速审</h2></div>
        <span className={`post-meeting-job-state ${props.job?.enabled ? 'enabled' : 'disabled'}`}>
          {props.job ? (props.job.enabled ? '已启用' : '已停用') : '不可用'}
        </span>
      </div>
      <p className="post-meeting-lede">从一份已授权的会议记录中生成待审候选；勾选并确认前不会写入正式 CRM。</p>
      <div className="post-meeting-toolbar">
        <label>客户<select value={props.customerId} disabled={props.busy} onChange={(event) => props.onCustomerChange(event.target.value)}>
          <option value="">选择客户</option>
          {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select></label>
        <label>事项<select value={props.matterId} disabled={props.busy || !props.customerId} onChange={(event) => props.onMatterChange(event.target.value)}>
          <option value="">选择事项</option>
          {matters.map((matter) => <option key={matter.id} value={matter.id}>{matter.title}</option>)}
        </select></label>
        <label>来源<select value={props.sourceId} disabled={props.busy || !props.matterId} onChange={(event) => props.onSourceChange(event.target.value)}>
          <option value="">选择会议记录</option>
          {props.sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select></label>
        <button className="btn primary" disabled={!canRun} onClick={props.onRun}>生成候选</button>
        {canControl && props.job && <button
          className="btn ghost"
          data-job-control="true"
          disabled={props.busy || !props.job.available}
          onClick={props.onControl}
        >{props.job.enabled ? '停用任务' : '启用任务'}</button>}
      </div>
      {props.loading && <div className="commercial-shell-empty">正在读取会后任务…</div>}
      {props.error && <div className="post-meeting-message error" role="alert">{props.error}</div>}
      {props.notice && <div className="post-meeting-message success" role="status">{props.notice}</div>}
      {props.runs.length > 0 && <div className="post-meeting-runs" aria-label="最近运行">
        {props.runs.slice(0, 6).map((run) => <button
          key={run.id}
          data-run-status={run.status}
          disabled={!run.outputBatchId || props.busy}
          onClick={() => run.outputBatchId && props.onOpenBatch(run.outputBatchId)}
        ><span>{run.status === 'succeeded' ? '已生成' : run.status === 'running' ? '运行中' : '未完成'}</span><small>{run.failureCode || new Date(run.createdAt).toLocaleString()}</small></button>)}
      </div>}
      {props.detail && props.draft && <div className="post-meeting-sheet">
        <div className="post-meeting-source-meta">
          <strong>{props.detail.source.title}</strong>
          <span>{props.detail.source.kind} · {props.detail.source.fingerprint.slice(0, 10)}…</span>
        </div>
        <div className="post-meeting-items">
          {props.detail.items.map((item) => {
            const itemDraft = props.draft!.items[item.itemRef];
            if (!itemDraft || itemDraft.kind !== item.kind) return null;
            const diff = beforeAfter(item);
            const editable = item.status === 'pending' && itemDraft.selected
              && itemDraft.decision === 'accept' && !props.busy;
            return <article key={item.candidateId} className={`post-meeting-item ${item.status}`} data-review-kind={item.kind}>
              <div className="post-meeting-item-head">
                <label className="post-meeting-select">
                  <input
                    type="checkbox"
                    checked={itemDraft.selected}
                    disabled={item.status !== 'pending' || props.busy}
                    onChange={(event) => props.onPatchDraft(item.itemRef, { selected: event.target.checked })}
                  />
                  <strong>{kindLabel[item.kind]}</strong>
                </label>
                <span>{statusLabel[item.status]} · {Math.round(item.confidence * 100)}%</span>
              </div>
              <blockquote>{item.sourceQuote}</blockquote>
              <div className="post-meeting-diff">
                <div><small>改前</small><span>{diff.before}</span></div>
                <div aria-hidden="true">→</div>
                <div><small>改后</small><span>{diff.after}</span></div>
              </div>
              {item.status === 'pending' && <div className="post-meeting-decision-row">
                <label>处理<select
                  value={itemDraft.decision}
                  disabled={!itemDraft.selected || props.busy}
                  onChange={(event) => props.onPatchDraft(item.itemRef, { decision: event.target.value as 'accept' | 'reject' })}
                ><option value="accept">采纳</option><option value="reject">驳回</option></select></label>
              </div>}
              <ReviewEditor
                item={item}
                draft={itemDraft}
                disabled={!editable}
                onPatch={(patch) => props.onPatchDraft(item.itemRef, patch)}
              />
              {itemDraft.conflictReason && <p className="post-meeting-conflict">需刷新确认：{itemDraft.conflictReason}</p>}
            </article>;
          })}
        </div>
        {props.detail.status === 'pending' && <div className="post-meeting-submit">
          <label>活动类型<input value={props.activityKind} disabled={props.busy} onChange={(event) => props.onActivityKindChange(event.target.value)} /></label>
          <label>发生时间<input type="datetime-local" value={props.occurredAtLocal} disabled={props.busy} onChange={(event) => props.onOccurredAtChange(event.target.value)} /></label>
          <button className="btn primary" disabled={props.busy || selectedPending === 0} onClick={props.onSubmit}>确认处理所选项（{selectedPending}）</button>
        </div>}
      </div>}
    </section>
  );
}

function localDateTime(value: string | null): string {
  const date = value ? new Date(value) : new Date();
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function runSummary(run: Awaited<ReturnType<typeof api.postMeetingRuns>>['items'][number]): PostMeetingRunSummary {
  return {
    id: run.id,
    status: run.status,
    failureCode: run.failureCode,
    createdAt: run.createdAt,
    outputBatchId: run.outputRefs.find((ref) => ref.kind === 'review_batch')?.id ?? null,
  };
}

export function PostMeetingReviewPanel({
  crmContext,
  actorRole,
  readonly,
  onDataChanged,
}: {
  crmContext: CrmContextSnapshot | null;
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  onDataChanged: () => Promise<unknown>;
}) {
  const activeCustomers = useMemo(
    () => crmContext?.customers.filter((customer) => customer.archivedAt === null) ?? [],
    [crmContext],
  );
  const [customerId, setCustomerId] = useState('');
  const [matterId, setMatterId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [job, setJob] = useState<AgentJobCard | null>(null);
  const [sources, setSources] = useState<PostMeetingSourceOption[]>([]);
  const [runs, setRuns] = useState<PostMeetingRunSummary[]>([]);
  const [detail, setDetail] = useState<PostMeetingReviewBatchDetail | null>(null);
  const [draft, setDraft] = useState<PostMeetingDraft | null>(null);
  const [activityKind, setActivityKind] = useState('customer_meeting');
  const [occurredAtLocal, setOccurredAtLocal] = useState(() => localDateTime(null));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const runSubmission = useRef<{ canonical: string; key: string } | null>(null);
  const reviewSubmission = useRef<StablePostMeetingSubmission | null>(null);

  const openBatch = useCallback(async (batchId: string) => {
    setBusy(true); setError('');
    try {
      const next = await api.postMeetingReview(batchId);
      setDetail(next);
      setDraft((current) => current?.batchId === next.id
        ? rebasePostMeetingDraft(current, next)
        : createPostMeetingDraft(next));
      setActivityKind(next.activityKind ?? 'customer_meeting');
      setOccurredAtLocal(localDateTime(next.occurredAt ?? next.source.occurredAt));
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!crmContext || readonly || actorRole === 'viewer') return;
    let cancelled = false;
    setLoading(true);
    Promise.all([api.postMeetingJobCards(), api.postMeetingRuns()]).then(async ([cards, history]) => {
      if (cancelled) return;
      setJob(cards.items.find((card) => card.jobKey === 'post_meeting_extract') ?? null);
      const summaries = history.items.map(runSummary);
      setRuns(summaries);
      const batchId = summaries.find((run) => run.outputBatchId)?.outputBatchId;
      if (batchId) {
        try {
          const next = await api.postMeetingReview(batchId);
          if (!cancelled) {
            setDetail(next);
            setDraft(createPostMeetingDraft(next));
            setActivityKind(next.activityKind ?? 'customer_meeting');
            setOccurredAtLocal(localDateTime(next.occurredAt ?? next.source.occurredAt));
          }
        } catch { /* history may include a batch no longer reviewable */ }
      }
    }).catch((cause) => {
      if (!cancelled) setError(toApiError(cause).message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [actorRole, crmContext, readonly]);

  useEffect(() => {
    if (!activeCustomers.some((customer) => customer.id === customerId)) {
      setCustomerId(activeCustomers[0]?.id ?? '');
    }
  }, [activeCustomers, customerId]);
  const matters = useMemo(() => crmContext?.matters.filter((matter) => (
    matter.archivedAt === null && matter.customerId === customerId
  )) ?? [], [crmContext, customerId]);
  useEffect(() => {
    if (!matters.some((matter) => matter.id === matterId)) setMatterId(matters[0]?.id ?? '');
  }, [matterId, matters]);

  useEffect(() => {
    if (!customerId || !matterId || readonly || actorRole === 'viewer') {
      setSources([]); setSourceId(''); return;
    }
    let cancelled = false;
    api.postMeetingSources(customerId, matterId).then((next) => {
      if (cancelled) return;
      setSources(next);
      setSourceId((current) => next.some((source) => source.id === current) ? current : next[0]?.id ?? '');
    }).catch((cause) => {
      if (!cancelled) { setSources([]); setSourceId(''); setError(toApiError(cause).message); }
    });
    return () => { cancelled = true; };
  }, [actorRole, customerId, matterId, readonly]);

  if (!crmContext || readonly || actorRole === 'viewer') return null;
  const changeCustomer = (id: string) => {
    setCustomerId(id); setMatterId(''); setSourceId(''); setDetail(null); setDraft(null);
    runSubmission.current = null; reviewSubmission.current = null;
  };
  const changeMatter = (id: string) => {
    setMatterId(id); setSourceId(''); setDetail(null); setDraft(null);
    runSubmission.current = null; reviewSubmission.current = null;
  };
  const control = async () => {
    if (!job || (actorRole !== 'owner' && actorRole !== 'admin')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.postMeetingControl(
        job.jobVersion, !job.enabled, job.controlVersion, newIdempotencyKey(),
      );
      setJob(result.card);
      setNotice(result.card.enabled ? '会后任务已启用' : '会后任务已停用');
    } catch (cause) { setError(toApiError(cause).message); } finally { setBusy(false); }
  };
  const run = async () => {
    const customer = crmContext.customers.find((item) => item.id === customerId);
    const matter = crmContext.matters.find((item) => item.id === matterId && item.customerId === customerId);
    const source = sources.find((item) => item.id === sourceId
      && item.customerId === customerId && item.matterId === matterId);
    if (!job?.enabled || !customer || !matter || !source) {
      setError('请先选择有效的客户、事项和会议来源。'); return;
    }
    const input = {
      jobVersion: job.jobVersion,
      customerId: customer.id,
      matterId: matter.id,
      sourceArtifactId: source.id,
      inputRefs: [
        { kind: 'customer' as const, id: customer.id, version: customer.version },
        { kind: 'matter' as const, id: matter.id, version: matter.version },
        { kind: 'source_artifact' as const, id: source.id, version: source.version },
      ],
    };
    const canonical = JSON.stringify(input);
    if (runSubmission.current?.canonical !== canonical) {
      runSubmission.current = { canonical, key: newIdempotencyKey() };
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await api.postMeetingRun(input, runSubmission.current.key);
      const summary = runSummary(receipt.run);
      setRuns((current) => [summary, ...current.filter((item) => item.id !== summary.id)]);
      if (receipt.run.status === 'succeeded' && summary.outputBatchId) {
        const next = await api.postMeetingReview(summary.outputBatchId);
        setDetail(next); setDraft(createPostMeetingDraft(next));
        setActivityKind(next.activityKind ?? 'customer_meeting');
        setOccurredAtLocal(localDateTime(next.occurredAt ?? next.source.occurredAt));
        setNotice('候选已生成，请逐项确认。');
      } else {
        setError(receipt.run.failureCode || '会后任务未完成。');
      }
    } catch (cause) { setError(toApiError(cause).message); } finally { setBusy(false); }
  };
  const submit = async () => {
    if (!detail || !draft) return;
    let request;
    try {
      const date = new Date(occurredAtLocal);
      if (!Number.isFinite(date.getTime())) throw new Error('请填写有效的发生时间。');
      request = buildPostMeetingReviewRequest({
        detail, draft, activityKind, occurredAt: date.toISOString(),
      });
      reviewSubmission.current = stablePostMeetingSubmission(
        request, reviewSubmission.current, newIdempotencyKey,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '请至少选择一项并检查编辑内容。');
      return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const receipt = await api.postMeetingAccept(
        detail.id, request, reviewSubmission.current.idempotencyKey,
      );
      const refreshed = await api.postMeetingReview(detail.id);
      setDetail(refreshed);
      setDraft(rebasePostMeetingDraft(draft, refreshed));
      setNotice(postMeetingReviewNotice({ status: receipt.status, itemCount: receipt.items.length }));
      reviewSubmission.current = null;
      await onDataChanged().catch(() => undefined);
    } catch (cause) {
      const apiError = toApiError(cause);
      if (apiError instanceof ApiError && apiError.status === 409) {
        let conflict: Extract<PostMeetingReviewReceipt, { code: 'review_batch_conflict' }> | null = null;
        try {
          const parsed = parsePostMeetingReviewReceipt(apiError.cause);
          if ('code' in parsed) conflict = parsed;
        } catch { /* invalid 409 is already surfaced as an API error */ }
        try {
          const refreshed = await api.postMeetingReview(detail.id);
          setDetail(refreshed);
          setDraft(rebasePostMeetingDraft(draft, refreshed, conflict));
          reviewSubmission.current = null;
        } catch { /* retain current draft if refresh also fails */ }
      }
      setError(apiError.message);
    } finally { setBusy(false); }
  };

  return <PostMeetingReviewView
    crmContext={crmContext}
    actorRole={actorRole}
    readonly={readonly}
    job={job}
    sources={sources}
    runs={runs}
    customerId={customerId}
    matterId={matterId}
    sourceId={sourceId}
    detail={detail}
    draft={draft}
    activityKind={activityKind}
    occurredAtLocal={occurredAtLocal}
    loading={loading}
    busy={busy}
    error={error}
    notice={notice}
    onCustomerChange={changeCustomer}
    onMatterChange={changeMatter}
    onSourceChange={(id) => { setSourceId(id); runSubmission.current = null; }}
    onControl={() => { void control(); }}
    onRun={() => { void run(); }}
    onOpenBatch={(id) => { void openBatch(id); }}
    onPatchDraft={(itemRef, patch) => setDraft((current) => (
      current ? patchPostMeetingDraftItem(current, itemRef, patch) : current
    ))}
    onActivityKindChange={setActivityKind}
    onOccurredAtChange={setOccurredAtLocal}
    onSubmit={() => { void submit(); }}
  />;
}
