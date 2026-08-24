import { dayInTimeZone } from './schedule-runner';

describe('schedule automation calendar day', () => {
  it('uses the budget time zone across a UTC day boundary', () => {
    const instant = new Date('2026-08-18T02:30:00.000Z');
    expect(dayInTimeZone(instant, 'America/New_York')).toBe('2026-08-17');
    expect(dayInTimeZone(instant, 'Asia/Tokyo')).toBe('2026-08-18');
  });

  it('uses the local calendar day during a daylight-saving transition', () => {
    expect(
      dayInTimeZone(new Date('2026-11-01T05:30:00.000Z'), 'America/New_York'),
    ).toBe('2026-11-01');
    expect(
      dayInTimeZone(new Date('2026-11-01T06:30:00.000Z'), 'America/New_York'),
    ).toBe('2026-11-01');
  });
});
