import { describe, expect, it } from 'vitest';
import {
  actionCompletionBusinessDates,
  addBusinessDaysYmd,
  deliberationBusinessYmd,
  isBusinessActionOverdue,
} from './deliberationDates';

const beijing0030 = new Date('2026-07-15T00:30:00+08:00');

describe('DeliberationDock business dates', () => {
  it('uses the Beijing day for a new action at the midnight boundary', () => {
    expect(deliberationBusinessYmd(beijing0030)).toBe('2026-07-15');
  });

  it('uses the same Beijing day for doneAt and evidence occurredAt', () => {
    expect(actionCompletionBusinessDates(beijing0030)).toEqual({
      doneAt: '2026-07-15',
      evidenceOccurredAt: '2026-07-15',
    });
  });

  it('evaluates overdue state against the Beijing business day', () => {
    expect(isBusinessActionOverdue({ done: false, startDate: '2026-07-14', endDate: '2026-07-14' }, beijing0030)).toBe(true);
    expect(isBusinessActionOverdue({ done: false, startDate: '2026-07-15', endDate: '2026-07-15' }, beijing0030)).toBe(false);
    expect(isBusinessActionOverdue({ done: true, startDate: '2026-07-14', endDate: '2026-07-14' }, beijing0030)).toBe(false);
  });

  it('adds calendar days without inheriting the device time zone or DST', () => {
    expect(addBusinessDaysYmd('2026-03-08', 1)).toBe('2026-03-09');
    expect(addBusinessDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
  });
});
