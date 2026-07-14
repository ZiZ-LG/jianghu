import { useSyncExternalStore } from 'react';
import { discardAfterCloudRefresh, type MutationCoordinator, type SyncPhase } from '../lib/sync/mutationCoordinator';

const LABELS: Record<SyncPhase, string> = {
  idle: '',
  saving: '正在保存…',
  saved: '已保存',
  retrying: '正在重试…',
  failed: '保存失败',
  conflict: '发现云端冲突',
};

export function SyncStatus({
  coordinator,
  entityKey,
  onViewCloud,
}: {
  coordinator: MutationCoordinator;
  entityKey?: string;
  onViewCloud?: (entityKey?: string) => void | Promise<void>;
}) {
  const state = useSyncExternalStore(
    coordinator.subscribe,
    () => entityKey ? coordinator.state(entityKey) : coordinator.globalState(),
  );
  if (state.phase === 'idle') return null;
  const targetKey = entityKey ?? state.entityKey;
  const retry = () => targetKey && void coordinator.retry(targetKey).catch(() => undefined);
  const viewCloud = async () => {
    try {
      if (targetKey) await discardAfterCloudRefresh(coordinator, targetKey, (key) => onViewCloud?.(key));
      else await onViewCloud?.();
    } catch {
      // 刷新失败时保留 conflict，用户仍可重试或保留本地值。
    }
  };

  return (
    <div className={`sync-status ${state.phase}`} role="status" aria-live="polite">
      <span>{LABELS[state.phase]}</span>
      {state.phase === 'failed' && targetKey && <button className="btn ghost xs" onClick={retry}>重试</button>}
      {state.phase === 'conflict' && targetKey && <>
        <button className="btn ghost xs" onClick={() => void viewCloud()}>查看云端值</button>
        {state.canRetry !== false && <button className="btn ghost xs" onClick={retry}>保留我的值</button>}
      </>}
      {(state.phase === 'failed' || state.phase === 'conflict') && state.error && (
        <span className="sync-status-error">{state.error.message}</span>
      )}
    </div>
  );
}
