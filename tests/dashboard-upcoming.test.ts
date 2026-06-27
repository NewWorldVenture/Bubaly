import { describe, it, expect } from 'vitest';
import { mergeUpcoming } from '@/lib/dashboard/upcoming';

describe('mergeUpcoming', () => {
  const events = [
    { id: 'e1', title: 'Soccer practice', starts_at: '2026-06-29T17:00:00.000Z', all_day: false },
    { id: 'e2', title: 'School holiday', starts_at: '2026-06-30T00:00:00.000Z', all_day: true },
  ];
  const reminders = [
    { id: 'r1', title: 'Pay rent', remind_at: '2026-06-28T09:00:00.000Z' },
    { id: 'r2', title: 'No time', remind_at: null },
  ];

  it('merges and sorts chronologically, namespacing keys by kind', () => {
    const out = mergeUpcoming(events, reminders);
    expect(out.map((i) => i.key)).toEqual(['reminder:r1', 'event:e1', 'event:e2']);
    expect(out[0]).toMatchObject({ kind: 'reminder', id: 'r1', title: 'Pay rent', allDay: false });
    expect(out[1]).toMatchObject({ kind: 'event', id: 'e1', allDay: false });
    expect(out[2]).toMatchObject({ kind: 'event', id: 'e2', allDay: true });
  });

  it('drops reminders without a timestamp and bad dates', () => {
    const out = mergeUpcoming([], [{ id: 'r2', title: 'No time', remind_at: null }, { id: 'r3', title: 'Bad', remind_at: 'nope' }]);
    expect(out).toEqual([]);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, title: `E${i}`, starts_at: `2026-07-0${(i % 9) + 1}T10:00:00.000Z`, all_day: false }));
    expect(mergeUpcoming(many, [], 3)).toHaveLength(3);
    expect(mergeUpcoming(many, [], 0)).toHaveLength(0);
  });
});
