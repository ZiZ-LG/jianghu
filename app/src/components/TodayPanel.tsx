import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type {
  InterventionItem,
  InterventionSourceRef,
  TodayReadModel,
  TodaySourceView,
} from '@jianghu/domain-contracts';
import { api, toApiError } from '../api';
import {
  availableTodayCommitmentActions,
  buildTodayCommitmentActionDraft,
  saveAndRefreshTodayCommitmentActionDraft,
  type BuildTodayCommitmentActionInput,
  type TodayCommitmentAction,
  type TodayCommitmentActionDraft,
} from '../lib/commitmentActions';
import { CommitmentActionEditor } from './CommitmentActionEditor';

export type TodayPanelState =
  | { status: 'loading' }
  | { status: 'ready'; model: TodayReadModel }
  | { status: 'error'; message: string };

function sourceLabel(source: InterventionSourceRef): string {
  return `${source.entityId} · v${source.version}${source.scheduleVersion === null ? '' : ` · schedule ${source.scheduleVersion}`}`;
}

const reasonLabels: Record<string, string> = {
  confirmation_due: '需要确认',
  commitment_due: '跟进时间已到',
  matter_without_next_commitment: '事项缺少下一步',
  commitment_completed: '今天已完成',
};

const sourceKindLabels: Record<string, string> = {
  commitment: '下一步',
  matter: '事项',
  customer: '客户',
  account: '客户',
};

function reasonLabel(item: InterventionItem): string {
  if (item.reasonCode === 'commitment_due' && item.time.relation === 'upcoming') return '明日跟进';
  return reasonLabels[item.reasonCode] ?? '需要关注';
}

const instantFormatters = new Map<string, Intl.DateTimeFormat>();
export const TODAY_REFRESH_INTERVAL_MS = 60_000;

function displayInstant(value: string, timeZone?: string): string {
  try {
    const key = timeZone ?? 'browser-local';
    let formatter = instantFormatters.get(key);
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'medium',
        timeStyle: 'short',
        ...(timeZone ? { timeZone } : {}),
      });
      instantFormatters.set(key, formatter);
    }
    return formatter.format(new Date(value));
  } catch {
    return value;
  }
}

function InterventionCard({
  item,
  readonly,
  onAction,
  onOpenSource,
}: {
  item: InterventionItem;
  readonly: boolean;
  onAction?: (item: InterventionItem, action: TodayCommitmentAction, origin: HTMLButtonElement) => void;
  onOpenSource: (source: InterventionSourceRef) => void;
}) {
  const headingId = useId();
  const itemTimeZone = 'timeZone' in item.time ? item.time.timeZone : undefined;
  const actions = readonly ? [] : availableTodayCommitmentActions(item);
  return (
    <article
      className="today-item"
      data-today-item={item.id}
      data-reason-code={item.reasonCode}
      aria-labelledby={headingId}
    >
      <header className="today-item-header">
        <div>
          <h3 id={headingId}>{item.title}</h3>
          <span>{item.context.customerName}{item.context.matterName ? ` · ${item.context.matterName}` : ''}</span>
        </div>
        <span className={`today-time ${item.time.relation}`}>{item.time.label}</span>
      </header>
      <details className="today-explanation">
        <summary>为什么现在</summary>
        <p>{item.explanation}</p>
        <dl>
          <div><dt>原因</dt><dd>{reasonLabel(item)}</dd></div>
          <div><dt>观察时间</dt><dd><time dateTime={item.observedAtUtc}>{displayInstant(item.observedAtUtc, itemTimeZone)}</time></dd></div>
        </dl>
        <div className="today-sources">
          <strong>来源</strong>
          <ul>
            {item.sourceRefs.map((source) => (
              <li key={`${source.entityKind}:${source.entityId}:${source.version}:${source.scheduleVersion ?? 'none'}`}>
                <button
                  type="button"
                  className="today-source-button"
                  data-today-source={source.entityKind}
                  data-source-id={source.entityId}
                  data-source-version={source.version}
                  data-source-schedule-version={source.scheduleVersion ?? undefined}
                  onClick={() => onOpenSource(source)}
                >
                  <span>{sourceKindLabels[source.entityKind] ?? '正式来源'}</span>
                  <span>查看当前来源</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <details className="today-technical-details">
          <summary>技术详情</summary>
          <dl>
            <div><dt>规则</dt><dd>{item.ruleVersion}</dd></div>
            <div><dt>原因代码</dt><dd>{item.reasonCode}</dd></div>
            {item.sourceRefs.map((source) => (
              <div key={`technical:${source.entityKind}:${source.entityId}:${source.version}:${source.scheduleVersion ?? 'none'}`}>
                <dt>{source.entityKind}</dt><dd>{sourceLabel(source)}</dd>
              </div>
            ))}
          </dl>
        </details>
      </details>
      <div className="today-suggestion">
        <span>建议：{item.suggestedAction.label}</span>
        {actions.length > 0 && onAction ? (
          <div className="today-action-list" role="group" aria-label={`${item.title} 可执行操作`}>
            {actions.map((action) => (
              <button
                key={action.kind}
                type="button"
                className={`btn sm ${action.danger ? 'ghost danger-text' : 'ghost'}`}
                data-today-action={action.kind}
                data-today-command={action.commandType}
                onClick={(event) => onAction(item, action, event.currentTarget)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function TodayView({
  model,
  readonly = false,
  onAction,
  onOpenSource,
}: {
  model: TodayReadModel;
  readonly?: boolean;
  onAction?: (item: InterventionItem, action: TodayCommitmentAction, origin: HTMLButtonElement) => void;
  onOpenSource: (source: InterventionSourceRef) => void;
}) {
  return (
    <div className="today-read-model" data-today-state="ready">
      <p className="today-generated-at">
        根据当前权限实时生成 · <time dateTime={model.generatedAtUtc}>{displayInstant(model.generatedAtUtc)}</time>
      </p>
      <div className="today-sections">
        {model.sections.map((section) => {
          const headingId = `today-section-${section.key}`;
          return (
            <section
              key={section.key}
              className="today-section"
              data-today-section={section.key}
              aria-labelledby={headingId}
            >
              <header className="today-section-header">
                <h2 id={headingId}>{section.label}</h2>
                <span aria-label={`${section.items.length} 项`}>{section.items.length}</span>
              </header>
              {section.items.length === 0 ? (
                <p className="today-section-empty">本段暂时没有项目</p>
              ) : (
                <div className="today-items">
                  {section.items.map((item) => (
                    <InterventionCard
                      key={item.id}
                      item={item}
                      readonly={readonly}
                      onAction={onAction}
                      onOpenSource={onOpenSource}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function TodayPanelStateView({
  state,
  readonly = false,
  onAction,
  onRetry,
  onOpenSource,
}: {
  state: TodayPanelState;
  readonly?: boolean;
  onAction?: (item: InterventionItem, action: TodayCommitmentAction, origin: HTMLButtonElement) => void;
  onRetry: () => void;
  onOpenSource: (source: InterventionSourceRef) => void;
}) {
  if (state.status === 'loading') {
    return (
      <div className="today-panel-state" data-today-state="loading" aria-busy="true" role="status" aria-live="polite">
        正在整理今天需要处理的事项…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="today-panel-state error" data-today-state="error" role="alert">
        <p>{state.message}</p>
        <button type="button" className="btn sm" onClick={onRetry}>重新加载</button>
      </div>
    );
  }
  return (
    <TodayView
      model={state.model}
      readonly={readonly}
      onAction={onAction}
      onOpenSource={onOpenSource}
    />
  );
}

type TodaySourceState =
  | { status: 'idle' }
  | { status: 'loading'; sourceRef: InterventionSourceRef }
  | { status: 'ready'; source: TodaySourceView }
  | { status: 'error'; message: string };

function TodaySourceInspector({ state, onClose }: { state: TodaySourceState; onClose: () => void }) {
  const inspectorRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state.status !== 'idle') inspectorRef.current?.focus();
  }, [state.status]);
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return (
      <aside ref={inspectorRef} tabIndex={-1} className="today-source-inspector" role="status" aria-live="polite">
        正在核验当前来源…
      </aside>
    );
  }
  if (state.status === 'error') {
    return (
      <aside ref={inspectorRef} tabIndex={-1} className="today-source-inspector error" role="alert">
        <p>{state.message}</p>
        <button type="button" className="btn ghost" onClick={onClose}>关闭</button>
      </aside>
    );
  }
  return (
    <aside ref={inspectorRef} tabIndex={-1} className="today-source-inspector" aria-label="来源详情" aria-live="polite">
      <div>
        <strong>{sourceKindLabels[state.source.sourceRef.entityKind] ?? '正式来源'} · {state.source.label}</strong>
        <span>{state.source.detail}</span>
        <small>{sourceLabel(state.source.sourceRef)}</small>
      </div>
      <button type="button" className="btn ghost" onClick={onClose}>关闭</button>
    </aside>
  );
}

type ActiveTodayAction = {
  item: InterventionItem;
  action: TodayCommitmentAction;
  origin: HTMLButtonElement;
  draft?: TodayCommitmentActionDraft;
};

function containsExactRevision(model: TodayReadModel, item: InterventionItem): boolean {
  return model.sections.some((section) => section.items.some((candidate) => (
    candidate.target.entityKind === item.target.entityKind
    && candidate.target.entityId === item.target.entityId
    && candidate.target.version === item.target.version
    && candidate.target.scheduleVersion === item.target.scheduleVersion
  )));
}

export function TodayPanel({
  actorUserId,
  readonly,
  onDataChanged,
}: {
  actorUserId: string;
  readonly: boolean;
  onDataChanged: () => Promise<unknown>;
}) {
  const [state, setState] = useState<TodayPanelState>({ status: 'loading' });
  const [sourceState, setSourceState] = useState<TodaySourceState>({ status: 'idle' });
  const [activeAction, setActiveAction] = useState<ActiveTodayAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeActionRef = useRef<ActiveTodayAction | null>(null);
  const savingRef = useRef(false);
  const sourceRequest = useRef(0);
  const todayRequest = useRef(0);
  const onDataChangedRef = useRef(onDataChanged);

  useEffect(() => {
    onDataChangedRef.current = onDataChanged;
  }, [onDataChanged]);

  const closeAction = useCallback((notice?: string) => {
    const origin = activeActionRef.current?.origin ?? null;
    activeActionRef.current = null;
    setActiveAction(null);
    setActionError(null);
    if (notice !== undefined) setActionNotice(notice);
    queueMicrotask(() => {
      const focusTarget = origin?.isConnected ? origin : panelRef.current;
      focusTarget?.focus();
    });
  }, []);

  const loadToday = useCallback(async ({
    invalidateActive = true,
    showLoading = false,
  }: {
    invalidateActive?: boolean;
    showLoading?: boolean;
  } = {}) => {
    const request = todayRequest.current + 1;
    todayRequest.current = request;
    if (showLoading) setState({ status: 'loading' });
    try {
      const model = await api.today();
      if (todayRequest.current !== request) return model;
      setState({ status: 'ready', model });
      const active = activeActionRef.current;
      if (invalidateActive && active && !savingRef.current && !containsExactRevision(model, active.item)) {
        closeAction('记录已更新，请重新选择操作');
      }
      return model;
    } catch (cause) {
      if (todayRequest.current === request) {
        setState({ status: 'error', message: toApiError(cause).message });
      }
      throw cause;
    }
  }, [closeAction]);

  useEffect(() => {
    void loadToday({ invalidateActive: false }).catch(() => undefined);
    return () => { todayRequest.current += 1; };
  }, [loadToday]);

  useEffect(() => {
    const refresh = () => {
      sourceRequest.current += 1;
      setSourceState({ status: 'idle' });
      void loadToday().catch(() => undefined);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, TODAY_REFRESH_INTERVAL_MS);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [loadToday]);

  useEffect(() => () => {
    sourceRequest.current += 1;
  }, []);

  useEffect(() => {
    if (readonly && activeActionRef.current) closeAction();
  }, [closeAction, readonly]);

  const openSource = (sourceRef: InterventionSourceRef) => {
    const request = sourceRequest.current + 1;
    sourceRequest.current = request;
    setSourceState({ status: 'loading', sourceRef });
    void api.todaySource(sourceRef).then(
      (source) => { if (sourceRequest.current === request) setSourceState({ status: 'ready', source }); },
      (cause) => {
        if (sourceRequest.current === request) {
          setSourceState({ status: 'error', message: toApiError(cause).message });
        }
      },
    );
  };

  const openAction = (
    item: InterventionItem,
    action: TodayCommitmentAction,
    origin: HTMLButtonElement,
  ) => {
    const next = { item, action, origin };
    activeActionRef.current = next;
    setActiveAction(next);
    setActionError(null);
    setActionNotice(null);
  };

  const discardFailedDraft = () => {
    const current = activeActionRef.current;
    if (current?.draft) {
      const next = { item: current.item, action: current.action, origin: current.origin };
      activeActionRef.current = next;
      setActiveAction(next);
    }
    setActionError(null);
  };

  const submitAction = (input: BuildTodayCommitmentActionInput) => {
    const current = activeActionRef.current;
    if (!current || savingRef.current) return;
    if (input.item.id !== current.item.id || input.kind !== current.action.kind) {
      setActionError('当前操作与提醒不匹配，请关闭后重新选择');
      return;
    }
    let draft = current.draft;
    try {
      if (!draft) {
        draft = buildTodayCommitmentActionDraft(input);
        const next = { ...current, draft };
        activeActionRef.current = next;
        setActiveAction(next);
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '操作内容无效，请检查后重试');
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setActionError(null);
    void saveAndRefreshTodayCommitmentActionDraft(
      draft,
      api.commitment,
      () => loadToday({ invalidateActive: false }),
      () => Promise.resolve(onDataChangedRef.current()),
    ).then((result) => {
      const fullyRefreshed = result.todayRefreshed && result.stateRefreshed;
      closeAction(fullyRefreshed
        ? `${draft!.action.label}已保存。`
        : `${draft!.action.label}已保存，但部分页面刷新失败，请手动刷新。`);
    }).catch((cause) => {
      const error = toApiError(cause);
      setActionError(error.message);
      if (error.status === 409) {
        void loadToday().then(() => {
          if (!activeActionRef.current) setActionNotice(error.message);
        }).catch(() => {
          setActionNotice(`${error.message}；刷新失败，请手动重试。`);
        });
      }
    }).finally(() => {
      savingRef.current = false;
      setSaving(false);
    });
  };

  return (
    <div
      ref={panelRef}
      className="today-panel"
      data-today-readonly={readonly}
      tabIndex={-1}
    >
      {actionNotice ? <p className="today-action-notice" role="status" aria-live="polite">{actionNotice}</p> : null}
      <TodayPanelStateView
        state={state}
        readonly={readonly}
        onAction={openAction}
        onRetry={() => {
          sourceRequest.current += 1;
          setSourceState({ status: 'idle' });
          void loadToday({ showLoading: true }).catch(() => undefined);
        }}
        onOpenSource={openSource}
      />
      {activeAction ? (
        <CommitmentActionEditor
          key={`${activeAction.item.id}:${activeAction.action.kind}`}
          item={activeAction.item}
          action={activeAction.action}
          actorUserId={actorUserId}
          saving={saving}
          error={actionError}
          onCancel={() => closeAction()}
          onInputChanged={discardFailedDraft}
          onSubmit={submitAction}
        />
      ) : null}
      <TodaySourceInspector
        state={sourceState}
        onClose={() => {
          sourceRequest.current += 1;
          setSourceState({ status: 'idle' });
        }}
      />
    </div>
  );
}
