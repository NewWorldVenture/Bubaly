import { describe, it, expect } from 'vitest';
import { buildCalendarEventForDate } from '@/lib/relationship/calendar';

describe('buildCalendarEventForDate', () => {
  it('maps a recurring anniversary to a yearly all-day event', () => {
    const ev = buildCalendarEventForDate(
      { kind: 'anniversary', title: 'Our anniversary', eventDate: '2018-07-01', recursAnnually: true },
      'fam-1', 'user-1',
    );
    expect(ev).toMatchObject({
      family_id: 'fam-1', created_by: 'user-1', title: 'Our anniversary',
      category: 'general', all_day: true, recurrence: 'yearly',
    });
    expect(ev.starts_at).toBe('2018-07-01T00:00:00.000Z');
    expect(ev.ends_at).toBe('2018-07-02T00:00:00.000Z');
  });

  it('uses the birthday category', () => {
    const ev = buildCalendarEventForDate(
      { kind: 'birthday', title: 'Sam’s birthday', eventDate: '1990-06-29', recursAnnually: true },
      'fam-1', null,
    );
    expect(ev.category).toBe('birthday');
    expect(ev.created_by).toBeNull();
  });

  it('maps a one-off date night to a non-recurring event with location', () => {
    const ev = buildCalendarEventForDate(
      { kind: 'date_night', title: 'Dinner out', eventDate: '2026-07-04', recursAnnually: false, location: 'Bistro' },
      'fam-1', 'user-1',
    );
    expect(ev.recurrence).toBe('none');
    expect(ev.location).toBe('Bistro');
  });
});

describe('canonical relationship DATE boundaries', () => {
  it.each([
    ['0001-01-01', '0001-01-02'],
    ['2026-01-31', '2026-02-01'],
    ['2024-02-29', '2024-03-01'],
    ['2026-12-31', '2027-01-01'],
    ['9999-12-30', '9999-12-31'],
  ])('stores %s through exclusive %s', (day, next) => {
    const event = buildCalendarEventForDate({ kind: 'anniversary', title: 'Synthetic', eventDate: day, recursAnnually: false }, 'family', null);
    expect(event.starts_at).toBe(`${day}T00:00:00.000Z`);
    expect(event.ends_at).toBe(`${next}T00:00:00.000Z`);
    expect(event.all_day).toBe(true);
  });
  it.each(['0000-01-01', '2026-02-29', '2026-13-01', '2026-02-30', '9999-12-31', '2026-10-08T12:00:00Z', ' 2026-10-08'])('refuses invalid or unrepresentable DATE %s', (eventDate) => {
    expect(() => buildCalendarEventForDate({ kind: 'birthday', title: 'Synthetic', eventDate, recursAnnually: true }, 'family', null)).toThrow(RangeError);
  });
});
