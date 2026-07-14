import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, isConfirmedAuthFailure, request } from './api';

const response = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'stable-command-key' });
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({ 'Idempotency-Key': 'stable-command-key' });
  });
});
