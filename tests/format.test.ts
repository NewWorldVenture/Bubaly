import { describe, it, expect } from 'vitest';
import { fmtDate, fmtTime, fmtDateTime, fmtRelative, initials, fmtMoney } from '@/lib/utils/format';

// Regression: date-fns format/isToday/formatDistanceToNow THROW on an Invalid
// Date — a single malformed timestamp crashed the Kitchen Display kiosk into an
// endless recover loop in prod. Every helper must render '' instead of throwing.
describe('date helpers never throw', () => {
  const bad = ['garbage', '2026-13-99T99:99:99Z', 'null', '0000-00-00'];

  it('returns "" for unparseable values (no RangeError)', () => {
    for (const v of bad) {
      expect(fmtDate(v)).toBe('');
      expect(fmtTime(v)).toBe('');
      expect(fmtDateTime(v)).toBe('');
      expect(fmtRelative(v)).toBe('');
    }
  });

  it('returns "" for null/undefined/empty', () => {
    expect(fmtTime(null)).toBe('');
    expect(fmtTime(undefined)).toBe('');
    expect(fmtDate('')).toBe('');
  });

  it('accepts an Invalid Date object without throwing', () => {
    const invalid = new Date('nope');
    expect(fmtTime(invalid)).toBe('');
    expect(fmtRelative(invalid)).toBe('');
  });
});

describe('date helpers still format valid input', () => {
  it('formats ISO timestamps', () => {
    expect(fmtTime('2026-07-14T14:30:00Z')).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(fmtDate('2026-07-14T14:30:00Z')).toContain('Jul');
  });

  it('accepts Postgres-style timestamps (space separator, offset)', () => {
    // parseISO rejects these; the native-Date fallback must handle them.
    expect(fmtTime('2026-07-14 14:30:00+00')).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(fmtDate('2026-07-14 14:30:00+00')).toContain('Jul');
  });

  it('formats Date objects', () => {
    expect(fmtTime(new Date('2026-07-14T09:05:00'))).toBe('9:05 AM');
  });
});

describe('initials / money (unchanged behavior)', () => {
  it('builds initials safely', () => {
    expect(initials('Jordan Lee')).toBe('JL');
    expect(initials(null)).toBe('?');
  });
  it('formats cents', () => {
    expect(fmtMoney(1250)).toBe('$12.50');
  });
});
