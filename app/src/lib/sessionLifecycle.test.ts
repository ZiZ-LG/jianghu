import { describe, expect, it, vi } from 'vitest';
import { clearSessionUi, commitSessionValue, createSessionGuard, createSessionLease, runSessionRequest } from './sessionLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('clearSessionUi', () => {
  it('clears inbox progress/error state and cached batch idempotency keys', () => {
    const batchKeys = new Map([['evidence:item', { key: 'stale-key', payload: 'stale-payload' }]]);

    const state = clearSessionUi(batchKeys);

    expect(batchKeys.size).toBe(0);
    expect(state).toEqual({
      inbox: { rels: [], persons: [], proposals: [], reminders: [], evidences: [], total: 0 },
      syncErr: '',
    });
  });
});

describe('session generation guard', () => {
  it('ignores an old inbox response that resolves after logout', async () => {
    const guard = createSessionGuard();
    let token: string | null = 'token-a';
    const ticket = guard.begin(token);
    const response = deferred<{ total: number }>();
    let committed: { total: number } | undefined;
    const pending = commitSessionValue(guard, ticket, () => response.promise, () => token, (value) => { committed = value; });

    token = null;
    guard.begin(null);
    response.resolve({ total: 7 });

    await expect(pending).resolves.toBe(false);
    expect(committed).toBeUndefined();
  });

  it('does not let user A state overwrite user B when A resolves last', async () => {
    const guard = createSessionGuard();
    let token: string | null = 'token-a';
    const responseA = deferred<{ accounts: string[] }>();
    const ticketA = guard.begin(token);
    let committed: { accounts: string[] } | undefined;
    const pendingA = commitSessionValue(guard, ticketA, () => responseA.promise, () => token, (value) => { committed = value; });

    token = 'token-b';
    const responseB = deferred<{ accounts: string[] }>();
    const ticketB = guard.begin(token);
    const pendingB = commitSessionValue(guard, ticketB, () => responseB.promise, () => token, (value) => { committed = value; });
    responseB.resolve({ accounts: ['B'] });
    await expect(pendingB).resolves.toBe(true);
    expect(committed).toEqual({ accounts: ['B'] });

    responseA.resolve({ accounts: ['A'] });
    await expect(pendingA).resolves.toBe(false);
    expect(committed).toEqual({ accounts: ['B'] });
  });

  it('does not even start a cloud read after its session ticket is stale', async () => {
    const guard = createSessionGuard();
    let token: string | null = 'token-a';
    const ticketA = guard.begin(token);
    token = 'token-b';
    guard.begin(token);
    let requests = 0;

    const result = await runSessionRequest(guard, ticketA, async () => {
      requests += 1;
      return { accounts: ['wrong-session'] };
    }, () => token);

    expect(result).toEqual({ current: false });
    expect(requests).toBe(0);
  });

  it('blocks delayed child dispatch and follow-up requests after the rendered session lease expires', async () => {
    const guard = createSessionGuard();
    let token: string | null = 'token-a';
    const lease = createSessionLease(guard, guard.begin(token), () => token);
    const response = deferred<{ analysis: string }>();
    const dispatch = vi.fn();
    const followUp = vi.fn(async () => ({ ok: true }));
    const pending = lease.run(() => response.promise).then(async (result) => {
      if (!result.current) return false;
      lease.commit(() => dispatch({ type: 'OLD_AI_WRITE' }));
      await lease.run(followUp);
      return true;
    });

    token = 'token-b';
    guard.begin(token);
    response.resolve({ analysis: 'A response' });

    await expect(pending).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });
});
