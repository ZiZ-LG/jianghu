import { useState } from 'react';
import {
  isG64111Active,
  isG64111LifecycleEligible,
  type G64111MethodologyMatter,
  type G64111MethodologyReadModel,
} from '@jianghu/domain-contracts';

const lifecycleLabel: Record<G64111MethodologyMatter['lifecycleStatus'], string> = {
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  canceled: '已取消',
};

export type G64111SetupAction =
  | { type: 'install' }
  | { type: 'bind'; customerId: string; matterId: string }
  | { type: 'unbind'; customerId: string; matterId: string };

export type G64111SetupPanelState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      snapshot: G64111MethodologyReadModel;
      refreshing?: boolean;
      refreshError?: string | null;
    };

export function G64111SetupPanel({
  state,
  onRetry,
  onAction,
}: {
  state: G64111SetupPanelState;
  onRetry: () => void;
  onAction: (action: G64111SetupAction) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = async (key: string, action: G64111SetupAction) => {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      await onAction(action);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '方法论操作失败，请刷新后重试。');
    } finally {
      setBusy(null);
    }
  };

  if (state.status === 'loading') {
    return (
      <section className="commercial-shell-empty" data-capability-surface="g64111" data-g64111-setup-state="loading">
        正在读取方法论安装与事项绑定状态…
      </section>
    );
  }
  if (state.status === 'error') {
    return (
      <section className="commercial-shell-empty" data-capability-surface="g64111" data-g64111-setup-state="error" role="alert">
        <p>{state.message}</p>
        <button className="btn sm" onClick={onRetry}>重试</button>
      </section>
    );
  }

  const { snapshot } = state;
  const actionsAvailable = snapshot.commandsEnabled && snapshot.canManage;
  return (
    <section data-capability-surface="g64111" data-g64111-setup-state="ready">
      <div className="commercial-legacy-heading">
        <div>
          <h2>G64111 方法论包</h2>
          <span>按租户安装 · 按事项启用</span>
        </div>
        {state.refreshing && <small>正在刷新…</small>}
      </div>
      {state.refreshError && <p role="alert">{state.refreshError}</p>}
      {actionError && <p role="alert">{actionError}</p>}

      {!snapshot.installation ? (
        <div className="commercial-shell-empty">
          <p>当前租户尚未安装 G64111。未安装不会影响客户、事项及复杂销售通用工作流。</p>
          {actionsAvailable
            ? <button className="btn primary" disabled={Boolean(busy)} onClick={() => void run('install', { type: 'install' })}>安装 G64111</button>
            : <small>{snapshot.commandsEnabled ? '仅可查看方法论状态。' : '方法论命令当前关闭，仅可查看状态。'}</small>}
        </div>
      ) : (
        <>
          <p>已安装 {snapshot.installation.packName} · {snapshot.installation.versionKey}</p>
          {!snapshot.canManage && <p>仅可查看方法论状态；只有 owner/admin 可以安装、切换或解绑。</p>}
          {!snapshot.commandsEnabled && <p>方法论命令当前关闭；现有绑定保持只读。</p>}
          {snapshot.matters.length === 0 ? <div className="commercial-shell-empty">当前没有可配置的事项。</div> : (
            <div className="commercial-shell-list">
              {snapshot.matters.map((matter) => {
                const exact = isG64111Active(matter.activeBinding);
                const lifecycleEligible = isG64111LifecycleEligible(matter.lifecycleStatus);
                const key = `${matter.customerId}:${matter.matterId}`;
                return (
                  <div key={key} className="commercial-shell-row" data-g64111-matter={matter.matterId}>
                    <span>
                      <strong>{matter.matterTitle}</strong>
                      <small>{matter.customerName} · {lifecycleLabel[matter.lifecycleStatus]} · {exact ? 'G64111 已启用' : matter.activeBinding ? `当前为 ${matter.activeBinding.packName}` : '未绑定方法论'}</small>
                    </span>
                    {actionsAvailable && (exact
                      ? <button className="btn ghost sm" disabled={Boolean(busy)} onClick={() => void run(key, { type: 'unbind', customerId: matter.customerId, matterId: matter.matterId })}>解绑 G64111</button>
                      : lifecycleEligible
                        ? <button className="btn sm" disabled={Boolean(busy)} onClick={() => void run(key, { type: 'bind', customerId: matter.customerId, matterId: matter.matterId })}>{matter.activeBinding ? '切换到 G64111' : '为此事项启用'}</button>
                        : null)}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}
