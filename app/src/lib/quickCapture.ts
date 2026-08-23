import {
  CUSTOMER_NAME_MAX_LENGTH,
  QUICK_CAPTURE_TITLE_MAX_LENGTH,
  QuickCaptureCommandSchema,
  type QuickCaptureCommand,
} from '@jianghu/domain-contracts';
import { createOpaqueEntityId } from './opaqueId';

export type QuickCaptureCustomerInput =
  | { mode: 'existing'; id: string; name: string }
  | { mode: 'new'; name: string };

export interface QuickCaptureInput {
  customer: QuickCaptureCustomerInput;
  title: string;
  localDateTime: string;
  timeZone: string;
  matter: { id: string; name: string } | null;
  person: { id: string; name: string } | null;
  requiresConfirmation: boolean;
  confirmationDueLocalDateTime: string;
  actorUserId: string;
}

export interface QuickCaptureDraft {
  command: QuickCaptureCommand;
  idempotencyKey: string;
  summary: {
    customerName: string;
    title: string;
    localDateTime: string;
    timeZone: string;
    matterName: string | null;
    personName: string | null;
    confirmationDueLocalDateTime: string | null;
    actions: Array<'创建客户' | '创建下一步'>;
  };
}

interface BuildDependencies {
  createId: (prefix: 'customer' | 'commitment') => string;
  createIdempotencyKey: () => string;
}

const DEFAULT_BUILD_DEPENDENCIES: BuildDependencies = {
  createId: createOpaqueEntityId,
  createIdempotencyKey: () => createOpaqueEntityId('command'),
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    calendar: 'gregory',
    numberingSystem: 'latn',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const result = {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
  };
  if (Object.values(result).some((value) => !Number.isInteger(value))) throw new Error('无法读取当前时区');
  return result;
}

function parseLocalDateTime(value: string): ZonedParts {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error('请填写有效的日期和时间');
  const result = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  const calendar = new Date(Date.UTC(result.year, result.month - 1, result.day));
  if (calendar.getUTCFullYear() !== result.year
    || calendar.getUTCMonth() !== result.month - 1
    || calendar.getUTCDate() !== result.day
    || result.hour > 23
    || result.minute > 59) {
    throw new Error('请填写有效的日期和时间');
  }
  return result;
}

const utcEpoch = (parts: ZonedParts) => Date.UTC(
  parts.year,
  parts.month - 1,
  parts.day,
  parts.hour,
  parts.minute,
);

const MAX_TIME_ZONE_CONVERGENCE_ATTEMPTS = 4;
const TIME_ZONE_AMBIGUITY_PROBE_MS = 36 * 60 * 60 * 1000;
export const QUICK_CAPTURE_NATURAL_TEXT_MAX_LENGTH = 500;

const sameZonedParts = (left: ZonedParts, right: ZonedParts): boolean => (
  left.year === right.year
  && left.month === right.month
  && left.day === right.day
  && left.hour === right.hour
  && left.minute === right.minute
);

/** Converts an explicit wall-clock value using its IANA zone, independent of the host machine zone. */
export function zonedLocalDateTimeToUtc(localDateTime: string, timeZone: string): string {
  const target = parseLocalDateTime(localDateTime);
  const targetEpoch = utcEpoch(target);
  let candidateEpoch = targetEpoch;
  for (let attempt = 0; attempt < MAX_TIME_ZONE_CONVERGENCE_ATTEMPTS; attempt += 1) {
    const renderedEpoch = utcEpoch(zonedParts(new Date(candidateEpoch), timeZone));
    const delta = targetEpoch - renderedEpoch;
    candidateEpoch += delta;
    if (delta === 0) break;
  }
  const rendered = zonedParts(new Date(candidateEpoch), timeZone);
  if (utcEpoch(rendered) !== targetEpoch) throw new Error('该本地时间在当前时区不存在，请选择其他时间');

  const possibleInstants = new Set<number>();
  for (const probeEpoch of [
    candidateEpoch - TIME_ZONE_AMBIGUITY_PROBE_MS,
    candidateEpoch,
    candidateEpoch + TIME_ZONE_AMBIGUITY_PROBE_MS,
  ]) {
    const offset = utcEpoch(zonedParts(new Date(probeEpoch), timeZone)) - probeEpoch;
    const possibleEpoch = targetEpoch - offset;
    if (sameZonedParts(zonedParts(new Date(possibleEpoch), timeZone), target)) {
      possibleInstants.add(possibleEpoch);
    }
  }
  if (possibleInstants.size > 1) {
    throw new Error('该本地时间因夏令时切换存在两种可能，请选择其他时间');
  }
  return new Date(candidateEpoch).toISOString();
}

export function resolveBrowserTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timeZone === 'UTC') return 'Etc/UTC';
  return timeZone && timeZone.includes('/') ? timeZone : 'Asia/Shanghai';
}

export type NaturalQuickCaptureResult =
  | { ok: true; rawInput: string; title: string; localDateTime: string }
  | { ok: false; rawInput: string; error: string };

const WEEKDAY = new Map([
  ['日', 0], ['天', 0], ['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6],
]);

const two = (value: number) => String(value).padStart(2, '0');

export function parseNaturalQuickCapture(
  rawInput: string,
  options: { now?: Date; timeZone: string },
): NaturalQuickCaptureResult {
  if (rawInput.length > QUICK_CAPTURE_NATURAL_TEXT_MAX_LENGTH) {
    return {
      ok: false,
      rawInput,
      error: `一句话快速填写不能超过 ${QUICK_CAPTURE_NATURAL_TEXT_MAX_LENGTH} 字。`,
    };
  }
  const match = rawInput.match(/周([一二三四五六日天])\s*(\d{1,2})(?:[:：](\d{2})|点(?:(\d{1,2})分?)?)/);
  if (!match) {
    return { ok: false, rawInput, error: '没有识别到“周几 + 时间”，请保留原文并手动补充时间。' };
  }
  const targetWeekday = WEEKDAY.get(match[1] ?? '');
  const hour = Number(match[2]);
  const minute = Number(match[3] ?? match[4] ?? '0');
  if (targetWeekday === undefined || hour > 23 || minute > 59) {
    return { ok: false, rawInput, error: '识别到的时间无效，请保留原文并手动补充时间。' };
  }
  const title = rawInput.slice(0, match.index)
    .concat(rawInput.slice((match.index ?? 0) + match[0].length))
    .trim()
    .replace(/^[，,。；;：:\s]+/, '');
  if (!title) return { ok: false, rawInput, error: '还需要补充下一步内容。' };

  const now = options.now ?? new Date();
  const localNow = zonedParts(now, options.timeZone);
  const localCalendar = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day));
  const currentWeekday = localCalendar.getUTCDay();
  let daysAhead = (targetWeekday - currentWeekday + 7) % 7;
  if (daysAhead === 0 && (hour * 60 + minute) <= (localNow.hour * 60 + localNow.minute)) daysAhead = 7;
  localCalendar.setUTCDate(localCalendar.getUTCDate() + daysAhead);
  const localDateTime = `${localCalendar.getUTCFullYear()}-${two(localCalendar.getUTCMonth() + 1)}-${two(localCalendar.getUTCDate())}T${two(hour)}:${two(minute)}`;
  try {
    zonedLocalDateTimeToUtc(localDateTime, options.timeZone);
  } catch (cause) {
    return { ok: false, rawInput, error: cause instanceof Error ? cause.message : '识别到的时间无效。' };
  }
  return { ok: true, rawInput, title, localDateTime };
}

export function buildQuickCaptureDraft(
  input: QuickCaptureInput,
  dependencies: BuildDependencies = DEFAULT_BUILD_DEPENDENCIES,
): QuickCaptureDraft {
  const title = input.title.trim();
  if (!title) throw new Error('请填写下一步');
  if (title.length > QUICK_CAPTURE_TITLE_MAX_LENGTH) {
    throw new Error(`下一步不能超过 ${QUICK_CAPTURE_TITLE_MAX_LENGTH} 字`);
  }
  const actorUserId = input.actorUserId.trim();
  if (!actorUserId) throw new Error('当前用户无效，请重新登录');
  if (input.customer.mode === 'new' && (input.matter || input.person)) {
    throw new Error('新客户尚无事项或联系人');
  }

  const customerName = input.customer.name.trim();
  if (!customerName) throw new Error('请选择客户或填写新客户名称');
  if (input.customer.mode === 'new' && customerName.length > CUSTOMER_NAME_MAX_LENGTH) {
    throw new Error(`客户名称不能超过 ${CUSTOMER_NAME_MAX_LENGTH} 字`);
  }
  const customerId = input.customer.mode === 'existing'
    ? input.customer.id
    : dependencies.createId('customer');
  if (!customerId) throw new Error('请选择客户');
  const commitmentId = dependencies.createId('commitment');
  const scheduledAtUtc = zonedLocalDateTimeToUtc(input.localDateTime, input.timeZone);
  let confirmationDueAtUtc: string | null = null;
  if (input.requiresConfirmation) {
    if (!input.confirmationDueLocalDateTime) throw new Error('请填写确认截止时间');
    confirmationDueAtUtc = zonedLocalDateTimeToUtc(input.confirmationDueLocalDateTime, input.timeZone);
    if (confirmationDueAtUtc >= scheduledAtUtc) throw new Error('确认截止时间必须早于下一步时间');
  }

  const command = QuickCaptureCommandSchema.parse({
    customer: input.customer.mode === 'existing'
      ? { mode: 'existing', customerId }
      : {
          mode: 'create',
          command: {
            type: 'CREATE_CUSTOMER',
            customer: {
              id: customerId,
              name: customerName,
              categoryKey: null,
              primaryOwnerUserId: actorUserId,
            },
          },
        },
    commitment: {
      type: 'CREATE_COMMITMENT',
      commitment: {
        id: commitmentId,
        customerId,
        matterId: input.matter?.id ?? null,
        personId: input.person?.id ?? null,
        title,
        kind: 'follow_up',
        ownerUserId: actorUserId,
        confirmationStatus: input.requiresConfirmation ? 'pending' : 'not_required',
        scheduledAtUtc,
        dueAtUtc: null,
        timeZone: input.timeZone,
        isAllDay: false,
        localDate: null,
        confirmationDueAtUtc,
        source: 'manual_quick_capture',
        sourceRef: null,
      },
    },
  });

  return {
    command,
    idempotencyKey: dependencies.createIdempotencyKey(),
    summary: {
      customerName,
      title,
      localDateTime: input.localDateTime,
      timeZone: input.timeZone,
      matterName: input.matter?.name ?? null,
      personName: input.person?.name ?? null,
      confirmationDueLocalDateTime: input.requiresConfirmation ? input.confirmationDueLocalDateTime : null,
      actions: input.customer.mode === 'new' ? ['创建客户', '创建下一步'] : ['创建下一步'],
    },
  };
}

export function confirmQuickCaptureDraft<T>(
  draft: QuickCaptureDraft,
  submit: (command: QuickCaptureCommand, idempotencyKey: string) => Promise<T>,
): Promise<T> {
  return submit(draft.command, draft.idempotencyKey);
}

export async function saveAndRefreshQuickCaptureDraft<T>(
  draft: QuickCaptureDraft,
  submit: (command: QuickCaptureCommand, idempotencyKey: string) => Promise<T>,
  refresh: () => Promise<unknown>,
): Promise<
  | { saved: true; refreshed: true; receipt: T }
  | { saved: true; refreshed: false; receipt: T; refreshError: unknown }
> {
  const receipt = await confirmQuickCaptureDraft(draft, submit);
  try {
    await refresh();
    return { saved: true, refreshed: true, receipt };
  } catch (refreshError) {
    return { saved: true, refreshed: false, receipt, refreshError };
  }
}
