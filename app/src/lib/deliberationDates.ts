import { localYmd } from './dateYmd';

export function deliberationBusinessYmd(date = new Date()): string {
  return localYmd(date);
}

export function actionCompletionBusinessDates(date = new Date()): { doneAt: string; evidenceOccurredAt: string } {
  const ymd = deliberationBusinessYmd(date);
  return { doneAt: ymd, evidenceOccurredAt: ymd };
}

export function isBusinessActionOverdue(
  action: { done: boolean; startDate: string; endDate?: string },
  date = new Date(),
): boolean {
  return !action.done && (action.endDate || action.startDate) < deliberationBusinessYmd(date);
}

export function addBusinessDaysYmd(baseYmd: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(baseYmd);
  if (!match || !Number.isInteger(days)) throw new RangeError('Invalid business date');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new RangeError('Invalid business date');
  }
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
