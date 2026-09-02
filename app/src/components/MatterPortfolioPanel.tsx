import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MatterPortfolioSourceProviderSchema,
  type InterventionItem,
  type InterventionSourceRef,
  type InterventionSuggestedAction,
  type MatterPortfolioEntry,
  type MatterPortfolioReadModel,
  type TodaySourceView,
} from '@jianghu/domain-contracts';
import { api } from '../api';
import { matterPortfolioErrorMessage } from '../lib/matterPortfolio';

export type MatterPortfolioPanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      model: MatterPortfolioReadModel;
      refreshing: boolean;
      refreshError: string | null;
    };

export type MatterPortfolioSourceState =
  | { status: 'idle' }
  | { status: 'loading'; sourceRef: InterventionSourceRef }
  | { status: 'error'; message: string }
  | { status: 'ready'; source: TodaySourceView };

const attentionLabels = {
  urgent: '立即处理',
  next_step: '补齐下一步',
  relationship: '关系缺口',
  intelligence: '信息陈旧',
  hypothesis: '假设待验证',
  manual: '手动优先级',
  clear: '暂无缺口',
} as const;

function sourceLabel(source: InterventionSourceRef): string {
  return `${source.entityKind} · ${source.entityId} · v${source.version}${source.scheduleVersion === null ? '' : ` · schedule ${source.scheduleVersion}`}`;
}

function itemTimeValue(item: InterventionItem): string {
  return item.time.kind === 'local_date' ? item.time.localDate : item.time.atUtc;
}

export function matterPortfolioActionPath(action: InterventionSuggestedAction): '/quick-capture' | '/sales' {
  return action.commandType === 'CREATE_COMMITMENT' ? '/quick-capture' : '/sales';
}

function SourceInspector({
  state,
  onClose,
}: {
  state: MatterPortfolioSourceState;
  onClose: () => void;
}) {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return (
      <aside className="matter-portfolio-source" role="status">
        <span>正在核对当前权限与来源版本…</span>
      </aside>
    );
  }
  if (state.status === 'error') {
    return (
      <aside className="matter-portfolio-source error" role="alert">
        <span>{state.message}</span>
        <button type="button" className="btn ghost sm" onClick={onClose}>关闭</button>
      </aside>
    );
  }
  return (
    <aside
      className="matter-portfolio-source"
      aria-label="事项组合来源详情"
      data-matter-portfolio-source={state.source.sourceRef.entityKind}
    >
      <div>
        <strong>{state.source.label}</strong>
        <span>{state.source.detail}</span>
        <small>{sourceLabel(state.source.sourceRef)}</small>
      </div>
      <button type="button" className="btn ghost sm" onClick={onClose}>关闭</button>
    </aside>
  );
}

function PortfolioItem({
  entry,
  item,
  onOpenSource,
}: {
  entry: MatterPortfolioEntry;
  item: InterventionItem;
  onOpenSource: (entry: MatterPortfolioEntry, item: InterventionItem, source: InterventionSourceRef) => void;
}) {
  const timeValue = itemTimeValue(item);
  return (
    <li className="matter-portfolio-attention-item" data-portfolio-item={item.id}>
      <header>
        <div><strong>{item.title}</strong><span>{item.time.label}</span></div>
        <time dateTime={timeValue}>{timeValue}</time>
      </header>
      <div className="matter-portfolio-why">
        <strong>为什么现在</strong>
        <p>{item.explanation}</p>
      </div>
      <dl className="matter-portfolio-evidence">
        <div><dt>规则</dt><dd>{item.ruleVersion}</dd></div>
        <div><dt>观测时间</dt><dd><time dateTime={item.observedAtUtc}>{item.observedAtUtc}</time></dd></div>
        <div><dt>建议</dt><dd>{item.suggestedAction.label}</dd></div>
      </dl>
      <div className="matter-portfolio-sources">
        <strong>正式来源</strong>
        {item.sourceRefs.map((source) => (
          <button
            key={`${source.entityKind}:${source.entityId}:${source.version}:${source.scheduleVersion ?? 'none'}`}
            type="button"
            className="matter-portfolio-source-button"
            data-portfolio-source-id={source.entityId}
            onClick={() => onOpenSource(entry, item, source)}
          >
            <span>{sourceLabel(source)}</span><span>核对 ›</span>
          </button>
        ))}
      </div>
    </li>
  );
}

function PortfolioEntry({
  entry,
  readonly,
  onOpenSource,
  onOpenAction,
}: {
  entry: MatterPortfolioEntry;
  readonly: boolean;
  onOpenSource: (entry: MatterPortfolioEntry, item: InterventionItem, source: InterventionSourceRef) => void;
  onOpenAction: (entry: MatterPortfolioEntry) => void;
}) {
  return (
    <article className="matter-portfolio-entry" data-attention-bucket={entry.attentionBucket}>
      <header className="matter-portfolio-entry-header">
        <div>
          <span>{entry.customer.name}</span>
          <h2>{entry.matter.title}</h2>
        </div>
        <span className={`matter-portfolio-bucket ${entry.attentionBucket}`}>
          {attentionLabels[entry.attentionBucket]}
        </span>
      </header>

      <dl className="matter-portfolio-summary">
        <div><dt>当前方法论阶段</dt><dd>{entry.methodologyStage?.stageName ?? '未配置'}</dd></div>
        <div><dt>事项优先级</dt><dd>{entry.matter.priority ?? '未设置'}</dd></div>
      </dl>

      {entry.salesEstimate ? (
        <section className="matter-portfolio-sales" aria-label="销售录入估算">
          <strong>销售录入估算</strong>
          <span>预期金额 {entry.salesEstimate.expectedAmountW} 万元</span>
          <span>主观胜率 {entry.salesEstimate.winProbability}%</span>
          <span>预期签约 {entry.salesEstimate.expectedSignDate ?? '未设置'}</span>
          <small>仅展示人工录入值，不代表预测、已签收入或概率加权金额。</small>
        </section>
      ) : null}

      {entry.attentionItems.length === 0 ? (
        <p className="matter-portfolio-clear">当前没有可验证的注意缺口。</p>
      ) : (
        <ul className="matter-portfolio-attention-list">
          {entry.attentionItems.map((item) => (
            <PortfolioItem key={item.id} entry={entry} item={item} onOpenSource={onOpenSource} />
          ))}
        </ul>
      )}

      {entry.actionDraft ? (
        <section className="matter-portfolio-draft" data-portfolio-draft="uncommitted">
          <div>
            <strong>未提交行动草稿</strong>
            <span>{entry.actionDraft.suggestedAction.label}</span>
            <small>仅为当前来源版本的导航提示，尚未写入正式记录。</small>
          </div>
          {readonly ? (
            <span className="matter-portfolio-readonly">只读视图不提供草稿操作</span>
          ) : (
            <button
              type="button"
              className="btn primary"
              data-matter-portfolio-action="true"
              onClick={() => onOpenAction(entry)}
            >{entry.actionDraft.suggestedAction.label}</button>
          )}
        </section>
      ) : null}
    </article>
  );
}

export function MatterPortfolioPanelStateView({
  state,
  sourceState,
  readonly,
  onRetry,
  onOpenSource,
  onOpenAction,
  onCloseSource,
}: {
  state: MatterPortfolioPanelState;
  sourceState: MatterPortfolioSourceState;
  readonly: boolean;
  onRetry: () => void;
  onOpenSource: (entry: MatterPortfolioEntry, item: InterventionItem, source: InterventionSourceRef) => void;
  onOpenAction: (entry: MatterPortfolioEntry) => void;
  onCloseSource: () => void;
}) {
  if (state.status === 'loading') {
    return <div className="matter-portfolio-state" data-matter-portfolio="loading">正在组合当前权限范围内的事项…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="matter-portfolio-state error" data-matter-portfolio="error" role="alert">
        <p>{state.message}</p>
        <button type="button" className="btn primary" onClick={onRetry}>重新加载</button>
      </div>
    );
  }
  return (
    <div className="matter-portfolio" data-matter-portfolio="ready" data-matter-portfolio-readonly={readonly}>
      <header className="matter-portfolio-toolbar">
        <div>
          <strong>{state.model.entries.length} 个可见进行中事项</strong>
          <span>按可解释的注意类别排序，无隐藏总分</span>
        </div>
        <button type="button" className="btn ghost sm" disabled={state.refreshing} onClick={onRetry}>
          {state.refreshing ? '正在刷新…' : '刷新组合'}
        </button>
      </header>
      {state.refreshError ? <p className="matter-portfolio-refresh-error" role="status">{state.refreshError}</p> : null}
      {state.model.entries.length === 0 ? (
        <div className="matter-portfolio-empty">当前没有可见的进行中事项。</div>
      ) : (
        <div className="matter-portfolio-entries">
          {state.model.entries.map((entry) => (
            <PortfolioEntry
              key={entry.matter.id}
              entry={entry}
              readonly={readonly}
              onOpenSource={onOpenSource}
              onOpenAction={onOpenAction}
            />
          ))}
        </div>
      )}
      <SourceInspector state={sourceState} onClose={onCloseSource} />
      <footer className="matter-portfolio-generated">
        组合时间 <time dateTime={state.model.generatedAtUtc}>{state.model.generatedAtUtc}</time>
        <span>规则 {state.model.ruleVersion}</span>
      </footer>
    </div>
  );
}

export function MatterPortfolioPanel({
  readonly,
  onNavigate,
}: {
  readonly: boolean;
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<MatterPortfolioPanelState>({ status: 'loading' });
  const [sourceState, setSourceState] = useState<MatterPortfolioSourceState>({ status: 'idle' });
  const portfolioRequest = useRef(0);
  const sourceRequest = useRef(0);

  const load = useCallback(() => {
    const request = portfolioRequest.current + 1;
    portfolioRequest.current = request;
    sourceRequest.current += 1;
    setSourceState({ status: 'idle' });
    setState((current) => current.status === 'ready'
      ? { ...current, refreshing: true, refreshError: null }
      : { status: 'loading' });
    void api.matterPortfolio().then(
      (model) => {
        if (portfolioRequest.current === request) {
          setState({ status: 'ready', model, refreshing: false, refreshError: null });
        }
      },
      (cause) => {
        if (portfolioRequest.current !== request) return;
        const message = matterPortfolioErrorMessage(cause);
        setState((current) => current.status === 'ready'
          ? { ...current, refreshing: false, refreshError: message }
          : { status: 'error', message });
      },
    );
  }, []);

  useEffect(() => {
    load();
    return () => {
      portfolioRequest.current += 1;
      sourceRequest.current += 1;
    };
  }, [load]);

  const openSource = (
    entry: MatterPortfolioEntry,
    item: InterventionItem,
    sourceRef: InterventionSourceRef,
  ) => {
    const provider = MatterPortfolioSourceProviderSchema.safeParse(item.providerKey);
    if (!provider.success) {
      setSourceState({ status: 'error', message: '来源类型无法验证，请刷新事项组合。' });
      return;
    }
    const request = sourceRequest.current + 1;
    sourceRequest.current = request;
    setSourceState({ status: 'loading', sourceRef });
    void api.matterPortfolioSource({
      providerKey: provider.data,
      customerId: entry.customer.id,
      matterId: entry.matter.id,
      sourceRef,
    }).then(
      (source) => {
        if (sourceRequest.current === request) setSourceState({ status: 'ready', source });
      },
      (cause) => {
        if (sourceRequest.current === request) {
          setSourceState({ status: 'error', message: matterPortfolioErrorMessage(cause) });
        }
      },
    );
  };

  return (
    <MatterPortfolioPanelStateView
      state={state}
      sourceState={sourceState}
      readonly={readonly}
      onRetry={load}
      onOpenSource={openSource}
      onOpenAction={(entry) => {
        if (!readonly && entry.actionDraft) {
          onNavigate(matterPortfolioActionPath(entry.actionDraft.suggestedAction));
        }
      }}
      onCloseSource={() => {
        sourceRequest.current += 1;
        setSourceState({ status: 'idle' });
      }}
    />
  );
}
