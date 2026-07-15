import { describe, expect, it } from 'vitest';
import { localYmd } from './dateYmd';

describe('localYmd', () => {
  it('uses the Beijing business day at 00:30 instead of truncating UTC', () => {
    const beijing0030 = new Date('2026-07-15T00:30:00+08:00');

    expect(localYmd(beijing0030)).toBe('2026-07-15');
  });

  it('honors an explicitly supplied IANA time zone', () => {
    const instant = new Date('2026-07-15T06:30:00Z');

    expect(localYmd(instant, 'America/Los_Angeles')).toBe('2026-07-14');
    expect(localYmd(instant, 'Asia/Shanghai')).toBe('2026-07-15');
  });

  it('throws RangeError for an invalid Date or IANA time zone', () => {
    expect(() => localYmd(new Date('not-a-date'))).toThrow(RangeError);
    expect(() => localYmd(new Date('2026-07-15T00:00:00Z'), 'Mars/Olympus')).toThrow(RangeError);
  });
});
