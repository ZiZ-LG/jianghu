import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentJobCard,
  AgentRunView,
  CommandContext,
  CommitmentCommand,
  InterventionSourceRef,
  RelationshipRadarActionDraft,
  RelationshipRadarResponse,
  TodaySourceView,
} from '@jianghu/domain-contracts';
import { api, newIdempotencyKey, toApiError } from '../api';
import {
  buildRelationshipRadarRunInput,
  stableRelationshipRadarRunSubmission,
  type StableRelationshipRadarRunSubmission,
} from '../lib/relationshipRadar';

type RadarLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
    status: 'ready';
    response: RelationshipRadarResponse;
    card: AgentJobCard | null;
    runs: AgentRunView[];
  };

const dimensionLabels = {
  interaction_freshness: '互动新鲜度',
  single_threaded_contact: '联系线覆盖',
  role_coverage: '通用角色覆盖',
  visible_warm_paths: '可见暖路径',
  evidence_freshness: 'Evidence 新鲜度',
  next_step_completeness: '下一步完整性',
} as const;

const statusLabels = {
  healthy: '健康', attention: '需关注', gap: '有缺口', unknown: '未知',
} as const;

const runStatusLabels = {
  running: '运行中', succeeded: '成功', failed: '失败', discarded: '已丢弃',
} as const;

function localTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : value;
}

function futureLocalDateTime(): string {
  const value = new Date(Date.now() + 86_400_000);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export interface RelationshipRadarPanelViewProps {
  state: RadarLoadState;
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  busy: boolean;
  notice: string;
  error: string;
  source: TodaySourceView | null;
  draftOpen: boolean;
  draftTitle: string;
  draftScheduledAt: string;
  onReload: () => void;
  onToggleControl: (enabled: boolean) => void;
  onRun: () => void;
  onOpenSource: (source: InterventionSourceRef) => void;
  onOpenDraft: (draft: RelationshipRadarActionDraft) => void;
  onCloseDraft: () => void;
  onDraftTitle: (value: string) => void;
  onDraftScheduledAt: (value: string) => void;
  onSubmitDraft: () => void;
}

export function RelationshipRadarPanelView(props: RelationshipRadarPanelViewProps) {
  if (props.state.status === 'idle') return null;
  if (props.state.status === 'loading') {
    return <section className="relationship-radar" data-relationship-radar="loading">正在核验关系雷达…</section>;
  }
  if (props.state.status === 'error') {
    return <section className="relationship-radar" data-relationship-radar="error" role="alert">
      <p>{props.state.message}</p><button type="button" className="btn ghost" onClick={props.onReload}>重新加载</button>
    </section>;
  }

  const { response, card, runs } = props.state;
  const canControl = props.actorRole === 'owner' || props.actorRole === 'admin';
  const canRun = !props.readonly
    && props.actorRole !== 'viewer'
    && card?.available === true
    && card.enabled
    && card.controlState === 'valid';
  const ready = response.status === 'ready';
  const current = ready && response.snapshot.sourceState === 'current';
  return <section className="relationship-radar" data-relationship-radar={response.status}>
    <header className="relationship-radar-heading">
      <div><span className="eyebrow">确定性规则 · 无汇总分</span><h3>关系雷达</h3></div>
      <div className="relationship-radar-actions">
        {canControl && card ? <button
          type="button" className="btn ghost" disabled={props.busy || !card.available}
          onClick={() => props.onToggleControl(!card.enabled)}
        >{card.enabled ? '停用雷达任务' : '启用雷达任务'}</button> : null}
        {canRun ? <button type="button" className="btn primary" disabled={props.busy} onClick={props.onRun}>重新生成</button> : null}
      </div>
    </header>
    <p className="relationship-authority-note">只读取当前可见的正式 CRM 元数据；不会写关系、阶段、预测或关键人状态。</p>
    {props.notice ? <p className="relationship-message success" role="status">{props.notice}</p> : null}
    {props.error ? <p className="relationship-message error" role="alert">{props.error}</p> : null}
    {!card?.available ? <p className="relationship-empty">关系雷达执行器当前不可用。</p> : null}
    {card?.available && !card.enabled ? <p className="relationship-empty">关系雷达任务尚未由 owner/admin 启用。</p> : null}
    {response.status === 'missing' ? <p className="relationship-empty">尚未生成关系雷达。</p> : null}
    {response.status === 'expired' ? <p className="relationship-empty">最近快照已过期，请重新生成。</p> : null}
    {ready && !current ? <p className="relationship-message error">正式来源或当前权限已变化；结果已降级为未知，请重新生成。</p> : null}
    {runs.length > 0 ? <div className="relationship-radar-history" aria-label="关系雷达运行历史">
      <strong>最近运行</strong>
      <ol>{runs.slice(0, 5).map((run) => <li key={run.id}>
        <span>{runStatusLabels[run.status]}</span>
        <time dateTime={run.completedAt ?? run.createdAt}>{localTime(run.completedAt ?? run.createdAt)}</time>
      </li>)}</ol>
    </div> : null}
    {ready ? <>
      <div className="relationship-radar-meta">
        <span>生成 {localTime(response.snapshot.generatedAtUtc)}</span>
        <span>有效至 {localTime(response.snapshot.expiresAtUtc)}</span>
      </div>
      <div className="relationship-radar-signals">
        {response.projection.signals.map((signal) => <article
          key={signal.id}
          className="relationship-radar-signal"
          data-radar-dimension={signal.dimension}
          data-radar-status={signal.status}
        >
          <header><strong>{dimensionLabels[signal.dimension]}</strong><span>{statusLabels[signal.status]}</span></header>
          <p>{signal.explanation}</p>
          <div className="relationship-radar-sources">
            {signal.sourceRefs.map((sourceRef) => <button
              key={`${sourceRef.entityKind}:${sourceRef.entityId}:${sourceRef.version}:${sourceRef.scheduleVersion ?? 'none'}`}
              type="button" className="btn ghost xs" disabled={!current || props.busy}
              onClick={() => props.onOpenSource(sourceRef)}
            >查看依据</button>)}
          </div>
        </article>)}
      </div>
      {props.source ? <aside className="relationship-radar-source" aria-label="关系雷达来源">
        <strong>{props.source.label}</strong><span>{props.source.detail}</span>
      </aside> : null}
      {current && response.projection.drafts[0] && !props.readonly ? <div className="relationship-radar-draft">
        <p><strong>未提交草稿</strong>雷达只准备下一步标题，不会自动写入正式数据。</p>
        {!props.draftOpen ? <button
          type="button" className="btn ghost" disabled={props.busy}
          onClick={() => props.onOpenDraft(response.projection.drafts[0]!)}
        >打开下一步草稿</button> : <div className="relationship-radar-draft-editor">
          <label>标题<input value={props.draftTitle} maxLength={120} onChange={(event) => props.onDraftTitle(event.target.value)} /></label>
          <label>计划时间<input type="datetime-local" value={props.draftScheduledAt} onChange={(event) => props.onDraftScheduledAt(event.target.value)} /></label>
          <div><button type="button" className="btn ghost" disabled={props.busy} onClick={props.onCloseDraft}>取消</button>
            <button type="button" className="btn primary" disabled={props.busy || !props.draftTitle.trim() || !props.draftScheduledAt} onClick={props.onSubmitDraft}>提交为正式下一步</button></div>
        </div>}
      </div> : null}
    </> : null}
  </section>;
}

interface Anchor {
  id: string;
  version: number;
  archivedAt: string | null;
}

export function RelationshipRadarPanel({
  customer,
  matter,
  actorUserId,
  actorRole,
  readonly,
  onDataChanged,
}: {
  customer: Anchor | null;
  matter: (Anchor & { customerId: string }) | null;
  actorUserId: string;
  actorRole: CommandContext['actorRole'];
  readonly: boolean;
  onDataChanged: () => Promise<unknown>;
}) {
  const [state, setState] = useState<RadarLoadState>({ status: 'idle' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [source, setSource] = useState<TodaySourceView | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftScheduledAt, setDraftScheduledAt] = useState(futureLocalDateTime);
  const runSubmission = useRef<StableRelationshipRadarRunSubmission | null>(null);
  const controlSubmission = useRef<{ signature: string; key: string } | null>(null);
  const commitmentSubmission = useRef<{
    signature: string; key: string; command: CommitmentCommand;
  } | null>(null);

  const customerId = customer?.id ?? null;
  const matterId = matter?.id ?? null;
  const matterCustomerId = matter?.customerId ?? null;
  const active = Boolean(customerId && matterId && matterCustomerId === customerId);
  const load = useCallback(async () => {
    if (!customerId || !matterId || matterCustomerId !== customerId) {
      setState({ status: 'idle' });
      return;
    }
    setState({ status: 'loading' });
    setSource(null);
    try {
      const [response, cards, history] = await Promise.all([
        api.relationshipRadar(customerId, matterId),
        api.relationshipRadarJobCards(),
        api.relationshipRadarRuns(customerId, matterId),
      ]);
      setState({ status: 'ready', response, card: cards.items[0] ?? null, runs: history.items });
    } catch (cause) {
      setState({ status: 'error', message: toApiError(cause).message });
    }
  }, [customerId, matterId, matterCustomerId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    runSubmission.current = null;
    controlSubmission.current = null;
    commitmentSubmission.current = null;
    setDraftOpen(false);
    setNotice('');
    setError('');
  }, [customerId, matterId]);

  const card = state.status === 'ready' ? state.card : null;
  const toggleControl = (enabled: boolean) => {
    if (!card || busy || (actorRole !== 'owner' && actorRole !== 'admin')) return;
    const signature = `${card.jobVersion}:${card.controlVersion}:${enabled}`;
    if (controlSubmission.current?.signature !== signature) {
      controlSubmission.current = { signature, key: newIdempotencyKey() };
    }
    setBusy(true); setError(''); setNotice('');
    void api.relationshipRadarControl(enabled, card.controlVersion, controlSubmission.current.key)
      .then(() => {
        controlSubmission.current = null;
        setNotice(enabled ? '关系雷达任务已启用。' : '关系雷达任务已停用。');
        return load();
      })
      .catch((cause) => setError(toApiError(cause).message))
      .finally(() => setBusy(false));
  };

  const run = () => {
    if (!customer || !matter || !card || busy || readonly || actorRole === 'viewer') return;
    let request;
    try {
      request = buildRelationshipRadarRunInput({ job: card, customer, matter });
    } catch (cause) {
      setError(toApiError(cause).message);
      return;
    }
    runSubmission.current = stableRelationshipRadarRunSubmission(request, runSubmission.current, newIdempotencyKey);
    const submission = runSubmission.current;
    setBusy(true); setError(''); setNotice(''); setSource(null);
    void api.relationshipRadarRun(submission.request, submission.idempotencyKey)
      .then((receipt) => {
        if (receipt.run.status !== 'succeeded') throw new Error(receipt.run.failureCode || '关系雷达生成失败');
        runSubmission.current = null;
        setNotice('关系雷达已重新生成。');
        return load();
      })
      .catch((cause) => setError(toApiError(cause).message))
      .finally(() => setBusy(false));
  };

  const openSource = (sourceRef: InterventionSourceRef) => {
    if (!customer || !matter || busy) return;
    setBusy(true); setError(''); setSource(null);
    void api.relationshipRadarSource(customer.id, matter.id, sourceRef)
      .then(setSource)
      .catch((cause) => setError(toApiError(cause).message))
      .finally(() => setBusy(false));
  };

  const openDraft = (draft: RelationshipRadarActionDraft) => {
    if (readonly || actorRole === 'viewer') return;
    setDraftTitle(draft.prefill.title);
    setDraftScheduledAt(futureLocalDateTime());
    commitmentSubmission.current = null;
    setDraftOpen(true);
  };

  const submitDraft = () => {
    if (!customer || !matter || !active || busy || readonly || actorRole === 'viewer') return;
    const instant = new Date(draftScheduledAt);
    if (!Number.isFinite(instant.getTime()) || !draftTitle.trim()) {
      setError('请填写有效的标题和计划时间。');
      return;
    }
    const signature = `${customer.id}:${matter.id}:${actorUserId}:${draftTitle.trim()}:${instant.toISOString()}`;
    if (commitmentSubmission.current?.signature !== signature) {
      commitmentSubmission.current = {
        signature,
        key: newIdempotencyKey(),
        command: {
          type: 'CREATE_COMMITMENT',
          commitment: {
            id: `commitment_${crypto.randomUUID().split('-').join('')}`,
            customerId: customer.id,
            matterId: matter.id,
            personId: null,
            title: draftTitle.trim(),
            kind: 'task',
            ownerUserId: actorUserId,
            confirmationStatus: 'not_required',
            scheduledAtUtc: instant.toISOString(),
            dueAtUtc: null,
            timeZone: browserTimeZone(),
            isAllDay: false,
            localDate: null,
            confirmationDueAtUtc: null,
            source: 'relationship_radar_human_review',
            sourceRef: null,
            hypothesisRef: null,
          },
        },
      };
    }
    const submission = commitmentSubmission.current!;
    setBusy(true); setError(''); setNotice('');
    void api.commitment(submission.command, submission.key)
      .then(async () => {
        commitmentSubmission.current = null;
        setDraftOpen(false);
        await onDataChanged();
        await load();
        setNotice('正式下一步已由人工提交。');
      })
      .catch((cause) => setError(toApiError(cause).message))
      .finally(() => setBusy(false));
  };

  return <RelationshipRadarPanelView
    state={state}
    actorRole={actorRole}
    readonly={readonly || actorRole === 'viewer'}
    busy={busy}
    notice={notice}
    error={error}
    source={source}
    draftOpen={draftOpen}
    draftTitle={draftTitle}
    draftScheduledAt={draftScheduledAt}
    onReload={() => { void load(); }}
    onToggleControl={toggleControl}
    onRun={run}
    onOpenSource={openSource}
    onOpenDraft={openDraft}
    onCloseDraft={() => { commitmentSubmission.current = null; setDraftOpen(false); }}
    onDraftTitle={(value) => { commitmentSubmission.current = null; setDraftTitle(value); }}
    onDraftScheduledAt={(value) => { commitmentSubmission.current = null; setDraftScheduledAt(value); }}
    onSubmitDraft={submitDraft}
  />;
}
