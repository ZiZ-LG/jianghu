import { describe, expect, it } from 'vitest';
import { businessYmd } from '../src/businessDate.js';

describe('businessYmd', () => {
  it('formats the product business day in Asia/Shanghai by default', () => {
    expect(businessYmd(new Date('2026-07-14T16:30:00.000Z'))).toBe('2026-07-15');
  });

  it('supports an explicit valid IANA time zone', () => {
    expect(businessYmd(new Date('2026-07-14T16:30:00.000Z'), 'America/Los_Angeles')).toBe('2026-07-14');
  });

  it('throws RangeError for an invalid Date', () => {
    expect(() => businessYmd(new Date(Number.NaN))).toThrow(RangeError);
  });

  it('throws RangeError for an invalid IANA time zone', () => {
    expect(() => businessYmd(new Date(), 'Mars/Olympus_Mons')).toThrow(RangeError);
  });
});
