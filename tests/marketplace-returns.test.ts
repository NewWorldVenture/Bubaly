import { describe, it, expect } from 'vitest';
import {
  daysUntilDue, returnStatus, isOverdue, returnLabel, needsDueReminder, needsOverdueAlert,
} from '@/lib/marketplace/returns';
import { shiftLocalDay } from '@/lib/time/local-day';

const NOW = new Date('2026-07-13T12:00:00');

// `endsOn` is `marketplace_orders.ends_on`, a Postgres DATE — already a calendar
// day, not an instant. The module reads it as such: local midnight of the due
// day minus local midnight of `now` (lib/marketplace/returns.ts daysUntilDue).
// So the fixture must produce the day key the SAME way.
//
// The old helper built local midnight and then keyed it with
// `d.toISOString().slice(0, 10)`, which re-expresses that local moment at
// Greenwich. West of Greenwich that round-trips unchanged, which is why TZ=UTC
// and TZ=America/Los_Angeles stayed green; east of Greenwich local midnight is
// the previous day at Greenwich, so every key walked back one day and
// `dayFromNow(0)` handed the module yesterday. That literal was a statement
// about the host's offset, not about the contract.
const dayFromNow = (n: number) => shiftLocalDay(NOW, n);

describe('daysUntilDue', () => {
  it('counts whole days to the due date', () => {
    expect(daysUntilDue(dayFromNow(3), NOW)).toBe(3);
    expect(daysUntilDue(dayFromNow(0), NOW)).toBe(0);
    expect(daysUntilDue(dayFromNow(-2), NOW)).toBe(-2);
    expect(daysUntilDue(null, NOW)).toBeNull();
  });
});

describe('returnStatus', () => {
  const borrow = (endsOn: string | null, extra: Partial<{ status: string; returnedAt: string | null }> = {}) =>
    ({ kind: 'borrow', status: 'active', endsOn, ...extra });

  it('ignores non-rent/borrow kinds', () => {
    expect(returnStatus({ kind: 'buy', status: 'active', endsOn: dayFromNow(-1) }, NOW)).toBe('not_applicable');
  });
  it('buckets by due date', () => {
    expect(returnStatus(borrow(dayFromNow(5)), NOW)).toBe('upcoming');
    expect(returnStatus(borrow(dayFromNow(2)), NOW)).toBe('due_soon');
    expect(returnStatus(borrow(dayFromNow(0)), NOW)).toBe('due_today');
    expect(returnStatus(borrow(dayFromNow(-3)), NOW)).toBe('overdue');
  });
  it('treats returned/completed as returned, cancelled as N/A', () => {
    expect(returnStatus(borrow(dayFromNow(-3), { status: 'returned' }), NOW)).toBe('returned');
    expect(returnStatus(borrow(dayFromNow(-3), { status: 'completed' }), NOW)).toBe('returned');
    expect(returnStatus(borrow(dayFromNow(-3), { returnedAt: '2026-07-10' }), NOW)).toBe('returned');
    expect(returnStatus(borrow(dayFromNow(-3), { status: 'cancelled' }), NOW)).toBe('not_applicable');
  });
  it('isOverdue only for a live overdue borrow', () => {
    expect(isOverdue(borrow(dayFromNow(-1)), NOW)).toBe(true);
    expect(isOverdue(borrow(dayFromNow(1)), NOW)).toBe(false);
    expect(isOverdue(borrow(dayFromNow(-1), { returnedAt: 'x' }), NOW)).toBe(false);
  });
});

describe('returnLabel', () => {
  it('renders each state with a tone', () => {
    expect(returnLabel('overdue', dayFromNow(-3), NOW)).toEqual({ text: 'Overdue by 3 days', tone: 'danger' });
    expect(returnLabel('due_today', dayFromNow(0), NOW)).toEqual({ text: 'Due today', tone: 'warn' });
    expect(returnLabel('due_soon', dayFromNow(1), NOW)).toEqual({ text: 'Due in 1 day', tone: 'warn' });
    expect(returnLabel('upcoming', dayFromNow(4), NOW)).toEqual({ text: 'Due in 4 days', tone: 'info' });
    expect(returnLabel('returned')).toEqual({ text: 'Returned', tone: 'ok' });
    expect(returnLabel('not_applicable')).toBeNull();
  });
});

describe('cron helpers', () => {
  it('needsDueReminder fires once in the window', () => {
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(1), dueReminderSentAt: null }, NOW)).toBe(true);
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(0), dueReminderSentAt: null }, NOW)).toBe(true);
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(5), dueReminderSentAt: null }, NOW)).toBe(false);
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(1), dueReminderSentAt: '2026-07-13' }, NOW)).toBe(false);
  });
  it('needsOverdueAlert fires once when overdue', () => {
    expect(needsOverdueAlert({ kind: 'rent', status: 'active', endsOn: dayFromNow(-1), overdueNotifiedAt: null }, NOW)).toBe(true);
    expect(needsOverdueAlert({ kind: 'rent', status: 'active', endsOn: dayFromNow(-1), overdueNotifiedAt: '2026-07-13' }, NOW)).toBe(false);
    expect(needsOverdueAlert({ kind: 'rent', status: 'active', endsOn: dayFromNow(2), overdueNotifiedAt: null }, NOW)).toBe(false);
  });
});
