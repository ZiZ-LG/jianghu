export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * Format a Date as the calendar day in the product business time zone.
 * Invalid Date values and invalid IANA time-zone names deliberately throw RangeError.
 */
export function businessYmd(date: Date = new Date(), timeZone: string = BUSINESS_TIME_ZONE): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid time value');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new RangeError('Unable to format business date');
  return `${year}-${month}-${day}`;
}

const ymdUtc = (ymd: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return Number.NaN;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = Date.UTC(year, month - 1, day);
  const parsed = new Date(value);
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    ? value
    : Number.NaN;
};

/** Calendar-day distance between two strict YYYY-MM-DD values; malformed input returns NaN. */
export function businessDayDistance(laterYmd: string, earlierYmd: string): number {
  return Math.floor((ymdUtc(laterYmd) - ymdUtc(earlierYmd)) / 86_400_000);
}

/** Shift the Asia/Shanghai business day of a Date by whole calendar days. */
export function shiftBusinessYmd(date: Date, days: number): string {
  const value = ymdUtc(businessYmd(date));
  const shifted = new Date(value + days * 86_400_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}
