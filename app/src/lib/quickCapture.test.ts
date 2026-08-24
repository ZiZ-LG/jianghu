import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickCaptureCommandSchema } from '@jianghu/domain-contracts';
import {
  buildQuickCaptureDraft,
  confirmQuickCaptureDraft,
  parseNaturalQuickCapture,
  saveAndRefreshQuickCaptureDraft,
  resolveBrowserTimeZone,
  zonedLocalDateTimeToUtc,
} from './quickCapture';

const IDS = {
  customer: 'customer_00000000000000000000000000000011',
  commitment: 'commitment_00000000000000000000000000000012',
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SAAS-102 quick capture model', () => {
  it('parses Cao manager wording into the next local Thursday without losing the source text', () => {
    const rawInput = '周四 15:00 与客户交流方案';
    const result = parseNaturalQuickCapture(rawInput, {
      now: new Date('2026-08-24T01:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    });
    expect(result).toEqual({
      ok: true,
      rawInput,
      title: '与客户交流方案',
      localDateTime: '2026-08-27T15:00',
    });
  });

  it('retains the exact input when optional parsing fails', () => {
    const rawInput = '下次找客户聊聊';
    expect(parseNaturalQuickCapture(rawInput, {
      now: new Date('2026-08-24T01:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    })).toEqual({
      ok: false,
      rawInput,
      error: '没有识别到“周几 + 时间”，请保留原文并手动补充时间。',
    });
  });

  it('retains and rejects an oversized natural-language input before parsing', () => {
    const rawInput = `周四 15:00 ${'交'.repeat(500)}`;
    expect(parseNaturalQuickCapture(rawInput, {
      now: new Date('2026-08-24T01:30:00.000Z'),
      timeZone: 'Asia/Shanghai',
    })).toEqual({
      ok: false,
      rawInput,
      error: '一句话快速填写不能超过 500 字。',
    });
  });

  it('converts a wall-clock time with its IANA zone instead of the CI machine zone', () => {
    expect(zonedLocalDateTimeToUtc('2026-08-27T15:00', 'Asia/Shanghai'))
      .toBe('2026-08-27T07:00:00.000Z');
    expect(zonedLocalDateTimeToUtc('2026-08-27T15:00', 'America/Los_Angeles'))
      .toBe('2026-08-27T22:00:00.000Z');
  });

  it('rejects spring-forward gaps and ambiguous fall-back wall-clock times', () => {
    expect(() => zonedLocalDateTimeToUtc('2026-03-08T02:30', 'America/Los_Angeles'))
      .toThrow('该本地时间在当前时区不存在，请选择其他时间');
    expect(() => zonedLocalDateTimeToUtc('2026-11-01T01:30', 'America/Los_Angeles'))
      .toThrow('该本地时间因夏令时切换存在两种可能，请选择其他时间');
  });

  it('keeps a future same-day time and advances a past same-day time by one week', () => {
    const options = { now: new Date('2026-08-24T02:00:00.000Z'), timeZone: 'Asia/Shanghai' };
    expect(parseNaturalQuickCapture('周一 11:00 交流方案', options)).toMatchObject({
      ok: true,
      localDateTime: '2026-08-24T11:00',
    });
    expect(parseNaturalQuickCapture('周一 09:00 交流方案', options)).toMatchObject({
      ok: true,
      localDateTime: '2026-08-31T09:00',
    });
  });

  it('normalizes browser UTC and falls back only for missing or non-IANA zones', () => {
    const resolved = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');
    resolved.mockReturnValue({ timeZone: 'UTC' } as Intl.ResolvedDateTimeFormatOptions);
    expect(resolveBrowserTimeZone()).toBe('Etc/UTC');
    resolved.mockReturnValue({ timeZone: 'America/Los_Angeles' } as Intl.ResolvedDateTimeFormatOptions);
    expect(resolveBrowserTimeZone()).toBe('America/Los_Angeles');
    resolved.mockReturnValue({ timeZone: 'GMT' } as Intl.ResolvedDateTimeFormatOptions);
    expect(resolveBrowserTimeZone()).toBe('Asia/Shanghai');
  });

  it('builds a valid inline Customer plus customer-level Commitment draft with no writes', () => {
    const submit = vi.fn();
    const draft = buildQuickCaptureDraft({
      customer: { mode: 'new', name: '远山制造' },
      title: '与客户交流方案',
      localDateTime: '2026-08-27T15:00',
      timeZone: 'Asia/Shanghai',
      matter: null,
      person: null,
      requiresConfirmation: false,
      confirmationDueLocalDateTime: '',
      actorUserId: 'user-cao',
    }, {
      createId: (prefix) => IDS[prefix as keyof typeof IDS],
      createIdempotencyKey: () => 'quick-capture-idempotency-key',
    });

    expect(QuickCaptureCommandSchema.safeParse(draft.command).success).toBe(true);
    expect(draft.command.customer).toMatchObject({
      mode: 'create',
      command: { customer: { id: IDS.customer, categoryKey: null, primaryOwnerUserId: 'user-cao' } },
    });
    expect(draft.command.commitment.commitment).toMatchObject({
      id: IDS.commitment,
      customerId: IDS.customer,
      matterId: null,
      personId: null,
      scheduledAtUtc: '2026-08-27T07:00:00.000Z',
      confirmationStatus: 'not_required',
    });
    expect(draft.summary.actions).toEqual(['创建客户', '创建下一步']);
    expect(submit).not.toHaveBeenCalled();
  });

  it('calls the formal application command only after explicit confirmation and keeps its retry key', async () => {
    const draft = buildQuickCaptureDraft({
      customer: { mode: 'existing', id: 'legacy-account-1', name: '既有客户' },
      title: '确认交流时间',
      localDateTime: '2026-08-27T15:00',
      timeZone: 'Asia/Shanghai',
      matter: null,
      person: null,
      requiresConfirmation: false,
      confirmationDueLocalDateTime: '',
      actorUserId: 'user-cao',
    }, {
      createId: () => IDS.commitment,
      createIdempotencyKey: () => 'stable-quick-capture-key',
    });
    const submit = vi.fn().mockResolvedValue({ replayed: false });

    expect(submit).not.toHaveBeenCalled();
    await confirmQuickCaptureDraft(draft, submit);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(draft.command, 'stable-quick-capture-key');
  });

  it('treats a failed state refresh as saved without resubmitting the formal command', async () => {
    const draft = buildQuickCaptureDraft({
      customer: { mode: 'existing', id: 'legacy-account-1', name: '既有客户' },
      title: '确认交流时间',
      localDateTime: '2026-08-27T15:00',
      timeZone: 'Asia/Shanghai',
      matter: null,
      person: null,
      requiresConfirmation: false,
      confirmationDueLocalDateTime: '',
      actorUserId: 'user-cao',
    }, {
      createId: () => IDS.commitment,
      createIdempotencyKey: () => 'stable-quick-capture-key',
    });
    const submit = vi.fn().mockResolvedValue({ replayed: false });
    const refresh = vi.fn().mockRejectedValue(new Error('state unavailable'));

    await expect(saveAndRefreshQuickCaptureDraft(draft, submit, refresh)).resolves.toMatchObject({
      saved: true,
      refreshed: false,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('creates the default retry key when an internal HTTP origin only exposes getRandomValues', () => {
    let fill = 0;
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(++fill);
        return bytes;
      },
    });

    const draft = buildQuickCaptureDraft({
      customer: { mode: 'existing', id: 'legacy-account-1', name: '既有客户' },
      title: '确认交流时间',
      localDateTime: '2026-08-27T15:00',
      timeZone: 'Asia/Shanghai',
      matter: null,
      person: null,
      requiresConfirmation: false,
      confirmationDueLocalDateTime: '',
      actorUserId: 'user-cao',
    });

    expect(draft.idempotencyKey).toBe(`command_${'02'.repeat(16)}`);
  });

  it.each([
    ['blank next step', { title: '  ' }, '请填写下一步'],
    ['blank actor', { actorUserId: '  ' }, '当前用户无效，请重新登录'],
    ['blank Customer name', { customer: { mode: 'new' as const, name: '  ' } }, '请选择客户或填写新客户名称'],
    ['oversized Customer name', { customer: { mode: 'new' as const, name: '客'.repeat(121) } }, '客户名称不能超过 120 字'],
    ['blank existing Customer id', { customer: { mode: 'existing' as const, id: '', name: '客户' } }, '请选择客户'],
    ['oversized next step', { title: '下'.repeat(201) }, '下一步不能超过 200 字'],
    ['missing event time', { localDateTime: '' }, '请填写有效的日期和时间'],
    ['missing confirmation deadline', { requiresConfirmation: true }, '请填写确认截止时间'],
  ])('rejects %s before a formal command can be submitted', (_label, patch, message) => {
    expect(() => buildQuickCaptureDraft({
      customer: { mode: 'existing', id: 'legacy-account-1', name: '既有客户' },
      title: '确认交流时间',
      localDateTime: '2026-08-27T15:00',
      timeZone: 'Asia/Shanghai',
      matter: null,
      person: null,
      requiresConfirmation: false,
      confirmationDueLocalDateTime: '',
      actorUserId: 'user-cao',
      ...patch,
    })).toThrow(message);
  });

  it('rejects new-Customer associations and accepts a confirmation deadline one minute before the event', () => {
    const base = {
      customer: { mode: 'new' as const, name: '远山制造' },
      title: '确认交流时间',
      localDateTime: '2026-08-27T15:00',
      timeZone: 'Asia/Shanghai',
      matter: null,
      person: null,
      requiresConfirmation: true,
      confirmationDueLocalDateTime: '2026-08-27T14:59',
      actorUserId: 'user-cao',
    };
    expect(() => buildQuickCaptureDraft({
      ...base,
      matter: { id: 'matter-1', name: '不应存在的事项' },
    })).toThrow('新客户尚无事项或联系人');
    const draft = buildQuickCaptureDraft(base);
    expect(draft.command.commitment.commitment).toMatchObject({
      confirmationStatus: 'pending',
      confirmationDueAtUtc: '2026-08-27T06:59:00.000Z',
    });
  });

  it('requires a confirmation deadline before the event when confirmation is enabled', () => {
    for (const confirmationDueLocalDateTime of ['2026-08-27T15:00', '2026-08-27T16:00']) {
      expect(() => buildQuickCaptureDraft({
        customer: { mode: 'existing', id: 'legacy-account-1', name: '既有客户' },
        title: '确认交流时间',
        localDateTime: '2026-08-27T15:00',
        timeZone: 'Asia/Shanghai',
        matter: null,
        person: null,
        requiresConfirmation: true,
        confirmationDueLocalDateTime,
        actorUserId: 'user-cao',
      }, {
        createId: () => IDS.commitment,
        createIdempotencyKey: () => 'stable-quick-capture-key',
      })).toThrow('确认截止时间必须早于下一步时间');
    }
  });
});
