import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { billCadence, billPaidPatch, nextBillDueDate } from '@/lib/finance/hub';
import { bodyOf } from './helpers/source-order';

/**
 * A RECURRING BILL, MARKED PAID, NEVER CAME DUE AGAIN.
 *
 * A bill is one row: `due_date`, `status`, and for a recurring one
 * `is_recurring` + `recurrence`. Both "Mark paid" buttons (the Bill Manager,
 * components/finance/bills-view.tsx; the Billing module,
 * components/modules/billing-module.tsx) wrote `status: 'paid'` and nothing
 * else — so a monthly bill, once paid, sat on its old due date as `paid` for
 * ever. Every "due soon" reader (the brief, the briefing API, the operating
 * index, readiness, the Due Reminders tab, the Finances card) selects
 * `status <> 'paid'`, so the household was reminded of the bill exactly once.
 * The forecast (lib/finance/timeline.ts) disagreed with all of them: it keeps
 * a paid recurring bill's later occurrences, so the money showed in the
 * projection and nowhere else.
 *
 * The fix is one pure decision, `billPaidPatch`, that both buttons write: a
 * one-off is paid; a recurring bill rolls to its next due date and stays
 * open. The Bill Manager's add form, which flagged a bill recurring without
 * ever recording a cadence, now records one.
 */

const ROOT = join(__dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('billCadence', () => {
  it('reads the recorded cadence, with the forecast\'s aliases', () => {
    expect(billCadence({ is_recurring: true, recurrence: 'monthly' })).toBe('monthly');
    expect(billCadence({ is_recurring: true, recurrence: 'Quarterly' })).toBe('quarterly');
    expect(billCadence({ is_recurring: true, recurrence: 'fortnightly' })).toBe('biweekly');
    expect(billCadence({ is_recurring: true, recurrence: 'annually' })).toBe('yearly');
  });
  it('a one-off has none, and a recorded cadence on an unflagged row still counts', () => {
    expect(billCadence({ is_recurring: false, recurrence: null })).toBeNull();
    expect(billCadence({ is_recurring: null, recurrence: null })).toBeNull();
    expect(billCadence({ is_recurring: false, recurrence: 'weekly' })).toBe('weekly');
  });
  it('a bill flagged recurring with no cadence — what the Bill Manager wrote — reads as monthly', () => {
    expect(billCadence({ is_recurring: true, recurrence: null })).toBe('monthly');
    expect(billCadence({ is_recurring: true, recurrence: '' })).toBe('monthly');
  });
});

describe('nextBillDueDate', () => {
  it('rolls a monthly bill to next month once it is paid', () => {
    expect(nextBillDueDate('2026-10-01', 'monthly', '2026-10-03')).toBe('2026-11-01');
  });
  it('keeps the series anchor when a bill is paid early', () => {
    expect(nextBillDueDate('2026-10-15', 'monthly', '2026-10-03')).toBe('2026-11-15');
    expect(nextBillDueDate('2026-10-15', 'monthly', '2026-10-15'), 'paid on the day').toBe('2026-11-15');
  });
  it('a stale bill marked paid lands on the first occurrence still ahead, not on every month in between', () => {
    expect(nextBillDueDate('2026-03-01', 'monthly', '2026-10-03')).toBe('2026-11-01');
    expect(nextBillDueDate('2025-10-03', 'yearly', '2026-10-03'), 'due today a year on').toBe('2027-10-03');
  });
  it('clamps a month-end anchor to a short month and comes back to it', () => {
    expect(nextBillDueDate('2026-01-31', 'monthly', '2026-02-01')).toBe('2026-02-28');
    // Stepped from the anchor, not from Feb 28: March is the 31st again.
    expect(nextBillDueDate('2026-01-31', 'monthly', '2026-02-28')).toBe('2026-03-31');
    expect(nextBillDueDate('2026-11-30', 'quarterly', '2026-12-01')).toBe('2027-02-28');
    expect(nextBillDueDate('2024-02-29', 'yearly', '2024-03-01')).toBe('2025-02-28');
  });
  it('steps weekly and biweekly bills by days', () => {
    expect(nextBillDueDate('2026-10-02', 'weekly', '2026-10-03')).toBe('2026-10-09');
    expect(nextBillDueDate('2026-10-02', 'biweekly', '2026-10-03')).toBe('2026-10-16');
    expect(nextBillDueDate('2026-01-02', 'weekly', '2026-10-03'), 'a stale weekly bill').toBe('2026-10-09');
  });
  it('refuses a due date that is not a calendar day, and ignores a malformed today', () => {
    expect(nextBillDueDate('2026-02-30', 'monthly', '2026-10-03')).toBeNull();
    expect(nextBillDueDate('soon', 'monthly', '2026-10-03')).toBeNull();
    expect(nextBillDueDate('2026-10-01', 'monthly', 'today')).toBe('2026-11-01');
  });
});

describe('billPaidPatch — what "Mark paid" writes', () => {
  const today = '2026-10-03';
  it('a one-off is paid and stays paid', () => {
    expect(billPaidPatch({ due_date: '2026-10-01', status: 'upcoming', is_recurring: false, recurrence: null }, today)).toEqual({ status: 'paid' });
  });
  it('a recurring bill rolls to its next due date and stays open', () => {
    expect(billPaidPatch({ due_date: '2026-10-01', status: 'overdue', is_recurring: true, recurrence: 'monthly' }, today))
      .toEqual({ status: 'upcoming', due_date: '2026-11-01' });
    expect(billPaidPatch({ due_date: '2026-10-02', status: 'upcoming', is_recurring: true, recurrence: 'weekly' }, today))
      .toEqual({ status: 'upcoming', due_date: '2026-10-09' });
  });
  it('a bill the Bill Manager flagged recurring without a cadence rolls monthly rather than closing', () => {
    expect(billPaidPatch({ due_date: '2026-10-01', status: 'upcoming', is_recurring: true, recurrence: null }, today))
      .toEqual({ status: 'upcoming', due_date: '2026-11-01' });
  });
  it('a recurring bill whose due date is not a day falls back to paid rather than throwing', () => {
    expect(billPaidPatch({ due_date: 'soon', status: 'upcoming', is_recurring: true, recurrence: 'monthly' }, today)).toEqual({ status: 'paid' });
  });
});

describe('both Mark paid buttons write the patch, in the family\'s day', () => {
  it('the Bill Manager', () => {
    const src = read('components/finance/bills-view.tsx');
    expect(src).toContain("import { useFamilyCalendarToday, useFamilyClock } from '@/components/i18n/use-format';");
    const body = bodyOf(src, 'async function markPaid(b: Bill) {', "success(reopen ? 'Reopened' : 'Marked paid');");
    expect(body).toContain('billPaidPatch(b, clock.todayKey())');
    expect(body).toContain('.update(patch)');
    expect(body, 'the old flat write is gone').not.toContain("update({ status: next })");
    // Reopening a one-off is still a plain status flip.
    expect(body).toContain("reopen ? { status: 'upcoming' as const } : billPaidPatch");
  });
  it('the Billing module', () => {
    const src = read('components/modules/billing-module.tsx');
    expect(src).toContain("import { billPaidPatch } from '@/lib/finance/hub';");
    const body = bodyOf(src, 'async function markBillPaid(id: string) {', "success(tr('billingModule.billMarkedAsPaid'));");
    expect(body).toContain('billPaidPatch(bill, clock.todayKey())');
    expect(body).toContain('.update(patch)');
    expect(body).not.toContain("update({ status: 'paid' })");
  });
  it('the Bill Manager\'s add form records a cadence for a recurring bill', () => {
    const src = read('components/finance/bills-view.tsx');
    const modal = bodyOf(src, 'function BillModal(', "success(t('billsView.billAdded'));");
    expect(modal).toContain("recurrence: v.is_recurring ? v.recurrence : null");
    expect(modal).toContain("recurrence: 'monthly'");
    // The same five cadences the Billing module offers, under the same keys.
    for (const cadence of ['weekly', 'biweekly', 'monthly', 'quarterly', 'yearly']) {
      expect(src).toContain(`<option value="${cadence}">{t('billing.${cadence}')}</option>`);
    }
  });
});
