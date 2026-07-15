/**
 * Format an instant as YYYY-MM-DD in the product business zone (Asia/Shanghai by default).
 * Invalid Date values and invalid IANA time-zone identifiers throw RangeError.
 */
export function localYmd(date: Date, timeZone = 'Asia/Shanghai'): string {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid date');
  const parts = new Intl.DateTimeFormat('en', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  const year = part('year'); const month = part('month'); const day = part('day');
  if (!year || !month || !day) throw new RangeError('Unable to format date');
  return `${year}-${month}-${day}`;
}
