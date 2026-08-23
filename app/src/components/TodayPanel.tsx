import { useEffect, useId, useRef, useState } from 'react';
import type {
  InterventionItem,
  InterventionSourceRef,
  TodayReadModel,
  TodaySourceView,
} from '@jianghu/domain-contracts';
import { api, toApiError } from '../api';

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
  onOpenSource,
}: {
  item: InterventionItem;
  onOpenSource: (source: InterventionSourceRef) => void;
}) {
  const headingId = useId();
  const itemTimeZone = 'timeZone' in item.time ? item.time.timeZone : undefined;
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
      </div>
    </article>
  );
}

export function TodayView({
  model,
  onOpenSource,
}: {
  model: TodayReadModel;
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
  onRetry,
  onOpenSource,
}: {
  state: TodayPanelState;
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

export function TodayPanel() {
  const [state, setState] = useState<TodayPanelState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [sourceState, setSourceState] = useState<TodaySourceState>({ status: 'idle' });
  const sourceRequest = useRef(0);

  useEffect(() => {
    let current = true;
    void api.today().then(
      (model) => { if (current) setState({ status: 'ready', model }); },
      (cause) => { if (current) setState({ status: 'error', message: toApiError(cause).message }); },
    );
    return () => { current = false; };
  }, [attempt]);

  useEffect(() => {
    const refresh = () => {
      sourceRequest.current += 1;
      setSourceState({ status: 'idle' });
      setAttempt((value) => value + 1);
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
  }, []);

  useEffect(() => () => {
    sourceRequest.current += 1;
  }, []);

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

  return (
    <>
      <TodayPanelStateView
        state={state}
        onRetry={() => {
          sourceRequest.current += 1;
          setSourceState({ status: 'idle' });
          setState({ status: 'loading' });
          setAttempt((value) => value + 1);
        }}
        onOpenSource={openSource}
      />
      <TodaySourceInspector
        state={sourceState}
        onClose={() => {
          sourceRequest.current += 1;
          setSourceState({ status: 'idle' });
        }}
      />
    </>
  );
}
