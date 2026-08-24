import { useId, useState } from 'react';
import type {
  CrmContextSnapshot,
  PersonSummaryV2,
  RelationV2,
} from '@jianghu/domain-contracts';
import {
  customerCategoryLabel,
  matterKindLabel,
  matterLifecycleLabel,
  relationKindLabel,
  selectCustomerContext,
  selectMatterContext,
} from '../lib/crmContext';

export const CRM_CONTEXT_REFRESH_INTERVAL_MS = 60_000;

export type CrmContextPanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      snapshot: CrmContextSnapshot;
      refreshing: boolean;
      refreshError: string | null;
    };

type ContextMode = 'customers' | 'matters';

function relationPositions(people: readonly PersonSummaryV2[]) {
  const width = 640;
  const height = 280;
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = 245;
  const radiusY = 92;
  return new Map(people.map((person, index) => {
    if (people.length === 1) return [person.id, { x: centerX, y: centerY }] as const;
    const angle = (-Math.PI / 2) + ((2 * Math.PI * index) / people.length);
    return [person.id, {
      x: centerX + (Math.cos(angle) * radiusX),
      y: centerY + (Math.sin(angle) * radiusY),
    }] as const;
  }));
}

function RelationContext({
  people,
  relations,
  onQuickCapture,
}: {
  people: PersonSummaryV2[];
  relations: RelationV2[];
  onQuickCapture: () => void;
}) {
  const titleId = useId();
  const markerId = `crm-arrow-${useId().split(':').join('')}`;
  if (relations.length === 0) {
    return (
      <div className="crm-relation-empty" data-relation-context="empty">
        <p>暂时没有可展示的关系。你仍可先记录下一步，之后再补充人物关系。</p>
        <button
          type="button"
          className="btn primary"
          data-crm-quick-capture="relation-empty"
          onClick={onQuickCapture}
        >快速记录</button>
      </div>
    );
  }

  const personById = new Map(people.map((person) => [person.id, person]));
  const positions = relationPositions(people);
  return (
    <div className="crm-relation-context" data-relation-context="ready">
      <div className="crm-relation-canvas">
        <svg viewBox="0 0 640 280" role="img" aria-labelledby={titleId} preserveAspectRatio="xMidYMid meet">
          <title id={titleId}>当前权限范围内的人物关系图</title>
          <defs>
            <marker id={markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path className="crm-relation-arrow" d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {relations.map((relation) => {
            const source = positions.get(relation.sourcePersonId);
            const target = positions.get(relation.targetPersonId);
            if (!source || !target) return null;
            return (
              <g key={relation.id} data-relation-id={relation.id}>
                <line
                  className="crm-relation-line"
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  markerEnd={relation.directed ? `url(#${markerId})` : undefined}
                />
              </g>
            );
          })}
          {people.map((person) => {
            const position = positions.get(person.id);
            if (!position) return null;
            return (
              <g key={person.id} className="crm-relation-node" transform={`translate(${position.x} ${position.y})`}>
                <circle r="34" />
                <text textAnchor="middle" dominantBaseline="middle">{person.name.slice(0, 6)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <ul className="crm-relation-list" aria-label="关系清单">
        {relations.map((relation) => {
          const source = personById.get(relation.sourcePersonId);
          const target = personById.get(relation.targetPersonId);
          return (
            <li key={relation.id}>
              <div>
                <strong>{source?.name ?? '未知人物'}{relation.directed ? ' → ' : ' ↔ '}{target?.name ?? '未知人物'}</strong>
                <span>{relation.label ?? relationKindLabel(relation.kind)}</span>
              </div>
              <span className="crm-context-badge">{relation.matterId === null ? '客户关系' : '事项关系'}</span>
              {relation.label ? <small>{relationKindLabel(relation.kind)}</small> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PageToolbar({ count, label, onQuickCapture }: {
  count: number;
  label: string;
  onQuickCapture: () => void;
}) {
  return (
    <div className="crm-context-toolbar">
      <span>{count} 个{label}</span>
      <button type="button" className="btn primary" data-crm-quick-capture="list" onClick={onQuickCapture}>
        快速记录
      </button>
    </div>
  );
}

function CustomerPage({
  snapshot,
  selectedCustomerId,
  onSelect,
  onQuickCapture,
}: {
  snapshot: CrmContextSnapshot;
  selectedCustomerId: string | null;
  onSelect: (customerId: string | null) => void;
  onQuickCapture: () => void;
}) {
  const context = selectedCustomerId ? selectCustomerContext(snapshot, selectedCustomerId) : null;
  if (context) {
    return (
      <article className="crm-context-detail" data-customer-detail={context.customer.id}>
        <header className="crm-context-detail-header">
          <div>
            <button type="button" className="crm-context-back" onClick={() => onSelect(null)}>← 返回客户</button>
            <h2>{context.customer.name}</h2>
            <span className="crm-context-badge">{customerCategoryLabel(context.customer.categoryKey)}</span>
          </div>
          <button type="button" className="btn primary" data-crm-quick-capture="customer" onClick={onQuickCapture}>
            记录下一步
          </button>
        </header>

        <div className="crm-context-summary-grid">
          <div><strong>{context.matters.length}</strong><span>事项</span></div>
          <div><strong>{context.people.length}</strong><span>联系人</span></div>
          <div><strong>{context.relations.length}</strong><span>客户关系</span></div>
        </div>

        <section className="crm-context-section" aria-labelledby="customer-matters-heading">
          <header><h3 id="customer-matters-heading">事项</h3></header>
          {context.matters.length === 0 ? <p className="crm-context-empty-copy">还没有事项</p> : (
            <ul className="crm-context-compact-list">
              {context.matters.map((matter) => (
                <li key={matter.id}>
                  <strong>{matter.title}</strong>
                  <span>{matterKindLabel(matter.kind)} · {matterLifecycleLabel(matter.lifecycleStatus)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="crm-context-section" aria-labelledby="customer-people-heading">
          <header><h3 id="customer-people-heading">联系人</h3></header>
          {context.people.length === 0 ? <p className="crm-context-empty-copy">还没有联系人</p> : (
            <ul className="crm-context-compact-list">
              {context.people.map((person) => (
                <li key={person.id}><strong>{person.name}</strong><span>{person.title ?? '职务未填写'}</span></li>
              ))}
            </ul>
          )}
        </section>

        <section className="crm-context-section" aria-labelledby="customer-relations-heading">
          <header><h3 id="customer-relations-heading">关系上下文</h3><span>只显示客户级关系</span></header>
          <RelationContext people={context.people} relations={context.relations} onQuickCapture={onQuickCapture} />
        </section>
      </article>
    );
  }

  return (
    <div className="crm-context-page" data-crm-context-page="customers">
      <PageToolbar count={snapshot.customers.length} label="客户" onQuickCapture={onQuickCapture} />
      {snapshot.customers.length === 0 ? (
        <div className="commercial-shell-empty">
          <p>还没有客户档案。可以先用快速记录建立客户与下一步。</p>
          <button type="button" className="btn primary" data-crm-quick-capture="customer-empty" onClick={onQuickCapture}>快速记录</button>
        </div>
      ) : (
        <div className="crm-context-list" aria-label="客户列表">
          {snapshot.customers.map((customer) => {
            const customerContext = selectCustomerContext(snapshot, customer.id)!;
            return (
              <button
                key={customer.id}
                type="button"
                className="crm-context-row"
                data-customer-id={customer.id}
                onClick={() => onSelect(customer.id)}
              >
                <span><strong>{customer.name}</strong><small>{customerCategoryLabel(customer.categoryKey)}</small></span>
                <span>{customerContext.matters.length} 个事项 · {customerContext.people.length} 位联系人</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function MatterPage({
  snapshot,
  selectedMatterId,
  onSelect,
  onQuickCapture,
}: {
  snapshot: CrmContextSnapshot;
  selectedMatterId: string | null;
  onSelect: (matterId: string | null) => void;
  onQuickCapture: () => void;
}) {
  const context = selectedMatterId ? selectMatterContext(snapshot, selectedMatterId) : null;
  if (context) {
    return (
      <article className="crm-context-detail" data-matter-detail={context.matter.id}>
        <header className="crm-context-detail-header">
          <div>
            <button type="button" className="crm-context-back" onClick={() => onSelect(null)}>← 返回事项</button>
            <p>{context.customer.name}</p>
            <h2>{context.matter.title}</h2>
            <div className="crm-context-badges">
              <span className="crm-context-badge">{matterKindLabel(context.matter.kind)}</span>
              <span className="crm-context-badge">{matterLifecycleLabel(context.matter.lifecycleStatus)}</span>
            </div>
          </div>
          <button type="button" className="btn primary" data-crm-quick-capture="matter" onClick={onQuickCapture}>
            记录下一步
          </button>
        </header>

        <dl className="crm-context-meta">
          <div><dt>优先级</dt><dd>{context.matter.priority ?? '未设置'}</dd></div>
          <div><dt>目标日期</dt><dd>{context.matter.targetDate ?? '未设置'}</dd></div>
          <div><dt>结果</dt><dd>{context.matter.outcomeKey ?? '尚未结束'}</dd></div>
        </dl>

        <section className="crm-context-section" aria-labelledby="matter-participants-heading">
          <header><h3 id="matter-participants-heading">参与人</h3></header>
          {context.participants.length === 0 ? <p className="crm-context-empty-copy">暂无参与人</p> : (
            <ul className="crm-context-compact-list">
              {context.participants.map((person) => (
                <li key={person.id}><strong>{person.name}</strong><span>{person.title ?? '职务未填写'}</span></li>
              ))}
            </ul>
          )}
        </section>

        <section className="crm-context-section" aria-labelledby="matter-relations-heading">
          <header><h3 id="matter-relations-heading">关系上下文</h3><span>客户关系 + 当前事项关系</span></header>
          <RelationContext people={context.people} relations={context.relations} onQuickCapture={onQuickCapture} />
        </section>
      </article>
    );
  }

  const customerById = new Map(snapshot.customers.map((customer) => [customer.id, customer]));
  return (
    <div className="crm-context-page" data-crm-context-page="matters">
      <PageToolbar count={snapshot.matters.length} label="事项" onQuickCapture={onQuickCapture} />
      {snapshot.matters.length === 0 ? (
        <div className="commercial-shell-empty">
          <p>还没有事项。可以先记录一个客户级下一步，事项保持可选。</p>
          <button type="button" className="btn primary" data-crm-quick-capture="matter-empty" onClick={onQuickCapture}>快速记录</button>
        </div>
      ) : (
        <div className="crm-context-list" aria-label="事项列表">
          {snapshot.matters.map((matter) => (
            <button
              key={matter.id}
              type="button"
              className="crm-context-row"
              data-matter-id={matter.id}
              onClick={() => onSelect(matter.id)}
            >
              <span>
                <strong>{matter.title}</strong>
                <small>{customerById.get(matter.customerId)?.name ?? '未知客户'}</small>
              </span>
              <span>{matterKindLabel(matter.kind)} · {matterLifecycleLabel(matter.lifecycleStatus)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function CrmContextView({
  mode,
  snapshot,
  onQuickCapture,
  initialCustomerId,
  initialMatterId,
}: {
  mode: ContextMode;
  snapshot: CrmContextSnapshot;
  onQuickCapture: () => void;
  initialCustomerId?: string;
  initialMatterId?: string;
}) {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(initialCustomerId ?? null);
  const [selectedMatterId, setSelectedMatterId] = useState<string | null>(initialMatterId ?? null);
  return mode === 'customers' ? (
    <CustomerPage
      snapshot={snapshot}
      selectedCustomerId={selectedCustomerId}
      onSelect={setSelectedCustomerId}
      onQuickCapture={onQuickCapture}
    />
  ) : (
    <MatterPage
      snapshot={snapshot}
      selectedMatterId={selectedMatterId}
      onSelect={setSelectedMatterId}
      onQuickCapture={onQuickCapture}
    />
  );
}

export function CrmContextPanelStateView({
  mode,
  state,
  onRetry,
  onQuickCapture,
}: {
  mode: ContextMode;
  state: CrmContextPanelState;
  onRetry: () => void;
  onQuickCapture: () => void;
}) {
  if (state.status === 'loading') {
    return <div className="crm-context-state" data-crm-context-state="loading">正在读取当前权限范围内的客户与事项…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="crm-context-state error" data-crm-context-state="error" role="alert">
        <p>{state.message}</p>
        <button type="button" className="btn primary" onClick={onRetry}>重新加载</button>
      </div>
    );
  }
  return (
    <div data-crm-context-state="ready">
      {state.refreshError ? (
        <div className="crm-context-refresh-error" role="status">
          <span>{state.refreshError}</span>
          <button type="button" className="btn ghost sm" onClick={onRetry}>再次刷新</button>
        </div>
      ) : state.refreshing ? <p className="crm-context-refreshing" role="status">正在刷新当前权限数据…</p> : null}
      <CrmContextView mode={mode} snapshot={state.snapshot} onQuickCapture={onQuickCapture} />
    </div>
  );
}

export function CrmContextPanel({ mode, state, onRetry, onQuickCapture }: {
  mode: ContextMode;
  state: CrmContextPanelState;
  onRetry: () => void;
  onQuickCapture: () => void;
}) {
  return (
    <CrmContextPanelStateView
      mode={mode}
      state={state}
      onRetry={onRetry}
      onQuickCapture={onQuickCapture}
    />
  );
}
