import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, isConfirmedAuthFailure, request } from './api';

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

afterEach(() => {
  api.setToken(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('typed API failures', () => {
  it('preserves HTTP status/code and notifies the centralized 401 handler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(401, { code: 'token_expired', error: 'expired' })));
    const seen: ApiError[] = [];
    const unsubscribe = api.onUnauthorized((error) => seen.push(error));

    await expect(request('/api/me')).rejects.toMatchObject({
      status: 401,
      code: 'token_expired',
      retryable: false,
    });
    expect(seen).toHaveLength(1);
    unsubscribe();
  });

  it('does not broadcast a delayed user A 401 after token switches to user B', async () => {
    const pendingResponse = deferred<Response>();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => pendingResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    api.setToken('token-a');
    const seen: ApiError[] = [];
    const unsubscribe = api.onUnauthorized((error) => {
      seen.push(error);
      api.setToken(null); // mirror App centralized logout cleanup
    });
    const pending = request('/api/me');
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer token-a');

    api.setToken('token-b');
    pendingResponse.resolve(response(401, { error: 'A expired' }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual([]);
    expect(api.getToken()).toBe('token-b');
    unsubscribe();
  });

  it('uses a bearer supplied through Headers without binding its 401 to the global session', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response(401, { error: 'custom bearer denied' }));
    vi.stubGlobal('fetch', fetchMock);
    api.setToken('global-token');
    const seen: ApiError[] = [];
    const unsubscribe = api.onUnauthorized((error) => {
      seen.push(error);
      api.setToken(null);
    });

    await expect(request('/custom', {
      headers: new Headers({ Authorization: 'Bearer custom-token' }),
    })).rejects.toMatchObject({ status: 401 });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get('authorization')).toBe('Bearer custom-token');
    expect(seen).toEqual([]);
    expect(api.getToken()).toBe('global-token');
    unsubscribe();
  });

  it('lets lowercase authorization override the global token without merging identities', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response(401, { error: 'explicit bearer denied' }));
    vi.stubGlobal('fetch', fetchMock);
    api.setToken('global-token');
    const seen: ApiError[] = [];
    const unsubscribe = api.onUnauthorized((error) => seen.push(error));

    await expect(request('/custom', {
      headers: { authorization: 'Bearer explicit-token' },
    })).rejects.toMatchObject({ status: 401 });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers;
    expect(headers).toBeInstanceOf(Headers);
    expect(Array.from((headers as Headers).entries()).filter(([name]) => name === 'authorization')).toEqual([
      ['authorization', 'Bearer explicit-token'],
    ]);
    expect((headers as Headers).get('authorization')).not.toContain('global-token');
    expect(seen).toEqual([]);
    expect(api.getToken()).toBe('global-token');
    unsubscribe();
  });

  it.each([
    ['Basic credentials', new Headers({ Authorization: 'Basic dXNlcjpwYXNz' }), 'Basic dXNlcjpwYXNz'],
    ['an empty authorization value', { authorization: '' }, ''],
  ])('does not replace %s with the global bearer or broadcast its 401', async (_label, customHeaders, expected) => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response(401, { error: 'explicit authorization denied' }));
    vi.stubGlobal('fetch', fetchMock);
    api.setToken('global-token');
    const seen: ApiError[] = [];
    const unsubscribe = api.onUnauthorized((error) => seen.push(error));

    await expect(request('/custom', { headers: customHeaders })).rejects.toMatchObject({ status: 401 });

    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers;
    expect(headers).toBeInstanceOf(Headers);
    expect((headers as Headers).get('authorization')).toBe(expected);
    expect((headers as Headers).get('authorization')).not.toContain('global-token');
    expect(seen).toEqual([]);
    expect(api.getToken()).toBe('global-token');
    unsubscribe();
  });

  it('broadcasts the current user B 401 exactly once and lets centralized cleanup run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(401, { error: 'B expired' })));
    api.setToken('token-b');
    const seen: ApiError[] = [];
    const unsubscribe = api.onUnauthorized((error) => {
      seen.push(error);
      api.setToken(null);
    });

    await expect(request('/api/me')).rejects.toMatchObject({ status: 401 });

    expect(seen).toHaveLength(1);
    expect(api.getToken()).toBeNull();
    unsubscribe();
  });

  it('does not let a delayed anonymous 401 log out a session created while it was pending', async () => {
    const pendingResponse = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pendingResponse.promise));
    api.setToken(null);
    const seen: ApiError[] = [];
    const unsubscribe = api.onUnauthorized((error) => {
      seen.push(error);
      api.setToken(null);
    });
    const pending = request('/public');

    api.setToken('token-b');
    pendingResponse.resolve(response(401, { error: 'anonymous denied' }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(seen).toEqual([]);
    expect(api.getToken()).toBe('token-b');
    unsubscribe();
  });

  it('classifies 409 as a non-retryable conflict without hiding its code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(409, { code: 'version_conflict', error: 'newer version' })));
    await expect(request('/api/mutate')).rejects.toMatchObject({
      status: 409,
      code: 'version_conflict',
      retryable: false,
    });
  });

  it('turns timeout and Abort into typed retryable failures', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener('abort', abort);
    })));

    const timedOut = request('/slow', {}, { timeoutMs: 50 });
    const timeoutExpectation = expect(timedOut).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await vi.advanceTimersByTimeAsync(50);
    await timeoutExpectation;

    const controller = new AbortController();
    const aborted = request('/abort', { signal: controller.signal }, { timeoutMs: 5_000 });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: 'aborted', retryable: true });

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(request('/already-aborted', { signal: alreadyAborted.signal })).rejects.toMatchObject({ code: 'aborted' });
  });

  it('clears startup auth only for confirmed 401/403, not network or 5xx failures', () => {
    expect(isConfirmedAuthFailure(new ApiError({ status: 401, message: 'expired' }))).toBe(true);
    expect(isConfirmedAuthFailure(new ApiError({ status: 403, message: 'forbidden' }))).toBe(true);
    expect(isConfirmedAuthFailure(new ApiError({ status: 503, message: 'down', retryable: true }))).toBe(false);
    expect(isConfirmedAuthFailure(new ApiError({ code: 'network_error', message: 'offline', retryable: true }))).toBe(false);
  });

  it('retries a network-unknown command once with the same idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(response(200, { opportunityId: 'opp-once', memberCount: 0, skeletonPersonIds: [], replayed: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.opportunitySkeleton({
      accountId: 'acc', name: 'Once', personIds: [], withEdges: false, skeleton: [],
    }, 'stable-command-key')).resolves.toMatchObject({ opportunityId: 'opp-once', replayed: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('stable-command-key');
    expect(((fetchMock.mock.calls[1][1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('stable-command-key');
  });

  it('sends the explicit voice capture person context unchanged', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response(200, { visitNote: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api.voiceExtract({
      text: '虚构拜访记录', accountId: 'acc-test', opportunityId: 'opp-test', personId: 'person-test',
    }, 'voice-context-key');

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      text: '虚构拜访记录', accountId: 'acc-test', opportunityId: 'opp-test', personId: 'person-test',
    });
  });

  it('keeps the inbox item key across commandReq automatic network retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(response(200, { items: [{ kind: 'proposal', id: 'proposal-1', status: 'accepted' }], replayed: true }));
    vi.stubGlobal('fetch', fetchMock);

    await api.inboxBatch({ items: [{ kind: 'proposal', id: 'proposal-1', decision: 'accept' }] }, 'stable-inbox-key');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('stable-inbox-key');
    expect(((fetchMock.mock.calls[1][1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('stable-inbox-key');
  });

  it('sends minimum repair commands to the dedicated audited endpoints', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response(200, {
      source: 'workbuddy', sourceRef: 'acc-ref', syncedAt: null, syncRuns: [], auditEvents: [],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const repairApi = api;
    expect(typeof repairApi.repairAccount).toBe('function');
    expect(typeof repairApi.repairOpportunity).toBe('function');
    expect(typeof repairApi.repairRebind).toBe('function');
    expect(typeof repairApi.repairContext).toBe('function');
    expect(typeof repairApi.repairPersonMergePreview).toBe('function');
    expect(typeof repairApi.repairPersonMerge).toBe('function');

    const base = { name: 'Old', customerType: 1 as const, primaryOwner: '', primaryOwnerUserId: null };
    await repairApi.repairAccount!('acc/1', { base, name: 'Correct' });
    await repairApi.repairOpportunity!('opp/1', { baseVersion: 3, status: 'paused' });
    await repairApi.repairRebind!({ kind: 'note', id: 'note-1', accountId: 'acc-2', opportunityId: 'opp-2' });
    await repairApi.repairContext!('account', 'acc/1');
    await repairApi.repairPersonMergePreview!('person-target', 'person-source');
    await repairApi.repairPersonMerge!({ targetPersonId: 'person-target', sourcePersonId: 'person-source', roleConflictByOpportunity: { 'opp-1': 'keep_target' } }, 'person-merge-key');

    expect(fetchMock.mock.calls.map(([url, init]) => ({
      url,
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body,
    }))).toEqual([
      { url: 'http://localhost:3001/api/repair/account/acc%2F1', method: 'PATCH', body: JSON.stringify({ base, name: 'Correct' }) },
      { url: 'http://localhost:3001/api/repair/opportunity/opp%2F1', method: 'PATCH', body: JSON.stringify({ baseVersion: 3, status: 'paused' }) },
      { url: 'http://localhost:3001/api/repair/rebind', method: 'POST', body: JSON.stringify({ kind: 'note', id: 'note-1', accountId: 'acc-2', opportunityId: 'opp-2' }) },
      { url: 'http://localhost:3001/api/repair/context/account/acc%2F1', method: 'GET', body: undefined },
      { url: 'http://localhost:3001/api/repair/person-merge/preview?targetPersonId=person-target&sourcePersonId=person-source', method: 'GET', body: undefined },
      { url: 'http://localhost:3001/api/repair/person-merge', method: 'POST', body: JSON.stringify({ targetPersonId: 'person-target', sourcePersonId: 'person-source', roleConflictByOpportunity: { 'opp-1': 'keep_target' } }) },
    ]);
    expect(((fetchMock.mock.calls[5][1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('person-merge-key');
  });

  it('creates MCP tokens through a server-owned preset without sending raw scopes', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response(200, {
      id: 'at-test', name: 'Research', token: 'jh_one-time', lastFour: 'time',
      preset: 'research_proposal', scopes: ['read', 'propose_people', 'propose_relations', 'submit_evidence'], tokenVersion: 1,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await api.accessTokenCreate('Research', 'research_proposal');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3001/api/access-tokens');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: 'Research', preset: 'research_proposal' });
  });
});
