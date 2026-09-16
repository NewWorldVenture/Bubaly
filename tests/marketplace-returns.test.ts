import { describe, it, expect } from 'vitest';
import {
  daysUntilDue, returnStatus, isOverdue, returnLabel, needsDueReminder, needsOverdueAlert,
} from '@/lib/marketplace/returns';
import { dayKeyIn } from '@/lib/time/zoned';

// A day KEY. The old fixture built `NOW` with `setHours` + `setDate` +
// `toISOString`, so what every assertion below MEANT depended on the TZ the
// suite happened to run under — which is why CI runs it under two.
const TODAY = '2026-07-13';
const dayFromNow = (n: number) =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

describe('daysUntilDue', () => {
  it('counts whole days to the due date', () => {
    expect(daysUntilDue(dayFromNow(3), TODAY)).toBe(3);
    expect(daysUntilDue(dayFromNow(0), TODAY)).toBe(0);
    expect(daysUntilDue(dayFromNow(-2), TODAY)).toBe(-2);
    expect(daysUntilDue(null, TODAY)).toBeNull();
  });
});

describe('returnStatus', () => {
  const borrow = (endsOn: string | null, extra: Partial<{ status: string; returnedAt: string | null }> = {}) =>
    ({ kind: 'borrow', status: 'active', endsOn, ...extra });

  it('ignores non-rent/borrow kinds', () => {
    expect(returnStatus({ kind: 'buy', status: 'active', endsOn: dayFromNow(-1) }, TODAY)).toBe('not_applicable');
  });
  it('buckets by due date', () => {
    expect(returnStatus(borrow(dayFromNow(5)), TODAY)).toBe('upcoming');
    expect(returnStatus(borrow(dayFromNow(2)), TODAY)).toBe('due_soon');
    expect(returnStatus(borrow(dayFromNow(0)), TODAY)).toBe('due_today');
    expect(returnStatus(borrow(dayFromNow(-3)), TODAY)).toBe('overdue');
  });
  it('treats returned/completed as returned, cancelled as N/A', () => {
    expect(returnStatus(borrow(dayFromNow(-3), { status: 'returned' }), TODAY)).toBe('returned');
    expect(returnStatus(borrow(dayFromNow(-3), { status: 'completed' }), TODAY)).toBe('returned');
    expect(returnStatus(borrow(dayFromNow(-3), { returnedAt: '2026-07-10' }), TODAY)).toBe('returned');
    expect(returnStatus(borrow(dayFromNow(-3), { status: 'cancelled' }), TODAY)).toBe('not_applicable');
  });
  it('isOverdue only for a live overdue borrow', () => {
    expect(isOverdue(borrow(dayFromNow(-1)), TODAY)).toBe(true);
    expect(isOverdue(borrow(dayFromNow(1)), TODAY)).toBe(false);
    expect(isOverdue(borrow(dayFromNow(-1), { returnedAt: 'x' }), TODAY)).toBe(false);
  });
});

describe('returnLabel', () => {
  it('renders each state with a tone', () => {
    expect(returnLabel('overdue', dayFromNow(-3), TODAY)).toEqual({ text: 'Overdue by 3 days', tone: 'danger' });
    expect(returnLabel('due_today', dayFromNow(0), TODAY)).toEqual({ text: 'Due today', tone: 'warn' });
    expect(returnLabel('due_soon', dayFromNow(1), TODAY)).toEqual({ text: 'Due in 1 day', tone: 'warn' });
    expect(returnLabel('upcoming', dayFromNow(4), TODAY)).toEqual({ text: 'Due in 4 days', tone: 'info' });
    expect(returnLabel('returned', null, TODAY)).toEqual({ text: 'Returned', tone: 'ok' });
    expect(returnLabel('not_applicable', null, TODAY)).toBeNull();
  });
});

describe('cron helpers', () => {
  it('needsDueReminder fires once in the window', () => {
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(1), dueReminderSentAt: null }, TODAY)).toBe(true);
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(0), dueReminderSentAt: null }, TODAY)).toBe(true);
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(5), dueReminderSentAt: null }, TODAY)).toBe(false);
    expect(needsDueReminder({ kind: 'borrow', status: 'active', endsOn: dayFromNow(1), dueReminderSentAt: '2026-07-13' }, TODAY)).toBe(false);
  });
  it('needsOverdueAlert fires once when overdue', () => {
    expect(needsOverdueAlert({ kind: 'rent', status: 'active', endsOn: dayFromNow(-1), overdueNotifiedAt: null }, TODAY)).toBe(true);
    expect(needsOverdueAlert({ kind: 'rent', status: 'active', endsOn: dayFromNow(-1), overdueNotifiedAt: '2026-07-13' }, TODAY)).toBe(false);
    expect(needsOverdueAlert({ kind: 'rent', status: 'active', endsOn: dayFromNow(2), overdueNotifiedAt: null }, TODAY)).toBe(false);
  });
});

/**
 * The defect these helpers were changed for, stated where it can fail.
 *
 * Every assertion above passes just as happily against the old
 * `setHours(0, 0, 0, 0)` implementation, because none of them names an instant
 * where the host's day and the family's day disagree. These do.
 *
 * Two surfaces, two different exposures, and they are worth separating:
 *
 *   - The ORDERS PAGE is server-rendered on demand, so it was wrong for the
 *     last seven hours of every Californian day — 29% of it.
 *   - The CRON runs at 08:00 UTC, which is deliberately the hour where most
 *     inhabited zones share the UTC date (UTC-8 through UTC+13 all agree). It
 *     is UTC-9 and further west that do not: Alaska and Hawaii are a full day
 *     behind at that instant, and their reminders were keyed to tomorrow.
 */
describe('an item due today is not "overdue" because the server is ahead', () => {
  // 2026-07-13T18:00 in Los Angeles === 2026-07-14T01:00Z.
  const EVENING_IN_LA = new Date('2026-07-14T01:00:00Z');
  const laToday = dayKeyIn(EVENING_IN_LA, 'America/Los_Angeles');
  const borrow = (endsOn: string | null) => ({ kind: 'borrow', status: 'active', endsOn });

  it('the family is still on the 13th while the host has rolled to the 14th', () => {
    expect(laToday).toBe('2026-07-13');
    expect(EVENING_IN_LA.toISOString().slice(0, 10)).toBe('2026-07-14');
  });

  it('calls an item due today "Due today", not "Overdue by 1 day"', () => {
    expect(returnStatus(borrow('2026-07-13'), laToday)).toBe('due_today');
    expect(returnLabel('due_today', '2026-07-13', laToday)).toEqual({ text: 'Due today', tone: 'warn' });
    expect(isOverdue(borrow('2026-07-13'), laToday)).toBe(false);
  });

  it('does not count tomorrow as today', () => {
    expect(returnLabel('due_soon', '2026-07-14', laToday)).toEqual({ text: 'Due in 1 day', tone: 'warn' });
  });

  /**
   * Why the cron case is worse than "a day early". `overdue_notified_at` and
   * `due_reminder_sent_at` are one-shot — set once, never cleared — and an
   * overdue alert `continue`s past the due-soon nudge. So the wrong day does
   * not delay the notification, it SPENDS it: the family is told the item is
   * already late on the morning it is actually due, and the "Due today" nudge
   * they should have had never arrives, because the order is now stamped.
   */
  it('does not spend the one overdue alert on an item that is not yet late', () => {
    const order = { kind: 'rent', status: 'active', endsOn: '2026-07-13', overdueNotifiedAt: null };
    expect(needsOverdueAlert(order, laToday)).toBe(false);
    // ...and the nudge that SHOULD go out is the due-today one.
    expect(needsDueReminder(
      { kind: 'rent', status: 'active', endsOn: '2026-07-13', dueReminderSentAt: null },
      laToday,
    )).toBe(true);
  });

  /**
   * The other side of the same defect. 08:00 UTC on the 13th is 22:00 on the
   * 12th in Honolulu, so the host is a day AHEAD of the family, and an item due
   * on the 13th was being nudged as "due today" while the family still had a
   * full day left — again spending the one-shot stamp.
   */
  it('a family in Hawaii is not chased a day early at cron time', () => {
    const CRON_INSTANT = new Date('2026-07-13T08:00:00Z');
    const hawaiiToday = dayKeyIn(CRON_INSTANT, 'Pacific/Honolulu');
    expect(hawaiiToday).toBe('2026-07-12');
    expect(CRON_INSTANT.toISOString().slice(0, 10)).toBe('2026-07-13');
    expect(returnStatus({ kind: 'borrow', status: 'active', endsOn: '2026-07-13' }, hawaiiToday)).toBe('due_soon');
    expect(returnLabel('due_soon', '2026-07-13', hawaiiToday)).toEqual({ text: 'Due in 1 day', tone: 'warn' });
  });
});
