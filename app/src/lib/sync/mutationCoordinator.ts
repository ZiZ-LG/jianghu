import type { Action } from '../../store';
import { ApiError, toApiError } from '../../api';

export type SyncPhase = 'idle' | 'saving' | 'saved' | 'retrying' | 'failed' | 'conflict';

export interface EntitySyncState {
  phase: SyncPhase;
  entityKey?: string;
  failedAction?: Action;
  error?: ApiError;
  canRetry?: boolean;
  updatedAt?: number;
}

export interface MutationCoordinator {
  enqueue(entityKey: string, action: Action): Promise<void>;
  retry(entityKey: string): Promise<void>;
  dismiss(entityKey: string): void;
  cancelDraft(entityKey: string): void;
  reset(): void;
  state(entityKey: string): EntitySyncState;
  globalState(): EntitySyncState;
  subscribe(listener: () => void): () => void;
}

export interface MutationCoordinatorOptions {
  onUnauthorized?: (error: ApiError) => void;
  onCancelDraft?: (entityKey: string) => void;
  prepareConflictRetry?: (action: Action) => Promise<Action>;
  onRetrySuccess?: (originalAction: Action, retryAction: Action, baseVersionDelta: number) => void;
}

export interface MutationExecutionGate {
  run(action: Action, beforeApply?: () => void): Promise<void>;
  runBatch(actions: readonly Action[], recover?: () => Promise<void>): Promise<void>;
  reset(): void;
}

export async function discardAfterCloudRefresh(
  coordinator: MutationCoordinator,
  entityKey: string,
  refresh: (entityKey: string) => void | Promise<void>,
): Promise<void> {
  await refresh(entityKey);
  coordinator.cancelDraft(entityKey);
  coordinator.dismiss(entityKey);
}

/**
 * Dependency batches (undo/redo) are exclusive. Ordinary single actions wait for
 * an active batch, but remain concurrent with each other when no batch is queued.
 */
export function createMutationExecutionGate(apply: (action: Action) => Promise<void>): MutationExecutionGate {
  let batchTail: Promise<void> = Promise.resolve();
  const singles = new Set<Promise<void>>();
  let generation = 0;

  const sessionResetError = () => new ApiError({
    code: 'session_reset',
    message: '会话已切换，已取消旧会话写入',
    retryable: false,
  });
  const assertCurrent = (runGeneration: number) => {
    if (runGeneration !== generation) throw sessionResetError();
  };

  const run = (action: Action, beforeApply?: () => void): Promise<void> => {
    const runGeneration = generation;
    const task = batchTail.then(async () => {
      assertCurrent(runGeneration);
      beforeApply?.();
      await apply(action);
      assertCurrent(runGeneration);
    });
    singles.add(task);
    void task.then(
      () => singles.delete(task),
      () => singles.delete(task),
    );
    return task;
  };

  const runBatch = (actions: readonly Action[], recover?: () => Promise<void>): Promise<void> => {
    const runGeneration = generation;
    const earlierSingles = [...singles];
    const execution = batchTail
      .then(() => Promise.allSettled(earlierSingles))
      .then(async () => {
        assertCurrent(runGeneration);
        for (const action of actions) {
          await apply(action);
          assertCurrent(runGeneration);
        }
      });
    const task = recover
      ? execution.catch(async (error) => {
        if (runGeneration !== generation || toApiError(error).code === 'session_reset') throw error;
        try { await recover(); } catch { /* 保留原始批次失败；恢复结果由调用方记录 */ }
        throw error;
      })
      : execution;
    batchTail = task.then(() => undefined, () => undefined);
    return task;
  };

  return {
    run,
    runBatch,
    reset() {
      generation += 1;
      batchTail = Promise.resolve();
      singles.clear();
    },
  };
}

const IDLE: EntitySyncState = { phase: 'idle' };
const PHASE_PRIORITY: Record<SyncPhase, number> = {
  idle: 0,
  saved: 1,
  saving: 2,
  retrying: 3,
  failed: 4,
  conflict: 5,
};

function isAmbiguousCreateFailure(action: Action, error: ApiError): boolean {
  return action.type.startsWith('ADD_')
    && error.status === undefined
    && (error.code === 'timeout' || error.code === 'network_error' || error.code === 'aborted');
}

export function entityKeyForAction(action: Action): string {
  switch (action.type) {
    case 'ADD_ACCOUNT': return `account:${action.account.id}`;
    case 'UPDATE_ACCOUNT': case 'DELETE_ACCOUNT': return `account:${action.accId}`;
    case 'ADD_OPP': return `opportunity:${action.opp.id}`;
    case 'UPDATE_OPP': case 'DELETE_OPP': return `opportunity:${action.oppId}`;
    case 'ADD_PERSON': return `person:${action.person.id}`;
    case 'UPDATE_PERSON': case 'MOVE_PERSON': case 'DELETE_PERSON': case 'ADD_LOG':
    case 'SET_ROLE': case 'REMOVE_ROLE': case 'ADD_OPP_MEMBER': case 'REMOVE_OPP_MEMBER':
      return `person:${action.personId}`;
    case 'ADD_EDGE': return `edge:${action.edge.id}`;
    case 'UPDATE_EDGE': case 'DELETE_EDGE': return `edge:${action.edgeId}`;
    case 'ADD_BI': return `bi:${action.bi.id}`;
    case 'UPDATE_BI': case 'DELETE_BI': return `bi:${action.biId}`;
    case 'ADD_UCV': return `ucv:${action.ucv.id}`;
    case 'UPDATE_UCV': case 'DELETE_UCV': return `ucv:${action.ucvId}`;
    case 'ADD_VISIT': return `visit:${action.visit.id}`;
    case 'UPDATE_VISIT': case 'DELETE_VISIT': return `visit:${action.visitId}`;
    case 'ADD_NOTE': return `note:${action.note.id}`;
    case 'UPDATE_NOTE': case 'DELETE_NOTE': return `note:${action.noteId}`;
    case 'ADD_PLAN_ACTION': return `plan-action:${action.planAction.id}`;
    case 'UPDATE_PLAN_ACTION': case 'DELETE_PLAN_ACTION': case 'TOGGLE_PLAN_ACTION': return `plan-action:${action.actionId}`;
    case 'ADD_MILESTONE': return `milestone:${action.milestone.id}`;
    case 'UPDATE_MILESTONE': case 'DELETE_MILESTONE': return `milestone:${action.milestoneId}`;
    case 'ADD_OPP_STAGE': return `stage:${action.stage.id}`;
    case 'UPDATE_OPP_STAGE': case 'DELETE_OPP_STAGE': return `stage:${action.stageId}`;
    case 'ADD_STRATEGY_CARD': return `strategy-card:${action.card.id}`;
    case 'UPDATE_STRATEGY_CARD': case 'DELETE_STRATEGY_CARD': return `strategy-card:${action.cardId}`;
    case 'ADD_STRATEGY_RISK': return `strategy-risk:${action.risk.id}`;
    case 'UPDATE_STRATEGY_RISK': case 'DELETE_STRATEGY_RISK': return `strategy-risk:${action.riskId}`;
    case 'ADD_STRATEGY_RESOURCE': return `strategy-resource:${action.resource.id}`;
    case 'UPDATE_STRATEGY_RESOURCE': case 'DELETE_STRATEGY_RESOURCE': return `strategy-resource:${action.resourceId}`;
    case 'ADD_EVIDENCE': return `evidence:${action.evidence.id}`;
    case 'DELETE_EVIDENCE': return `evidence:${action.evidenceId}`;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function createMutationCoordinator(
  send: (action: Action) => Promise<unknown>,
  options: MutationCoordinatorOptions = {},
): MutationCoordinator {
  interface PendingJob {
    action: Action;
    resolve: () => void;
    reject: (error: ApiError) => void;
  }
  const states = new Map<string, EntitySyncState>();
  const queues = new Map<string, PendingJob[]>();
  const running = new Map<string, symbol>();
  const recoveries = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let generation = 0;

  const publish = (key: string, next: EntitySyncState) => {
    states.set(key, { ...next, entityKey: key });
    listeners.forEach((listener) => listener());
  };

  const run = async (key: string, action: Action, retrying: boolean): Promise<void> => {
    const runGeneration = generation;
    publish(key, { phase: retrying ? 'retrying' : 'saving', failedAction: retrying ? action : undefined });
    try {
      await send(action);
      if (runGeneration !== generation) throw new ApiError({ code: 'session_reset', message: '会话已切换', retryable: false });
      publish(key, { phase: 'saved', updatedAt: Date.now() });
    } catch (cause) {
      const error = toApiError(cause);
      if (runGeneration !== generation) throw error;
      if (error.status === 401) options.onUnauthorized?.(error);
      const ambiguousCreate = isAmbiguousCreateFailure(action, error);
      const visibleError = ambiguousCreate
        ? new ApiError({ code: 'ambiguous_outcome', message: '连接中断，云端可能已保存。请先查看云端值，避免重复创建。', retryable: false, cause: error })
        : error;
      publish(key, {
        phase: error.status === 409 || ambiguousCreate ? 'conflict' : 'failed',
        failedAction: action,
        error: visibleError,
        canRetry: !ambiguousCreate,
        updatedAt: Date.now(),
      });
      throw visibleError;
    }
  };

  const pump = (key: string): void => {
    const current = states.get(key);
    if (running.has(key) || recoveries.has(key) || current?.phase === 'failed' || current?.phase === 'conflict') return;
    const jobs = queues.get(key);
    const job = jobs?.shift();
    if (!job) {
      queues.delete(key);
      return;
    }
    const runToken = Symbol(key);
    running.set(key, runToken);
    void run(key, job.action, false)
      .then(job.resolve, job.reject)
      .finally(() => {
        if (running.get(key) === runToken) running.delete(key);
        pump(key);
      });
  };

  return {
    enqueue(key, action) {
      return new Promise<void>((resolve, reject) => {
        const jobs = queues.get(key) ?? [];
        jobs.push({ action, resolve, reject });
        queues.set(key, jobs);
        pump(key);
      });
    },
    retry(key) {
      const active = recoveries.get(key);
      if (active) return active;
      const current = states.get(key);
      const action = current?.failedAction;
      if (!action) return Promise.resolve();
      if (current.canRetry === false) {
        return Promise.reject(current.error ?? new ApiError({ code: 'retry_blocked', message: '请先查看云端值', retryable: false }));
      }
      const recoveryGeneration = generation;
      const recovery = (async () => {
        const retryAction = current?.phase === 'conflict' && options.prepareConflictRetry
          ? await options.prepareConflictRetry(action)
          : action;
        if (recoveryGeneration !== generation) {
          throw new ApiError({ code: 'session_reset', message: '会话已切换', retryable: false });
        }
        await run(key, retryAction, true);
        const originalBase = 'baseVersion' in action && typeof action.baseVersion === 'number' ? action.baseVersion : undefined;
        const retryBase = 'baseVersion' in retryAction && typeof retryAction.baseVersion === 'number' ? retryAction.baseVersion : undefined;
        const delta = originalBase !== undefined && retryBase !== undefined ? retryBase - originalBase : 0;
        if (delta !== 0) {
          for (const job of queues.get(key) ?? []) {
            if ('baseVersion' in job.action && typeof job.action.baseVersion === 'number') {
              job.action = { ...job.action, baseVersion: job.action.baseVersion + delta } as Action;
            }
          }
        }
        options.onRetrySuccess?.(action, retryAction, delta);
      })();
      recoveries.set(key, recovery);
      void recovery.finally(() => {
        if (recoveries.get(key) === recovery) recoveries.delete(key);
        pump(key);
      }).catch(() => undefined);
      return recovery;
    },
    dismiss(key) {
      const discarded = new ApiError({ code: 'discarded_conflict', message: '已放弃本地排队写入', retryable: false });
      for (const job of queues.get(key) ?? []) job.reject(discarded);
      queues.delete(key);
      states.delete(key);
      listeners.forEach((listener) => listener());
    },
    cancelDraft(key) {
      options.onCancelDraft?.(key);
    },
    reset() {
      generation += 1;
      const resetError = new ApiError({ code: 'session_reset', message: '会话已切换，已取消旧会话写入', retryable: false });
      for (const jobs of queues.values()) for (const job of jobs) job.reject(resetError);
      queues.clear();
      recoveries.clear();
      running.clear();
      states.clear();
      listeners.forEach((listener) => listener());
    },
    state: (key) => states.get(key) ?? IDLE,
    globalState() {
      let result = IDLE;
      for (const state of states.values()) {
        if (PHASE_PRIORITY[state.phase] > PHASE_PRIORITY[result.phase]) result = state;
      }
      return result;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
