import type { Action } from '../../store';

export interface CommitScheduler {
  schedule(entityKey: string, action: Action, options?: { delayMs?: number }): void;
  flush(entityKey: string): Promise<void>;
  flushAll(): Promise<void>;
  cancel(entityKey: string): void;
  reset(): void;
}

export interface CommitSchedulerOptions {
  delayMs?: number;
  merge?: (previous: Action, next: Action) => Action | undefined;
}

interface PendingCommit {
  actions: Action[];
  timer: ReturnType<typeof setTimeout>;
}

function mergePatchActions(previous: Action, next: Action): Action | undefined {
  const a = previous as Action & { patch?: Record<string, unknown> };
  const b = next as Action & { patch?: Record<string, unknown> };
  if (a.type !== b.type) return undefined;
  if (previous.type === 'MOVE_PERSON' && next.type === 'MOVE_PERSON') return next;
  if (!a.patch || !b.patch) return undefined;
  const patch = { ...a.patch, ...b.patch };
  if (a.patch.form && b.patch.form && typeof a.patch.form === 'object' && typeof b.patch.form === 'object') {
    patch.form = { ...(a.patch.form as object), ...(b.patch.form as object) };
  }
  return { ...next, patch } as Action;
}

export function createCommitScheduler(
  commit: (entityKey: string, action: Action) => Promise<unknown>,
  options: CommitSchedulerOptions = {},
): CommitScheduler {
  const pending = new Map<string, PendingCommit>();
  const defaultDelay = options.delayMs ?? 400;
  const merge = options.merge ?? mergePatchActions;

  const flush = async (entityKey: string): Promise<void> => {
    const item = pending.get(entityKey);
    if (!item) return;
    clearTimeout(item.timer);
    pending.delete(entityKey);
    await Promise.all(item.actions.map((action) => commit(entityKey, action)));
  };

  return {
    schedule(entityKey, action, scheduleOptions = {}) {
      const current = pending.get(entityKey);
      if (current) clearTimeout(current.timer);
      const actions = current ? [...current.actions] : [];
      const previous = actions[actions.length - 1];
      const merged = previous ? merge(previous, action) : action;
      if (previous && merged) actions[actions.length - 1] = merged;
      else actions.push(action);
      const timer = setTimeout(() => { void flush(entityKey).catch(() => undefined); }, scheduleOptions.delayMs ?? defaultDelay);
      pending.set(entityKey, { actions, timer });
    },
    flush,
    async flushAll() {
      await Promise.all([...pending.keys()].map((key) => flush(key)));
    },
    cancel(entityKey) {
      const item = pending.get(entityKey);
      if (item) clearTimeout(item.timer);
      pending.delete(entityKey);
    },
    reset() {
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear();
    },
  };
}
