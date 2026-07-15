import { describe, expect, it } from 'vitest';
import { clearSessionUi, commitSessionInbox, createSessionInboxGuard } from './sessionLifecycle';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('clearSessionUi', () => {
  it('clears visit capture, inbox progress/error visibility, and cached batch idempotency keys', () => {
    const batchKeys = new Map([['evidence:item', { key: 'stale-key', payload: 'stale-payload' }]]);

    const state = clearSessionUi(batchKeys);

    expect(batchKeys.size).toBe(0);
    expect(state).toEqual({
      intelOpen: false,
      intelContext: null,
      inboxOpen: false,
      inbox: { rels: [], persons: [], proposals: [], reminders: [], evidences: [], total: 0 },
      syncErr: '',
    });
  });
});

describe('session inbox generation guard', () => {
  it('ignores an old inbox response that resolves after logout', async () => {
    const guard = createSessionInboxGuard();
    let token: string | null = 'token-a';
    const ticket = guard.begin(token);
    const response = deferred<{ total: number }>();
    let committed: { total: number } | undefined;
    const pending = commitSessionInbox(guard, ticket, response.promise, () => token, (value) => { committed = value; });

    token = null;
    guard.begin(null);
    response.resolve({ total: 7 });

    await expect(pending).resolves.toBe(false);
    expect(committed).toBeUndefined();
  });

  it('does not let user A overwrite user B when A resolves last', async () => {
    const guard = createSessionInboxGuard();
    let token: string | null = 'token-a';
    const responseA = deferred<{ owner: string }>();
    const ticketA = guard.begin(token);
    let committed: { owner: string } | undefined;
    const pendingA = commitSessionInbox(guard, ticketA, responseA.promise, () => token, (value) => { committed = value; });

    token = 'token-b';
    const responseB = deferred<{ owner: string }>();
    const ticketB = guard.begin(token);
    const pendingB = commitSessionInbox(guard, ticketB, responseB.promise, () => token, (value) => { committed = value; });
    responseB.resolve({ owner: 'B' });
    await expect(pendingB).resolves.toBe(true);
    expect(committed).toEqual({ owner: 'B' });

    responseA.resolve({ owner: 'A' });
    await expect(pendingA).resolves.toBe(false);
    expect(committed).toEqual({ owner: 'B' });
  });
});
