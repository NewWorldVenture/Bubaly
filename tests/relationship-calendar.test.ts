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
    expect(ev.starts_at).toBe('2018-07-01T12:00:00.000Z');
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
