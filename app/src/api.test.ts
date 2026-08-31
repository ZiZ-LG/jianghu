import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleProductAccess,
  type AgentManualRunRequest,
  type PostMeetingReviewRequest,
} from '@jianghu/domain-contracts';
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
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('typed API failures', () => {
  it('rejects a successful auth envelope when product access is missing or malformed', async () => {
    const base = {
      token: 'token-1',
      user: { id: 'user-1', phone: null, email: 'user@example.test', name: 'User', role: 'owner' },
      tenant: { id: 'tenant-1', name: 'Tenant', plan: 'free', subscriptionStatus: 'active', seatLimit: 50 },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, base))
      .mockResolvedValueOnce(response(200, {
        ...base,
        product: { valid: true, edition: 'commercial', shell: 'unknown', policy: {}, navigation: [] },
      }))
      .mockResolvedValueOnce(response(200, {
        ...base,
        user: { ...base.user, role: 'root' },
        product: assembleProductAccess({ edition: 'commercial' }),
      })));

    await expect(api.login({ email: 'user@example.test', password: 'password-123' }))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    await expect(api.me())
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    await expect(api.register({
      email: 'user@example.test', password: 'password-123', name: 'User', tenantName: 'Tenant',
    })).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });

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

  it('does not retry an old-session command with the new session bearer', async () => {
    const firstResponse = deferred<Response>();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => firstResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    api.setToken('token-a');

    const pending = api.voiceExtract({ text: 'A 租户口述情报' }, 'voice-session-key');
    expect(((fetchMock.mock.calls[0][1] as RequestInit).headers as Headers).get('Authorization')).toBe('Bearer token-a');

    api.setToken('token-b');
    firstResponse.reject(new TypeError('network lost'));

    await expect(pending).rejects.toMatchObject({ code: 'session_reset', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry after a logout/login cycle even if the bearer string is unchanged', async () => {
    const firstResponse = deferred<Response>();
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => firstResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    api.setToken('same-token');

    const pending = api.voiceExtract({ text: '旧会话载荷' }, 'same-token-session-key');
    api.setToken(null);
    api.setToken('same-token');
    firstResponse.reject(new TypeError('network lost'));

    await expect(pending).rejects.toMatchObject({ code: 'session_reset', retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('sends Commitment commands through the dedicated retry-safe endpoint', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(response(200, {
        commitmentId: 'commitment_00000000000000000000000000000001',
        customerId: 'customer-1', matterId: 'matter-1', executionStatus: 'planned',
        confirmationStatus: 'not_required', version: 0, scheduleVersion: 0,
        nextCommitmentId: null, linkedFromCommitmentId: null, undoable: false,
        repairCommands: ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT'], replayed: true,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = {
      type: 'CREATE_COMMITMENT' as const,
      commitment: {
        id: 'commitment_00000000000000000000000000000001', customerId: 'customer-1', matterId: 'matter-1', personId: null,
        title: '下一步', kind: 'task', ownerUserId: 'user-1', confirmationStatus: 'not_required' as const,
        scheduledAtUtc: null, dueAtUtc: null, timeZone: 'Asia/Shanghai', isAllDay: true,
        localDate: '2026-09-10', confirmationDueAtUtc: null, source: 'manual', sourceRef: null,
        hypothesisRef: null,
      },
    };

    await api.commitment(payload, 'stable-commitment-key');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('http://localhost:3001/api/commands/commitment');
      expect(((init as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('stable-commitment-key');
      expect(JSON.parse(String((init as RequestInit).body))).toEqual(payload);
    }
  });

  it('rejects malformed or command-mismatched Commitment success receipts', async () => {
    const payload = {
      type: 'CONFIRM_COMMITMENT' as const,
      customerId: 'customer-1',
      commitmentId: 'commitment_00000000000000000000000000000001',
      baseVersion: 2,
      expectedScheduleVersion: 3,
      confirmedAtUtc: '2026-08-23T19:00:00.000Z',
    };
    const validReceipt = {
      commitmentId: payload.commitmentId,
      customerId: payload.customerId,
      matterId: 'matter-1',
      executionStatus: 'planned',
      confirmationStatus: 'confirmed',
      version: 3,
      scheduleVersion: 3,
      nextCommitmentId: null,
      linkedFromCommitmentId: null,
      undoable: false,
      repairCommands: ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT'],
      replayed: false,
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { ...validReceipt, replayed: undefined }))
      .mockResolvedValueOnce(response(200, {
        ...validReceipt,
        commitmentId: 'commitment_99999999999999999999999999999999',
      }))
      .mockResolvedValueOnce(response(200, { ...validReceipt, version: 2 }))
      .mockResolvedValueOnce(response(200, { ...validReceipt, scheduleVersion: 4 })));

    await expect(api.commitment(payload, 'commitment-missing-replayed')).rejects.toMatchObject({
      code: 'invalid_response', retryable: false,
    });
    await expect(api.commitment(payload, 'commitment-wrong-target')).rejects.toMatchObject({
      code: 'invalid_response', retryable: false,
    });
    await expect(api.commitment(payload, 'commitment-wrong-version')).rejects.toMatchObject({
      code: 'invalid_response', retryable: false,
    });
    await expect(api.commitment(payload, 'commitment-wrong-schedule-version')).rejects.toMatchObject({
      code: 'invalid_response', retryable: false,
    });
  });

  it('sends the atomic Quick Capture command with one frozen key across network retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(response(200, {
        customer: null,
        commitment: {
          commitmentId: 'commitment_00000000000000000000000000000001',
          customerId: 'customer-1', matterId: null, executionStatus: 'planned',
          confirmationStatus: 'not_required', version: 0, scheduleVersion: 0,
          nextCommitmentId: null, linkedFromCommitmentId: null, undoable: false,
          repairCommands: ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT'],
        },
        replayed: true,
      }));
    vi.stubGlobal('fetch', fetchMock);
    const payload = {
      customer: { mode: 'existing' as const, customerId: 'customer-1' },
      commitment: {
        type: 'CREATE_COMMITMENT' as const,
        commitment: {
          id: 'commitment_00000000000000000000000000000001',
          customerId: 'customer-1', matterId: null, personId: null,
          title: '下一步', kind: 'follow_up' as const, ownerUserId: 'user-1',
          confirmationStatus: 'not_required' as const,
          scheduledAtUtc: '2026-08-27T07:00:00.000Z', dueAtUtc: null,
          timeZone: 'Asia/Shanghai', isAllDay: false as const, localDate: null,
          confirmationDueAtUtc: null, source: 'manual_quick_capture' as const, sourceRef: null,
          hypothesisRef: null,
        },
      },
    };

    await api.quickCapture(payload, 'stable-quick-capture-key');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('http://localhost:3001/api/commands/quick-capture');
      expect(((init as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('stable-quick-capture-key');
      expect(JSON.parse(String((init as RequestInit).body))).toEqual(payload);
    }
  });

  it('rejects malformed or mismatched Quick Capture success receipts', async () => {
    const payload = {
      customer: { mode: 'existing' as const, customerId: 'customer-1' },
      commitment: {
        type: 'CREATE_COMMITMENT' as const,
        commitment: {
          id: 'commitment_00000000000000000000000000000001',
          customerId: 'customer-1', matterId: null, personId: null,
          title: '下一步', kind: 'follow_up' as const, ownerUserId: 'user-1',
          confirmationStatus: 'not_required' as const,
          scheduledAtUtc: '2026-08-27T07:00:00.000Z', dueAtUtc: null,
          timeZone: 'Asia/Shanghai', isAllDay: false as const, localDate: null,
          confirmationDueAtUtc: null, source: 'manual_quick_capture' as const, sourceRef: null,
          hypothesisRef: null,
        },
      },
    };
    const validReceipt = {
      customer: null,
      commitment: {
        commitmentId: payload.commitment.commitment.id,
        customerId: payload.customer.customerId,
        matterId: null,
        executionStatus: 'planned', confirmationStatus: 'not_required',
        version: 0, scheduleVersion: 0, nextCommitmentId: null,
        linkedFromCommitmentId: null, undoable: false,
        repairCommands: ['RESCHEDULE_COMMITMENT', 'CANCEL_COMMITMENT'],
      },
      replayed: false,
    };

    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, {}))
      .mockResolvedValueOnce(response(200, {
        ...validReceipt,
        commitment: { ...validReceipt.commitment, commitmentId: 'commitment_00000000000000000000000000009999' },
      })));

    await expect(api.quickCapture(payload, 'malformed-quick-capture-key')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(api.quickCapture(payload, 'mismatched-quick-capture-key')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('reads and runtime-validates the fixed Today intervention contract', async () => {
    const validToday = {
      generatedAtUtc: '2026-08-23T19:00:00.000Z',
      sections: [
        { key: 'pending_confirmation', label: '待确认', items: [] },
        { key: 'follow_up', label: '待跟进', items: [] },
        { key: 'completed', label: '已完成', items: [] },
      ],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, validToday))
      .mockResolvedValueOnce(response(200, {
        ...validToday,
        sections: [{ key: 'follow_up', label: '待跟进', items: [] }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.today()).resolves.toEqual(validToday);
    await expect(api.today()).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3001/api/today',
      'http://localhost:3001/api/today',
    ]);
  });

  it('reads and runtime-validates the strict generic CRM context snapshot', async () => {
    const validContext = {
      generatedAtUtc: '2026-08-23T23:50:00.000Z',
      customers: [{
        id: 'customer-1', name: '通用客户', categoryKey: null,
        primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
      }],
      matters: [{
        id: 'matter-1', customerId: 'customer-1', title: '联合研究', kind: 'general',
        lifecycleStatus: 'active', outcomeKey: null, priority: null, targetDate: null,
        primaryOwnerUserId: 'user-1', archivedAt: null, version: 0,
      }],
      people: [{
        id: 'person-1', customerId: 'customer-1', name: '李总', title: null,
        archivedAt: null, version: 0,
      }],
      matterParticipants: [{
        id: 'participant-1', customerId: 'customer-1', matterId: 'matter-1', personId: 'person-1',
      }],
      relations: [{
        id: 'relation-1', customerId: 'customer-1', matterId: 'matter-1',
        sourcePersonId: 'person-1', targetPersonId: 'person-1', kind: 'introduced_by',
        label: null, directed: false, version: 0,
      }],
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, validContext))
      .mockResolvedValueOnce(response(200, {
        ...validContext,
        customers: [{ ...validContext.customers[0], customerType: 1 }],
      }))
      .mockResolvedValueOnce(response(200, {
        ...validContext,
        relations: [{ ...validContext.relations[0], targetPersonId: 'missing-person' }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.crmContext()).resolves.toEqual(validContext);
    await expect(api.crmContext()).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    await expect(api.crmContext()).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3001/api/crm/context',
      'http://localhost:3001/api/crm/context',
      'http://localhost:3001/api/crm/context',
    ]);
  });

  it('revalidates an exact Today source revision before drill-down', async () => {
    const sourceRef = {
      entityKind: 'commitment', entityId: 'commitment/1', version: 2, scheduleVersion: 3,
    };
    const validSource = {
      sourceRef,
      customerId: 'customer-1',
      matterId: 'matter-1',
      label: '确认周一会议',
      detail: '计划中 · 待确认',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, validSource))
      .mockResolvedValueOnce(response(200, {
        ...validSource,
        sourceRef: { ...sourceRef, entityId: 'different-commitment' },
      }))
      .mockResolvedValueOnce(response(200, {
        ...validSource,
        sourceRef: { ...sourceRef, entityId: 'x'.repeat(20_000) },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.todaySource(sourceRef)).resolves.toEqual(validSource);
    await expect(api.todaySource(sourceRef)).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    const longSourceRef = { ...sourceRef, entityId: 'x'.repeat(20_000) };
    await expect(api.todaySource(longSourceRef)).resolves.toMatchObject({ sourceRef: longSourceRef });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3001/api/today/source',
      'http://localhost:3001/api/today/source',
      'http://localhost:3001/api/today/source',
    ]);
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'POST', 'POST']);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual(longSourceRef);
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

  it('uses strict post-meeting endpoints and keeps command idempotency keys stable across network retry', async () => {
    const job = {
      jobKey: 'post_meeting_extract', jobVersion: 'core-206.v1', purpose: '会后候选提取',
      triggers: ['manual'],
      scopeManifest: {
        customer: 'required', matter: 'required', sourceArtifact: 'required',
        allowedSourceKinds: ['transcript', 'uploaded_file', 'note'],
        allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
      },
      actionMode: 'candidate',
      evidencePolicy: { required: true, minimumRefs: 1, maximumRefs: 20, requireSourceFingerprint: true },
      outputRefKinds: ['review_batch'], modelRef: 'tenant_byo_model', connectorRefs: [],
      budget: { maxInputRefs: 3, maxEvidenceRefs: 20, maxOutputRefs: 1, maxCostUnits: 2_000 },
      timeoutMs: 45_000, maxAttempts: 2, available: true, enabled: true,
      controlState: 'valid', controlVersion: 1,
      limits: { maxCostUnits: 2_000, timeoutMs: 45_000, maxAttempts: 2 },
    };
    const run = {
      id: 'agent_run_1', jobKey: 'post_meeting_extract', jobVersion: 'core-206.v1',
      actionMode: 'candidate', trigger: 'manual', status: 'succeeded',
      customerId: 'customer/1', matterId: 'matter/1', sourceArtifactId: 'source/1', actorId: 'user-1',
      attemptCount: 1, maxAttempts: 2, budgetLimit: 2_000, costUsed: 5, timeoutMs: 45_000,
      authorizationFingerprint: 'a'.repeat(64), modelRef: 'tenant_byo_model', connectorRefs: [],
      inputRefs: [
        { kind: 'customer', id: 'customer/1', version: 2 },
        { kind: 'matter', id: 'matter/1', version: 3 },
        { kind: 'source_artifact', id: 'source/1', version: 4 },
      ],
      evidenceRefs: [{
        sourceArtifactId: 'source/1', locatorId: 'item-001:chars:0-4',
        sourceFingerprint: 'b'.repeat(64), observedAt: '2026-08-25T18:00:00.000Z',
      }],
      outputRefs: [{ kind: 'review_batch', id: 'review/batch-1', version: 0 }], failureCode: '',
      createdAt: '2026-08-25T18:00:00.000Z', startedAt: '2026-08-25T18:00:00.000Z',
      completedAt: '2026-08-25T18:00:01.000Z', version: 1,
    };
    const source = {
      id: 'source/1', accountId: 'customer/1', matterId: 'matter/1', personId: null,
      backingKind: 'note', artifactKind: 'note', source: 'manual', externalRef: null,
      title: '会谈', occurredAt: '2026-08-25T18:00:00.000Z', fingerprintKind: 'content_sha256_v1',
      sourceFingerprint: 'b'.repeat(64), retentionState: 'available',
      retentionUpdatedAt: '2026-08-25T18:00:00.000Z', createdByUserId: 'user-1', visibility: 'private',
      aclVersion: 4, createdAt: '2026-08-25T18:00:00.000Z', updatedAt: '2026-08-25T18:00:00.000Z',
      backingPresent: true, contentAvailable: true, canDegrade: false, canDelete: true,
      explanation: 'local_body_available',
    };
    const detail = {
      id: 'review/batch-1',
      source: { id: 'source/1', title: '会谈', kind: 'note', fingerprint: 'b'.repeat(64), occurredAt: '2026-08-25T18:00:00.000Z' },
      customerId: 'customer/1', matterId: 'matter/1', status: 'pending', activityKind: null,
      occurredAt: null, interactionId: null, acceptanceVersion: 0, version: 0,
      createdAt: '2026-08-25T18:00:01.000Z', updatedAt: '2026-08-25T18:00:01.000Z',
      items: [{
        kind: 'field', candidateId: 'candidate-field', status: 'pending', itemRef: 'item-001',
        expectedVersion: 1, expectedAclVersion: 4, sourceLocator: 'item-001:chars:0-4',
        sourceQuote: '优先级 high', confidence: 0.8, defaultSelected: false,
        target: { kind: 'matter', field: 'priority' }, before: 'normal', after: 'high',
      }],
    };
    const reviewRequest: PostMeetingReviewRequest = {
      expectedVersion: 0, expectedAcceptanceVersion: 0,
      customerId: 'customer/1', matterId: 'matter/1', activityKind: 'customer_meeting',
      occurredAt: '2026-08-25T18:00:00.000Z', existingInteractionId: null,
      decisions: [{
        kind: 'field', candidateId: 'candidate-field', expectedVersion: 1,
        expectedAclVersion: 4, decision: 'accept', edit: { value: 'high' },
      }],
    };
    const success = {
      batchId: 'review/batch-1', status: 'accepted', interactionId: 'interaction-1',
      version: 1, acceptanceVersion: 1, items: [{
        candidateId: 'candidate-field', decision: 'accept', status: 'accepted',
        formalKind: 'matter', formalId: 'matter/1',
      }], businessReplayed: false, replayed: false,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { items: [job] }))
      .mockResolvedValueOnce(response(200, { items: [run], nextCursor: null }))
      .mockResolvedValueOnce(response(200, { items: [source], nextCursor: null }))
      .mockResolvedValueOnce(response(200, detail))
      .mockResolvedValueOnce(response(200, { ...job, enabled: false, controlVersion: 2, replayed: false }))
      .mockRejectedValueOnce(new TypeError('run response lost'))
      .mockResolvedValueOnce(response(200, { run, replayed: true }))
      .mockRejectedValueOnce(new TypeError('review response lost'))
      .mockResolvedValueOnce(response(200, { ...success, replayed: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.postMeetingJobCards()).resolves.toEqual({ items: [job] });
    await expect(api.postMeetingRuns()).resolves.toEqual({ items: [run], nextCursor: null });
    await expect(api.postMeetingSources('customer/1', 'matter/1')).resolves.toHaveLength(1);
    await expect(api.postMeetingReview('review/batch-1')).resolves.toEqual(detail);
    await expect(api.postMeetingControl('core-206.v1', false, 1, 'control-key'))
      .resolves.toMatchObject({ card: { enabled: false, controlVersion: 2 }, replayed: false });
    const runRequest: AgentManualRunRequest = {
      jobVersion: 'core-206.v1', customerId: 'customer/1', matterId: 'matter/1',
      sourceArtifactId: 'source/1', inputRefs: [
        { kind: 'customer', id: 'customer/1', version: 2 },
        { kind: 'matter', id: 'matter/1', version: 3 },
        { kind: 'source_artifact', id: 'source/1', version: 4 },
      ],
    };
    await expect(api.postMeetingRun(runRequest, 'run-key'))
      .resolves.toMatchObject({ replayed: true, run: { id: 'agent_run_1' } });
    await expect(api.postMeetingAccept('review/batch-1', reviewRequest, 'review-key'))
      .resolves.toMatchObject({ replayed: true, batchId: 'review/batch-1' });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3001/api/agent-jobs',
      'http://localhost:3001/api/agent-runs?limit=50',
      'http://localhost:3001/api/source-artifacts?accountId=customer%2F1&matterId=matter%2F1&limit=100',
      'http://localhost:3001/api/review-batches/review%2Fbatch-1',
      'http://localhost:3001/api/agent-jobs/post_meeting_extract/control',
      'http://localhost:3001/api/agent-jobs/post_meeting_extract/runs',
      'http://localhost:3001/api/agent-jobs/post_meeting_extract/runs',
      'http://localhost:3001/api/review-batches/review%2Fbatch-1/accept',
      'http://localhost:3001/api/review-batches/review%2Fbatch-1/accept',
    ]);
    for (const index of [5, 6]) {
      expect(((fetchMock.mock.calls[index]![1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('run-key');
    }
    for (const index of [7, 8]) {
      expect(((fetchMock.mock.calls[index]![1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('review-key');
    }
  });

  it('fails closed on malformed post-meeting responses and preserves typed 409 item conflicts', async () => {
    const conflict = {
      code: 'review_batch_conflict',
      items: [{ candidateId: 'candidate-field', status: 'conflict', reason: 'candidate_version_conflict' }],
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { items: [], rawResponse: 'private' }))
      .mockResolvedValueOnce(response(409, conflict)));
    await expect(api.postMeetingJobCards()).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(api.postMeetingAccept('review-1', {
      expectedVersion: 0, expectedAcceptanceVersion: 0, customerId: 'customer-1', matterId: null,
      activityKind: 'meeting', occurredAt: '2026-08-25T18:00:00.000Z', existingInteractionId: null,
      decisions: [{
        kind: 'field', candidateId: 'candidate-field', expectedVersion: 1,
        expectedAclVersion: 1, decision: 'accept', edit: { value: 'high' },
      }],
    }, 'conflict-key')).rejects.toMatchObject({
      status: 409,
      code: 'review_batch_conflict',
      cause: conflict,
    });
  });
});

describe('pre-meeting brief API', () => {
  const job = {
    jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1', purpose: '拜访前简报',
    triggers: ['manual'], scopeManifest: {
      customer: 'required', matter: 'optional', sourceArtifact: 'optional',
      allowedSourceKinds: ['note'], allowedInputRefKinds: ['customer', 'matter', 'source_artifact'],
    }, actionMode: 'read_only', evidencePolicy: {
      required: true, minimumRefs: 1, maximumRefs: 20, requireSourceFingerprint: true,
    }, outputRefKinds: ['research_brief'], modelRef: 'tenant-byo-ai', connectorRefs: [],
    budget: { maxInputRefs: 50, maxEvidenceRefs: 20, maxOutputRefs: 10, maxCostUnits: 1_000 },
    timeoutMs: 30_000, maxAttempts: 2, available: true, enabled: true,
    controlState: 'valid', controlVersion: 2,
    limits: { maxCostUnits: 1_000, timeoutMs: 30_000, maxAttempts: 2 },
  };
  const runInput: AgentManualRunRequest = {
    jobVersion: 'core-206.v1', customerId: 'customer/205', matterId: 'matter/205',
    sourceArtifactId: 'source/205', inputRefs: [
      { kind: 'customer', id: 'customer/205', version: 4 },
      { kind: 'matter', id: 'matter/205', version: 2 },
      { kind: 'source_artifact', id: 'source/205', version: 3 },
    ],
  };
  const run = {
    id: 'run-205', jobKey: 'pre_meeting_brief', jobVersion: 'core-206.v1',
    actionMode: 'read_only', trigger: 'manual', status: 'succeeded',
    customerId: runInput.customerId, matterId: runInput.matterId,
    sourceArtifactId: runInput.sourceArtifactId, actorId: 'user-205', attemptCount: 1,
    maxAttempts: 2, budgetLimit: 1_000, costUsed: 1, timeoutMs: 30_000,
    authorizationFingerprint: 'b'.repeat(64), modelRef: 'tenant-byo-ai', connectorRefs: [],
    inputRefs: runInput.inputRefs, evidenceRefs: [{
      sourceArtifactId: 'source/205', locatorId: 'pre-meeting-source',
      sourceFingerprint: 'a'.repeat(64), observedAt: '2026-08-27T06:00:00.000Z',
    }], outputRefs: [{ kind: 'research_brief', id: 'brief/205', version: 1 }],
    failureCode: '', createdAt: '2026-08-27T08:00:00.000Z',
    startedAt: '2026-08-27T08:00:00.000Z', completedAt: '2026-08-27T08:01:00.000Z',
    version: 2,
  };
  const source = {
    id: 'source/205', accountId: 'customer/205', matterId: 'matter/205', personId: null,
    backingKind: 'note', artifactKind: 'note', source: 'manual', externalRef: null,
    title: '客户访谈', occurredAt: '2026-08-27T06:00:00.000Z',
    fingerprintKind: 'content_sha256_v1', sourceFingerprint: 'a'.repeat(64),
    retentionState: 'available', retentionUpdatedAt: '2026-08-27T08:00:00.000Z',
    createdByUserId: 'user-205', visibility: 'private', aclVersion: 3,
    createdAt: '2026-08-27T08:00:00.000Z', updatedAt: '2026-08-27T08:00:00.000Z',
    backingPresent: true, contentAvailable: true, canDegrade: false, canDelete: true,
    explanation: 'local_body_available',
  };
  const metadata = {
    id: 'brief/205', customerId: 'customer/205', matterId: 'matter/205', status: 'blocked',
    subjectStatus: 'matched', sourceCount: 0, sectionCount: 0, unknownCount: 1,
    failureCount: 0, version: 1, basedOnAt: null, freshUntil: null,
    generatedAt: '2026-08-27T08:00:00.000Z', createdAt: '2026-08-27T08:01:00.000Z',
  };
  const detail = {
    ...metadata,
    payload: {
      subject: {
        status: 'matched', query: '海岳能源', crmCustomerId: 'customer/205',
        selected: {
          legalName: '海岳能源', anchorKind: 'provider_subject_id',
          anchorValue: 'customer/205', provider: 'jianghu-crm',
        }, candidates: [],
      },
      sources: [], sections: [], unknowns: [{
        key: 'questions_to_verify', question: '需要确认哪些关键问题？',
        reasonCode: 'insufficient_evidence', sourceIds: [],
      }], failures: [],
      generator: { version: 'saas-204.v1', modelRef: 'tenant-byo-ai', connectorRefs: [] },
    },
  };

  it('uses exact read and command endpoints with anchored requests and stable idempotency keys', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { items: [job] }))
      .mockResolvedValueOnce(response(200, { items: [run], nextCursor: null }))
      .mockResolvedValueOnce(response(200, { items: [source], nextCursor: null }))
      .mockResolvedValueOnce(response(200, { items: [metadata], nextCursor: null }))
      .mockResolvedValueOnce(response(200, { item: detail }))
      .mockResolvedValueOnce(response(200, { ...job, enabled: false, controlVersion: 3, replayed: false }))
      .mockResolvedValueOnce(response(200, { run, replayed: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.preMeetingJobCards()).resolves.toEqual({ items: [job] });
    await expect(api.preMeetingRuns()).resolves.toEqual({ items: [run], nextCursor: null });
    await expect(api.preMeetingSources('customer/205', 'matter/205')).resolves.toHaveLength(1);
    await expect(api.preMeetingBriefs('customer/205', 'matter/205')).resolves.toEqual({
      items: [metadata], nextCursor: null,
    });
    await expect(api.preMeetingBrief('brief/205')).resolves.toEqual(detail);
    await expect(api.preMeetingControl('core-206.v1', false, 2, 'control-205'))
      .resolves.toMatchObject({ card: { enabled: false, controlVersion: 3 }, replayed: false });
    await expect(api.preMeetingRun(runInput, 'run-205-key'))
      .resolves.toMatchObject({ run: { id: 'run-205' }, replayed: true });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3001/api/agent-jobs',
      'http://localhost:3001/api/agent-runs?limit=50',
      'http://localhost:3001/api/source-artifacts?accountId=customer%2F205&matterId=matter%2F205&limit=100',
      'http://localhost:3001/api/research-briefs?customerId=customer%2F205&matterId=matter%2F205&limit=50',
      'http://localhost:3001/api/research-briefs/brief%2F205',
      'http://localhost:3001/api/agent-jobs/pre_meeting_brief/control',
      'http://localhost:3001/api/agent-jobs/pre_meeting_brief/runs',
    ]);
    expect(((fetchMock.mock.calls[5]![1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('control-205');
    expect(((fetchMock.mock.calls[6]![1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('run-205-key');
    expect(JSON.parse(String((fetchMock.mock.calls[6]![1] as RequestInit).body))).toEqual(runInput);
  });

  it('fails closed on extra private fields, wrong detail IDs and mismatched run anchors', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, { items: [metadata], nextCursor: null, payloadEnc: 'private' }))
      .mockResolvedValueOnce(response(200, { item: { ...detail, id: 'brief-other' } }))
      .mockResolvedValueOnce(response(200, { run: { ...run, matterId: 'matter-other' }, replayed: false })));

    await expect(api.preMeetingBriefs('customer/205', 'matter/205'))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    await expect(api.preMeetingBrief('brief/205'))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    await expect(api.preMeetingRun(runInput, 'run-205-key'))
      .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
  });
});

describe('post-meeting import API', () => {
  const anchor = { customerId: 'customer/1', matterId: 'matter/1' };
  const source = {
    id: 'source/1', ...anchor, title: '客户会谈.md', kind: 'uploaded_file' as const,
    fingerprint: 'b'.repeat(64), aclVersion: 4, version: 4,
    occurredAt: '2026-08-25T18:00:00.000Z',
  };

  it('uses only the bounded import, provider, OAuth and lifecycle endpoints', async () => {
    const uploadReceipt = { source, replayed: false };
    const feishuSource = { ...source, id: 'source/2', title: '飞书妙记', kind: 'transcript' as const };
    const provider = {
      configured: true, appId: 'cli_safe', hasSecret: true, enabled: true,
      redirectUri: 'https://crm.lake2ocean.top/api/recording/oauth/feishu/callback',
    };
    const credentials = {
      credentials: [{
        source: 'feishu', status: 'active', expiresAt: '2026-08-26T20:00:00.000Z',
        updatedAt: '2026-08-25T18:00:00.000Z',
      }],
    };
    const lifecycle = {
      id: source.id, aclVersion: 4, visibility: 'private', retentionState: 'degraded',
      contentAvailable: false, backingPresent: true, replayed: false,
    };
    const deleted = { ...lifecycle, retentionState: 'deleted', backingPresent: false };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, uploadReceipt))
      .mockResolvedValueOnce(response(200, { source: feishuSource, replayed: false }))
      .mockResolvedValueOnce(response(200, provider))
      .mockResolvedValueOnce(response(200, credentials))
      .mockResolvedValueOnce(response(200, { ok: true, redirectUri: provider.redirectUri }))
      .mockResolvedValueOnce(response(200, {
        authUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_safe',
      }))
      .mockResolvedValueOnce(response(200, lifecycle))
      .mockResolvedValueOnce(response(200, deleted));
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['meeting body'], '客户会谈.md', { type: 'text/markdown' });
    await expect(api.postMeetingImportUpload(file, {
      ...anchor, occurredAt: '2026-08-25T18:00:00.000Z',
    }, 'upload-key')).resolves.toEqual(uploadReceipt);
    await expect(api.postMeetingImportFeishu({
      url: 'https://team.feishu.cn/minutes/minute_token_001', ...anchor,
    }, 'feishu-key')).resolves.toEqual({ source: feishuSource, replayed: false });
    await expect(api.postMeetingFeishuProviderStatus()).resolves.toEqual(provider);
    await expect(api.postMeetingRecordingCredentialStatus()).resolves.toEqual(credentials);
    await expect(api.postMeetingSaveFeishuProviderConfig({
      appId: 'cli_safe',
    })).resolves.toEqual({ ok: true, redirectUri: provider.redirectUri });
    await expect(api.postMeetingFeishuOAuthStart()).resolves.toEqual({
      authUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize?app_id=cli_safe',
    });
    await expect(api.postMeetingDegradeSource(source, 'degrade-key')).resolves.toEqual(lifecycle);
    await expect(api.postMeetingDeleteSource(source, 'delete-key')).resolves.toEqual(deleted);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://localhost:3001/api/post-meeting/import/upload?customerId=customer%2F1&matterId=matter%2F1&occurredAt=2026-08-25T18%3A00%3A00.000Z',
      'http://localhost:3001/api/post-meeting/import/feishu',
      'http://localhost:3001/api/recording/provider/feishu',
      'http://localhost:3001/api/recording/credentials',
      'http://localhost:3001/api/recording/provider/feishu',
      'http://localhost:3001/api/recording/oauth/feishu/start',
      'http://localhost:3001/api/source-artifacts/source%2F1/degrade',
      'http://localhost:3001/api/source-artifacts/source%2F1',
    ]);
    const uploadInit = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(uploadInit.body).toBeInstanceOf(FormData);
    expect((uploadInit.headers as Headers).has('Content-Type')).toBe(false);
    expect((uploadInit.headers as Headers).get('Idempotency-Key')).toBe('upload-key');
    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe(JSON.stringify({
      url: 'https://team.feishu.cn/minutes/minute_token_001', ...anchor,
    }));
    expect(((fetchMock.mock.calls[6]![1] as RequestInit).headers as Headers).get('Idempotency-Key')).toBe('degrade-key');
    expect(JSON.parse(String((fetchMock.mock.calls[7]![1] as RequestInit).body))).toEqual({ expectedAclVersion: 4 });
  });

  it('fails closed on mismatched mounts, lifecycle IDs and secret-bearing status responses', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200, {
        source: { ...source, matterId: 'matter/2' }, replayed: false,
      }))
      .mockResolvedValueOnce(response(200, {
        configured: true, appId: 'cli_safe', hasSecret: true, enabled: true,
        redirectUri: 'https://crm.lake2ocean.top/api/recording/oauth/feishu/callback',
        appSecret: 'must-not-cross',
      }))
      .mockResolvedValueOnce(response(200, {
        id: 'source/other', aclVersion: 4, visibility: 'private', retentionState: 'degraded',
        contentAvailable: false, backingPresent: true, replayed: false,
      })));

    await expect(api.postMeetingImportFeishu({
      url: 'minute_token_001', ...anchor,
    }, 'feishu-key')).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(api.postMeetingFeishuProviderStatus())
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(api.postMeetingDegradeSource(source, 'degrade-key'))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });
});
