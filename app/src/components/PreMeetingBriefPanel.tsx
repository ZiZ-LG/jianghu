import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentJobCard,
  AgentRunView,
  CommandContext,
  CrmContextSnapshot,
  PostMeetingSourceOption,
  ResearchBriefSnapshotDetail,
  ResearchBriefSnapshotMetadata,
} from '@jianghu/domain-contracts';
import { api, newIdempotencyKey, toApiError } from '../api';
import {
  buildPreMeetingRunInput,
  preMeetingRunOutcome,
  stablePreMeetingRunSubmission,
  type StablePreMeetingRunSubmission,
} from '../lib/preMeetingBrief';

export interface PreMeetingRunSummary {
  id: string;
  status: AgentRunView['status'];
  failureCode: string;
  createdAt: string;
}

export interface PreMeetingBriefViewProps {
  crmContext: CrmContextSnapshot | null;
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  job: AgentJobCard | null;
  sources: PostMeetingSourceOption[];
  history: ResearchBriefSnapshotMetadata[];
  runs: PreMeetingRunSummary[];
  customerId: string;
  matterId: string;
  sourceId: string;
  detail: ResearchBriefSnapshotDetail | null;
  loading: boolean;
  busy: boolean;
  error: string;
  notice: string;
  onCustomerChange: (id: string) => void;
  onMatterChange: (id: string) => void;
  onSourceChange: (id: string) => void;
  onControl: () => void;
  onRun: () => void;
  onOpenBrief: (id: string) => void;
}

function localTime(value: string | null): string {
  if (!value) return '时间未知';
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? instant.toLocaleString('zh-CN') : '时间无效';
}

function statusCopy(status: ResearchBriefSnapshotMetadata['status']): string {
  if (status === 'ready') return '已就绪';
  if (status === 'partial') return '部分信息';
  return '已阻断';
}

export function PreMeetingBriefView(props: PreMeetingBriefViewProps) {
  const customers = props.crmContext?.customers.filter((customer) => customer.archivedAt === null) ?? [];
  const matters = props.crmContext?.matters.filter((matter) => (
    matter.archivedAt === null && matter.customerId === props.customerId
  )) ?? [];
  const canControl = !props.readonly
    && (props.actorRole === 'owner' || props.actorRole === 'admin');
  const canRun = !props.readonly
    && props.actorRole !== 'viewer'
    && Boolean(props.job?.available && props.job.enabled)
    && Boolean(props.customerId && props.matterId && props.sourceId)
    && !props.busy;
  const sourceById = new Map(props.detail?.payload.sources.map((source) => [source.id, source]) ?? []);

  return (
    <section className="pre-meeting-brief" data-pre-meeting-brief={props.loading ? 'loading' : 'ready'}>
      <div className="pre-meeting-heading">
        <div><span className="eyebrow">证据引用 · 只读派生</span><h2>拜访前简报</h2></div>
        <div className="pre-meeting-authority">
          <strong>唯一权威</strong>
          <span>{props.job ? (props.job.enabled ? '任务已启用' : '任务已停用') : '任务不可用'}</span>
        </div>
      </div>
      <p className="pre-meeting-lede">基于当前授权来源生成加密不可变快照；缺失信息明确标为待核，不会改写客户、事项、阶段或预测。</p>
      <div className="pre-meeting-toolbar">
        <label>客户<select value={props.customerId} disabled={props.busy} onChange={(event) => props.onCustomerChange(event.target.value)}>
          <option value="">选择客户</option>
          {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
        </select></label>
        <label>事项<select value={props.matterId} disabled={props.busy || !props.customerId} onChange={(event) => props.onMatterChange(event.target.value)}>
          <option value="">选择事项</option>
          {matters.map((matter) => <option key={matter.id} value={matter.id}>{matter.title}</option>)}
        </select></label>
        <label>来源<select value={props.sourceId} disabled={props.busy || !props.matterId} onChange={(event) => props.onSourceChange(event.target.value)}>
          <option value="">选择已授权来源</option>
          {props.sources.map((source) => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select></label>
        {!props.readonly && props.actorRole !== 'viewer' && <button className="btn primary" disabled={!canRun} onClick={props.onRun}>生成简报</button>}
        {canControl && props.job && <button
          className="btn ghost"
          data-pre-meeting-control="true"
          disabled={props.busy || !props.job.available}
          onClick={props.onControl}
        >{props.job.enabled ? '停用任务' : '启用任务'}</button>}
      </div>

      {props.loading && <div className="commercial-shell-empty">正在读取拜访前简报…</div>}
      {props.error && <div className="pre-meeting-message error" role="alert">{props.error}</div>}
      {props.notice && <div className="pre-meeting-message success" role="status">{props.notice}</div>}

      {(props.history.length > 0 || props.runs.length > 0) && <div className="pre-meeting-history-row">
        <div className="pre-meeting-history" aria-label="简报历史">
          {props.history.slice(0, 8).map((item) => <button
            key={item.id}
            data-brief-status={item.status}
            disabled={props.busy}
            onClick={() => props.onOpenBrief(item.id)}
          ><strong>{statusCopy(item.status)}</strong><small>{localTime(item.generatedAt)}</small></button>)}
        </div>
        {props.runs.some((run) => run.status !== 'succeeded') && <div className="pre-meeting-run-failures" aria-label="最近未完成运行">
          {props.runs.filter((run) => run.status !== 'succeeded').slice(0, 4).map((run) => (
            <span key={run.id}>{run.failureCode || run.status} · {localTime(run.createdAt)}</span>
          ))}
        </div>}
      </div>}

      {props.detail ? <article className="pre-meeting-sheet" data-brief-status={props.detail.status}>
        <header className="pre-meeting-sheet-head">
          <div>
            <span>{statusCopy(props.detail.status)}</span>
            <strong>{props.detail.payload.subject.query}</strong>
          </div>
          <small>生成于 {localTime(props.detail.generatedAt)} · 版本 {props.detail.version}</small>
        </header>

        <div className="pre-meeting-source-grid" aria-label="简报来源">
          {props.detail.payload.sources.map((source) => <div key={source.id} data-source-status={source.status}>
            <strong>{source.label}</strong>
            <span>{source.kind} · {source.status}</span>
            <small>观察 {localTime(source.observedAt)} · 获取 {localTime(source.retrievedAt)}</small>
            <small>有效至 {localTime(source.freshUntil)}</small>
          </div>)}
        </div>

        <div className="pre-meeting-sections">
          {props.detail.payload.sections.map((section) => <section key={section.key}>
            <div><h3>{section.title}</h3><small>截至 {localTime(section.asOf)}</small></div>
            <p>{section.content}</p>
            <ul aria-label={`${section.title} 引用`}>
              {section.sourceIds.map((sourceId) => {
                const source = sourceById.get(sourceId);
                return <li key={sourceId}>{source?.label ?? sourceId} · {source?.status ?? 'unavailable'} · {localTime(source?.observedAt ?? null)}</li>;
              })}
            </ul>
          </section>)}
        </div>

        {props.detail.payload.unknowns.length > 0 && <div className="pre-meeting-unknowns">
          <h3>拜访待核</h3>
          {props.detail.payload.unknowns.map((unknown) => <div key={unknown.key}>
            <strong>{unknown.question}</strong><span>{unknown.reasonCode}</span>
            {unknown.sourceIds.length > 0 && <small>参考：{unknown.sourceIds.map((id) => sourceById.get(id)?.label ?? id).join('、')}</small>}
          </div>)}
        </div>}
        {props.detail.payload.failures.length > 0 && <div className="pre-meeting-failures">
          <h3>来源失败</h3>
          {props.detail.payload.failures.map((failure) => <span key={`${failure.sourceId}:${failure.code}`}>
            {sourceById.get(failure.sourceId)?.label ?? failure.sourceId} · {failure.code}
          </span>)}
        </div>}
      </article> : !props.loading && <div className="commercial-shell-empty">尚无可显示的拜访前简报。</div>}
    </section>
  );
}

function runSummary(run: AgentRunView): PreMeetingRunSummary {
  return { id: run.id, status: run.status, failureCode: run.failureCode, createdAt: run.createdAt };
}

export function PreMeetingBriefPanel({
  crmContext,
  actorRole,
  readonly,
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
  const [history, setHistory] = useState<ResearchBriefSnapshotMetadata[]>([]);
  const [runs, setRuns] = useState<PreMeetingRunSummary[]>([]);
  const [detail, setDetail] = useState<ResearchBriefSnapshotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const runSubmission = useRef<StablePreMeetingRunSubmission | null>(null);

  const openBrief = useCallback(async (briefId: string) => {
    setBusy(true); setError('');
    try {
      setDetail(await api.preMeetingBrief(briefId));
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!crmContext) { setLoading(true); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([api.preMeetingJobCards(), api.preMeetingRuns()]).then(([cards, runPage]) => {
      if (cancelled) return;
      setJob(cards.items[0] ?? null);
      setRuns(runPage.items.map(runSummary));
    }).catch((cause) => {
      if (!cancelled) setError(toApiError(cause).message);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [crmContext]);

  useEffect(() => {
    if (!activeCustomers.some((customer) => customer.id === customerId)) {
      setCustomerId(activeCustomers[0]?.id ?? '');
    }
  }, [activeCustomers, customerId]);
  const matters = useMemo(() => crmContext?.matters.filter((matter) => (
    matter.archivedAt === null && matter.customerId === customerId
  )) ?? [], [crmContext, customerId]);
  useEffect(() => {
    if (!matters.some((matter) => matter.id === matterId)) {
      setMatterId(matters[0]?.id ?? '');
    }
  }, [matterId, matters]);

  useEffect(() => {
    if (!customerId || !matterId) {
      setSources([]); setSourceId(''); setHistory([]); setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.preMeetingSources(customerId, matterId),
      api.preMeetingBriefs(customerId, matterId),
    ]).then(async ([sourceOptions, briefPage]) => {
      if (cancelled) return;
      setSources(sourceOptions);
      setSourceId((current) => sourceOptions.some((source) => source.id === current)
        ? current : sourceOptions[0]?.id ?? '');
      setHistory(briefPage.items);
      const latest = briefPage.items[0];
      if (!latest) { setDetail(null); return; }
      try {
        const item = await api.preMeetingBrief(latest.id);
        if (!cancelled) setDetail(item);
      } catch (cause) {
        if (!cancelled) setError(toApiError(cause).message);
      }
    }).catch((cause) => {
      if (!cancelled) {
        setSources([]); setSourceId(''); setHistory([]); setDetail(null);
        setError(toApiError(cause).message);
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [customerId, matterId]);

  const changeCustomer = (id: string) => {
    setCustomerId(id); setMatterId(''); setSourceId(''); setDetail(null);
    setHistory([]); setError(''); setNotice(''); runSubmission.current = null;
  };
  const changeMatter = (id: string) => {
    setMatterId(id); setSourceId(''); setDetail(null);
    setHistory([]); setError(''); setNotice(''); runSubmission.current = null;
  };
  const control = async () => {
    if (!job || (actorRole !== 'owner' && actorRole !== 'admin') || readonly) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api.preMeetingControl(
        job.jobVersion, !job.enabled, job.controlVersion, newIdempotencyKey(),
      );
      setJob(result.card);
      setNotice(result.card.enabled ? '拜访前简报任务已启用' : '拜访前简报任务已停用');
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!crmContext || !job || readonly || actorRole === 'viewer') return;
    const customer = crmContext.customers.find((item) => item.id === customerId);
    const matter = crmContext.matters.find((item) => (
      item.id === matterId && item.customerId === customerId
    ));
    const source = sources.find((item) => (
      item.id === sourceId && item.customerId === customerId && item.matterId === matterId
    ));
    if (!customer || !matter || !source) {
      setError('请先选择有效的客户、事项和已授权来源。'); return;
    }
    setBusy(true); setError(''); setNotice('');
    try {
      const input = buildPreMeetingRunInput({ job, customer, matter, source });
      runSubmission.current = stablePreMeetingRunSubmission(
        input, runSubmission.current, newIdempotencyKey,
      );
      const receipt = await api.preMeetingRun(
        input, runSubmission.current.idempotencyKey,
      );
      const summary = runSummary(receipt.run);
      setRuns((current) => [summary, ...current.filter((item) => item.id !== summary.id)]);
      const outcome = preMeetingRunOutcome(receipt.run);
      if (!outcome.briefId) {
        if (outcome.canRetry) runSubmission.current = null;
        setError(`简报任务未完成（${outcome.errorCode || receipt.run.status}），可检查后重试。`);
        return;
      }
      const [item, page] = await Promise.all([
        api.preMeetingBrief(outcome.briefId),
        api.preMeetingBriefs(customerId, matterId),
      ]);
      setDetail(item); setHistory(page.items);
      setNotice('拜访前简报已生成；结论均保留来源引用。');
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      setBusy(false);
    }
  };

  return <PreMeetingBriefView
    crmContext={crmContext}
    actorRole={actorRole}
    readonly={readonly}
    job={job}
    sources={sources}
    history={history}
    runs={runs}
    customerId={customerId}
    matterId={matterId}
    sourceId={sourceId}
    detail={detail}
    loading={loading}
    busy={busy}
    error={error}
    notice={notice}
    onCustomerChange={changeCustomer}
    onMatterChange={changeMatter}
    onSourceChange={(id) => { setSourceId(id); setError(''); runSubmission.current = null; }}
    onControl={() => { void control(); }}
    onRun={() => { void run(); }}
    onOpenBrief={(id) => { void openBrief(id); }}
  />;
}
