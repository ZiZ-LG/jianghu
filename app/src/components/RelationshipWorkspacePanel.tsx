import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CommandContext,
  CommitmentCommand,
  CrmContextSnapshot,
  RelationshipWorkspaceResponse,
  ReviewHypothesisVerificationCommand,
  SalesHypothesisCommand,
} from '@jianghu/domain-contracts';
import { ApiError, api, newIdempotencyKey, toApiError } from '../api';
import {
  relationshipFreshnessLabel,
  verificationReadinessLabel,
} from '../lib/relationshipWorkspace';
import { CrmRelationshipGraph } from './CrmRelationshipGraph';

type HypothesisProjection = RelationshipWorkspaceResponse['hypotheses'][number];
type VerificationProjection = HypothesisProjection['verificationCommitments'][number];

export type RelationshipWorkspacePanelState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; workspace: RelationshipWorkspaceResponse };

export interface VerificationRevisionDraft {
  claim: string;
  reason: string;
  expectedSignal: string;
  falsificationCondition: string;
  nextReviewAt: string;
}

export type VerificationReviewChoice = 'keep' | 'revise' | 'retire';

export interface RelationshipWorkspacePanelViewProps {
  state: RelationshipWorkspacePanelState;
  readonly: boolean;
  showCandidates: boolean;
  showHypotheses: boolean;
  busy?: boolean;
  notice?: string;
  mutationError?: string;
  onToggleCandidates: () => void;
  onToggleHypotheses: () => void;
  onReload: () => void;
  onCreateVerification: (projection: HypothesisProjection) => void;
  onComplete: (projection: HypothesisProjection, verification: VerificationProjection) => void;
  onRecordResult: (
    projection: HypothesisProjection,
    verification: VerificationProjection,
    result: string,
  ) => void;
  onLinkEvidence?: (
    projection: HypothesisProjection,
    verification: VerificationProjection,
    evidenceId: string,
    direction: 'supporting' | 'contradicting',
  ) => void;
  onReview: (
    projection: HypothesisProjection,
    verification: VerificationProjection,
    choice: VerificationReviewChoice,
    draft: VerificationRevisionDraft,
  ) => void;
}

const assertionLabels = {
  observed: '观察事实',
  reported: '报告信息',
  inferred: '推断候选',
} as const;

function localTime(value: string | null): string {
  if (!value) return '时间未知';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '时间无效';
}

function futureLocalDateTime(days = 7): string {
  const value = new Date(Date.now() + (days * 86_400_000));
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function VerificationRow({
  projection,
  verification,
  readonly,
  busy,
  onComplete,
  onRecordResult,
  onLinkEvidence,
  onReview,
}: {
  projection: HypothesisProjection;
  verification: VerificationProjection;
  readonly: boolean;
  busy: boolean;
  onComplete: RelationshipWorkspacePanelViewProps['onComplete'];
  onRecordResult: RelationshipWorkspacePanelViewProps['onRecordResult'];
  onLinkEvidence?: RelationshipWorkspacePanelViewProps['onLinkEvidence'];
  onReview: RelationshipWorkspacePanelViewProps['onReview'];
}) {
  const { commitment } = verification;
  const [result, setResult] = useState(commitment.completionResult);
  const [evidenceId, setEvidenceId] = useState('');
  const [direction, setDirection] = useState<'supporting' | 'contradicting'>('supporting');
  const [revisionDraft, setRevisionDraft] = useState<VerificationRevisionDraft>(() => ({
    claim: projection.hypothesis.currentRevision.claim,
    reason: projection.hypothesis.currentRevision.reason,
    expectedSignal: projection.hypothesis.currentRevision.expectedSignals[0] ?? '',
    falsificationCondition: projection.hypothesis.currentRevision.falsificationConditions[0] ?? '',
    nextReviewAt: futureLocalDateTime(),
  }));
  const mutable = !readonly && !busy && commitment.verificationReviewDisposition === null;

  return <article className="relationship-verification" data-verification-readiness={verification.readiness}>
    <header>
      <div><strong>{commitment.title}</strong><small>{commitment.executionStatus} · {localTime(commitment.scheduledAtUtc ?? commitment.dueAtUtc)}</small></div>
      <span>{verificationReadinessLabel(verification.readiness)}</span>
    </header>
    {commitment.completionResult ? <p className="relationship-result"><strong>人工结果</strong>{commitment.completionResult}</p> : null}
    {verification.linkedEvidenceIds.length > 0 ? <p className="relationship-evidence-links">
      <strong>已批准证据</strong>{verification.linkedEvidenceIds.join('、')}
    </p> : null}

    {mutable && commitment.executionStatus === 'planned' ? <button
      type="button" className="btn ghost" onClick={() => onComplete(projection, verification)}
    >标记验证完成</button> : null}

    {mutable && verification.readiness === 'awaiting_result_or_evidence' ? <div className="relationship-result-editor">
      <label>人工结果<textarea value={result} maxLength={2_000} onChange={(event) => setResult(event.target.value)} /></label>
      <button type="button" className="btn primary" disabled={!result.trim()} onClick={() => onRecordResult(projection, verification, result)}>记录结果</button>
      {onLinkEvidence ? <div className="relationship-evidence-editor">
        <label>已批准证据 ID<input value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)} /></label>
        <label>方向<select value={direction} onChange={(event) => setDirection(event.target.value as typeof direction)}>
          <option value="supporting">支持</option><option value="contradicting">反证</option>
        </select></label>
        <button type="button" className="btn ghost" disabled={!evidenceId.trim()} onClick={() => onLinkEvidence(projection, verification, evidenceId, direction)}>关联已批准证据</button>
      </div> : null}
    </div> : null}

    {mutable && verification.readiness === 'ready_for_review' ? <div className="relationship-review-editor">
      <label>下次复核时间<input type="datetime-local" value={revisionDraft.nextReviewAt} onChange={(event) => setRevisionDraft({ ...revisionDraft, nextReviewAt: event.target.value })} /></label>
      <div className="relationship-review-actions">
        <button type="button" className="btn ghost" onClick={() => onReview(projection, verification, 'keep', revisionDraft)}>保留假设</button>
        <button type="button" className="btn ghost" onClick={() => onReview(projection, verification, 'retire', revisionDraft)}>退休假设</button>
      </div>
      <details>
        <summary>修订假设</summary>
        <div className="relationship-revision-grid">
          <label>新主张<textarea value={revisionDraft.claim} maxLength={2_000} onChange={(event) => setRevisionDraft({ ...revisionDraft, claim: event.target.value })} /></label>
          <label>理由<textarea value={revisionDraft.reason} maxLength={1_000} onChange={(event) => setRevisionDraft({ ...revisionDraft, reason: event.target.value })} /></label>
          <label>预期信号<input value={revisionDraft.expectedSignal} maxLength={500} onChange={(event) => setRevisionDraft({ ...revisionDraft, expectedSignal: event.target.value })} /></label>
          <label>证伪条件<input value={revisionDraft.falsificationCondition} maxLength={500} onChange={(event) => setRevisionDraft({ ...revisionDraft, falsificationCondition: event.target.value })} /></label>
          <button
            type="button"
            className="btn primary"
            disabled={!revisionDraft.claim.trim() || !revisionDraft.reason.trim() || !revisionDraft.expectedSignal.trim() || !revisionDraft.falsificationCondition.trim()}
            onClick={() => onReview(projection, verification, 'revise', revisionDraft)}
          >确认修订假设</button>
        </div>
      </details>
    </div> : null}
  </article>;
}

export function RelationshipWorkspacePanelView(props: RelationshipWorkspacePanelViewProps) {
  if (props.state.status === 'idle') {
    return <section className="relationship-workspace" data-relationship-workspace="idle">选择事项后查看关系、信息与待验证假设。</section>;
  }
  if (props.state.status === 'loading') {
    return <section className="relationship-workspace" data-relationship-workspace="loading">正在加载关系工作台…</section>;
  }
  if (props.state.status === 'error') {
    return <section className="relationship-workspace" data-relationship-workspace="error" role="alert">
      <p>{props.state.message}</p><button type="button" className="btn ghost" onClick={props.onReload}>重新加载</button>
    </section>;
  }

  const workspace = props.state.workspace;
  const busy = props.busy ?? false;
  return <section className="relationship-workspace" data-relationship-workspace="ready">
    <div className="relationship-workspace-heading">
      <div><span className="eyebrow">关系 · 信息 · 人工假设</span><h2>关系工作台</h2><p>{workspace.customer.name} · {workspace.matter.title}</p></div>
      <div className="relationship-layer-toggles" aria-label="关系叠层">
        <label><input type="checkbox" checked={props.showCandidates && !props.readonly} disabled={props.readonly} onChange={props.onToggleCandidates} />待审候选</label>
        <label><input type="checkbox" checked={props.showHypotheses} onChange={props.onToggleHypotheses} />假设标注</label>
      </div>
    </div>
    <p className="relationship-authority-note">实线是已确认关系；灰色虚线问号仅是候选；点线标注是人工假设。切换显示不会写入正式数据。</p>
    {props.mutationError ? <div className="relationship-message error" role="alert">{props.mutationError}</div> : null}
    {props.notice ? <div className="relationship-message success" role="status">{props.notice}</div> : null}

    <CrmRelationshipGraph
      people={workspace.people}
      formalRelations={workspace.formalRelations}
      candidateRelations={props.readonly ? [] : workspace.candidateRelations}
      hypotheses={workspace.hypotheses}
      showCandidates={props.showCandidates && !props.readonly}
      showHypotheses={props.showHypotheses}
      focusPersonId={workspace.focus?.personId ?? null}
      title="当前事项关系工作台图"
    />

    {!props.readonly && props.showCandidates && workspace.candidateRelations.length > 0 ? <div className="relationship-candidates">
      <h3>待审关系候选</h3>
      {workspace.candidateRelations.map((candidate) => <article key={candidate.candidateId}>
        <strong>{candidate.sourceEndpoint.label} → {candidate.targetEndpoint.label}</strong>
        <span>{candidate.label ?? '关系待确认'} · {Math.round(candidate.confidence * 100)}%</span>
        <blockquote>{candidate.source.quote}</blockquote>
        <small>{candidate.source.title} · {candidate.source.locator} · {localTime(candidate.source.occurredAtUtc)}</small>
      </article>)}
    </div> : null}

    <div className="relationship-workspace-grid">
      <section>
        <h3>事实与信息</h3>
        {workspace.intelligence.length === 0 ? <p className="relationship-empty">暂无当前信息。</p> : workspace.intelligence.map((item) => <article key={item.id} className="relationship-intelligence">
          <div><span>{assertionLabels[item.assertionType]}</span><strong>{Math.round(item.confidence * 100)}%</strong></div>
          <p>{item.statement}</p>
          <small>{item.source.description}{item.source.refId ? ` · ${item.source.refId}` : ''}</small>
          <small>发生 {localTime(item.occurredAt)} · 得知 {localTime(item.learnedAt)}</small>
          <small>{relationshipFreshnessLabel(item, new Date(workspace.generatedAtUtc))}</small>
        </article>)}
      </section>
      <section>
        <h3>当前 Focus</h3>
        {workspace.focus ? <article className="relationship-focus">
          <strong>{workspace.focus.desiredChange}</strong>
          <p>{workspace.focus.rationale}</p>
          <small>信息缺口：{workspace.focus.evidenceGap}</small>
          <small>有效至 {localTime(workspace.focus.validUntil)}</small>
        </article> : <p className="relationship-empty">当前没有经人工确认的 Focus。</p>}
      </section>
    </div>

    <section className="relationship-hypotheses">
      <h3>待验证假设</h3>
      {workspace.hypotheses.length === 0 ? <p className="relationship-empty">当前没有活动假设。</p> : workspace.hypotheses.map((projection) => {
        const hypothesis = projection.hypothesis;
        return <article key={hypothesis.id} className="relationship-hypothesis-card">
          <header><div><strong>{hypothesis.currentRevision.claim}</strong><small>修订 {hypothesis.currentRevision.revisionNumber} · {hypothesis.status}</small></div>
            {!props.readonly ? <button type="button" className="btn ghost" disabled={busy} onClick={() => props.onCreateVerification(projection)}>创建验证承诺</button> : null}
          </header>
          <p>{hypothesis.currentRevision.reason}</p>
          <div className="relationship-hypothesis-checks">
            <div><strong>预期信号</strong><ul>{hypothesis.currentRevision.expectedSignals.map((signal) => <li key={signal}>{signal}</li>)}</ul></div>
            <div><strong>证伪条件</strong><ul>{hypothesis.currentRevision.falsificationConditions.map((condition) => <li key={condition}>{condition}</li>)}</ul></div>
          </div>
          {projection.verificationCommitments.length === 0 ? <p className="relationship-empty">尚未建立验证承诺。</p> : projection.verificationCommitments.map((verification) => <VerificationRow
            key={verification.commitment.id}
            projection={projection}
            verification={verification}
            readonly={props.readonly}
            busy={busy}
            onComplete={props.onComplete}
            onRecordResult={props.onRecordResult}
            onLinkEvidence={props.onLinkEvidence}
            onReview={props.onReview}
          />)}
        </article>;
      })}
    </section>
  </section>;
}

interface StableSubmission {
  signature: string;
  idempotencyKey: string;
  command: unknown;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().split('-').join('')}`;
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function utcFromLocal(value: string): string {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error('请选择有效的下次复核时间');
  return instant.toISOString();
}

export function RelationshipWorkspacePanel({
  crmContext,
  actorUserId,
  actorRole,
  readonly,
  onDataChanged,
}: {
  crmContext: CrmContextSnapshot | null;
  actorUserId: string;
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
  const [state, setState] = useState<RelationshipWorkspacePanelState>({ status: 'idle' });
  const [showCandidates, setShowCandidates] = useState(true);
  const [showHypotheses, setShowHypotheses] = useState(true);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState('');
  const [notice, setNotice] = useState('');
  const submissions = useRef(new Map<string, StableSubmission>());

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

  const reload = useCallback(async () => {
    if (!customerId || !matterId) { setState({ status: 'idle' }); return; }
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', workspace: await api.relationshipWorkspace(customerId, matterId) });
    } catch (cause) {
      setState({ status: 'error', message: toApiError(cause).message });
    }
  }, [customerId, matterId]);

  useEffect(() => { void reload(); }, [reload]);

  const stable = <T,>(slot: string, signature: string, build: () => T): { command: T; idempotencyKey: string } => {
    const current = submissions.current.get(slot);
    if (current?.signature === signature) {
      return { command: current.command as T, idempotencyKey: current.idempotencyKey };
    }
    const next = { signature, idempotencyKey: newIdempotencyKey(), command: build() };
    submissions.current.set(slot, next);
    return { command: next.command as T, idempotencyKey: next.idempotencyKey };
  };

  const mutate = async (slot: string, work: () => Promise<unknown>, success: string) => {
    if (readonly || actorRole === 'viewer' || busy) return;
    setBusy(true); setMutationError(''); setNotice('');
    try {
      await work();
      submissions.current.delete(slot);
      await onDataChanged();
      await reload();
      setNotice(success);
    } catch (cause) {
      const error = toApiError(cause);
      setMutationError(error instanceof ApiError && error.status === 409
        ? `${error.message}；表单内容已保留，请刷新并基于最新版本重试。`
        : error.message);
    } finally {
      setBusy(false);
    }
  };

  const createVerification = (projection: HypothesisProjection) => {
    if (!window.confirm('确认创建一条绑定当前假设修订的验证承诺？')) return;
    const hypothesis = projection.hypothesis;
    const slot = `create:${hypothesis.id}`;
    const signature = `${hypothesis.id}:${hypothesis.currentRevisionId}:${hypothesis.version}`;
    const submission = stable<CommitmentCommand>(slot, signature, () => ({
      type: 'CREATE_COMMITMENT',
      commitment: {
        id: opaqueId('commitment'),
        customerId: hypothesis.customerId,
        matterId: hypothesis.matterId,
        personId: hypothesis.personId,
        title: `验证：${hypothesis.currentRevision.claim}`.slice(0, 200),
        kind: 'verification',
        ownerUserId: actorUserId,
        confirmationStatus: 'not_required',
        scheduledAtUtc: new Date(Date.now() + 86_400_000).toISOString(),
        dueAtUtc: null,
        timeZone: browserTimeZone(),
        isAllDay: false,
        localDate: null,
        confirmationDueAtUtc: null,
        source: 'manual_relationship_workspace',
        sourceRef: null,
        hypothesisRef: { hypothesisId: hypothesis.id, hypothesisRevisionId: hypothesis.currentRevisionId },
      },
    }));
    void mutate(slot, () => api.commitment(submission.command, submission.idempotencyKey), '验证承诺已创建。');
  };

  const complete = (projection: HypothesisProjection, verification: VerificationProjection) => {
    if (!window.confirm('确认这条验证承诺已完成？完成本身不会改变假设。')) return;
    const item = verification.commitment;
    const slot = `complete:${item.id}`;
    const signature = `${item.id}:${item.version}:${item.scheduleVersion}`;
    const submission = stable<CommitmentCommand>(slot, signature, () => ({
      type: 'COMPLETE_COMMITMENT', customerId: projection.hypothesis.customerId,
      commitmentId: item.id, baseVersion: item.version, expectedScheduleVersion: item.scheduleVersion,
      completedAtUtc: new Date().toISOString(),
    }));
    void mutate(slot, () => api.commitment(submission.command, submission.idempotencyKey), '验证承诺已完成；请补充结果或关联已批准证据。');
  };

  const recordResult = (projection: HypothesisProjection, verification: VerificationProjection, result: string) => {
    if (!window.confirm('确认保存这份人工验证结果？')) return;
    const item = verification.commitment;
    const trimmed = result.trim();
    const slot = `result:${item.id}`;
    const signature = `${item.id}:${item.version}:${item.scheduleVersion}:${trimmed}`;
    const submission = stable<CommitmentCommand>(slot, signature, () => ({
      type: 'RECORD_COMMITMENT_RESULT', customerId: projection.hypothesis.customerId,
      commitmentId: item.id, baseVersion: item.version, expectedScheduleVersion: item.scheduleVersion,
      result: trimmed,
    }));
    void mutate(slot, () => api.commitment(submission.command, submission.idempotencyKey), '人工验证结果已记录，可进入复核。');
  };

  const linkEvidence = (
    projection: HypothesisProjection,
    verification: VerificationProjection,
    evidenceId: string,
    direction: 'supporting' | 'contradicting',
  ) => {
    if (!window.confirm('确认将这条已批准证据绑定到本次验证？')) return;
    const hypothesis = projection.hypothesis;
    const trimmed = evidenceId.trim();
    const slot = `evidence:${verification.commitment.id}`;
    const signature = `${hypothesis.id}:${hypothesis.version}:${hypothesis.currentRevisionId}:${verification.commitment.id}:${trimmed}:${direction}`;
    const submission = stable<SalesHypothesisCommand>(slot, signature, () => ({
      type: 'LINK_HYPOTHESIS_EVIDENCE',
      link: {
        id: opaqueId('hypothesisevidence'), salesHypothesisId: hypothesis.id,
        expectedVersion: hypothesis.version, expectedCurrentRevisionId: hypothesis.currentRevisionId,
        evidenceId: trimmed, evidenceVersion: 0, direction,
        verificationCommitmentId: verification.commitment.id,
      },
    }));
    void mutate(slot, () => api.salesHypothesisCommand(submission.command, submission.idempotencyKey), '已批准证据已绑定，可进入复核。');
  };

  const review = (
    projection: HypothesisProjection,
    verification: VerificationProjection,
    choice: VerificationReviewChoice,
    draft: VerificationRevisionDraft,
  ) => {
    if (!window.confirm(`确认${choice === 'keep' ? '保留' : choice === 'revise' ? '修订' : '退休'}这条假设？`)) return;
    const hypothesis = projection.hypothesis;
    const item = verification.commitment;
    const slot = `review:${item.id}`;
    const draftSignature = choice === 'retire' ? '' : JSON.stringify(draft);
    const signature = `${choice}:${item.id}:${item.version}:${hypothesis.version}:${hypothesis.currentRevisionId}:${draftSignature}`;
    const common = {
      type: 'REVIEW_HYPOTHESIS_VERIFICATION' as const,
      customerId: hypothesis.customerId, matterId: hypothesis.matterId,
      commitmentId: item.id, expectedCommitmentVersion: item.version,
      expectedCommitmentScheduleVersion: item.scheduleVersion,
      salesHypothesisId: hypothesis.id, expectedHypothesisVersion: hypothesis.version,
      expectedCurrentRevisionId: hypothesis.currentRevisionId,
    };
    const submission = stable<ReviewHypothesisVerificationCommand>(slot, signature, () => {
      if (choice === 'retire') return { ...common, disposition: 'retire' };
      const nextReviewAt = utcFromLocal(draft.nextReviewAt);
      if (choice === 'keep') return {
        ...common, disposition: 'keep', ownerUserId: hypothesis.ownerUserId ?? actorUserId, nextReviewAt,
      };
      return {
        ...common,
        disposition: 'revise',
        nextReviewAt,
        revision: {
          id: opaqueId('hypothesisrevision'),
          claim: draft.claim.trim(), reason: draft.reason.trim(),
          expectedSignals: [draft.expectedSignal.trim()],
          falsificationConditions: [draft.falsificationCondition.trim()],
        },
      };
    });
    void mutate(slot, () => api.reviewHypothesisVerification(submission.command, submission.idempotencyKey), '人工复核已完成。');
  };

  return <div className="relationship-workspace-shell">
    <div className="relationship-selector">
      <label>客户<select value={customerId} disabled={busy} onChange={(event) => { setCustomerId(event.target.value); setMatterId(''); }}>
        <option value="">选择客户</option>
        {activeCustomers.map((customer) => <option key={customer.id} value={customer.id}>{customer.name}</option>)}
      </select></label>
      <label>事项<select value={matterId} disabled={busy || !customerId} onChange={(event) => setMatterId(event.target.value)}>
        <option value="">选择事项</option>
        {matters.map((matter) => <option key={matter.id} value={matter.id}>{matter.title}</option>)}
      </select></label>
    </div>
    <RelationshipWorkspacePanelView
      state={state}
      readonly={readonly || actorRole === 'viewer'}
      showCandidates={showCandidates}
      showHypotheses={showHypotheses}
      busy={busy}
      notice={notice}
      mutationError={mutationError}
      onToggleCandidates={() => setShowCandidates((current) => !current)}
      onToggleHypotheses={() => setShowHypotheses((current) => !current)}
      onReload={() => { void reload(); }}
      onCreateVerification={createVerification}
      onComplete={complete}
      onRecordResult={recordResult}
      onLinkEvidence={linkEvidence}
      onReview={review}
    />
  </div>;
}
