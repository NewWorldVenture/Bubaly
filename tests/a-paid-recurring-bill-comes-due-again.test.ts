import { describe, it, expect } from 'vitest';
import {
  billCadence,
  billAnchorDay,
  billPaidPatch,
  newBillDueDay,
  nextBillDueDate,
  isMissingDueDayColumn,
} from '@/lib/finance/recurring';
import { saveBillPayment } from '@/lib/finance/bills';
import { buildCashflowTimeline } from '@/lib/finance/timeline';
import { bill, store } from './helpers/recurring-bill-store';

describe('paid bills preserve their schedule', () => {
  it('keeps a known month end through persisted consecutive short months', () => {
    let row = bill({ due_day: 31 });
    for (const date of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
      const patch = billPaidPatch(row, row.due_date);
      expect(patch).toMatchObject({ status: 'upcoming', due_date: date, due_day: 31 });
      row = { ...row, ...patch };
    }
  });
  it('restores leap day and catches up ancient weekly schedules', () => {
    expect(nextBillDueDate('2024-02-29', 'yearly', '2027-03-01', 29)).toBe('2028-02-29');
    expect(nextBillDueDate('1800-01-01', 'weekly', '2026-01-31')).toBe('2026-02-04');
  });
  it('pays one-offs with old recurrence text permanently', async () => {
    const row = bill({ is_recurring: false });
    const db = store(row);
    await saveBillPayment(db.client, row.family_id, row, row.due_date);
    expect(db.current()).toMatchObject({ status: 'paid', due_date: row.due_date });
  });
  it('records new owner-selected dates even when legacy dates would be ambiguous', () => {
    expect(newBillDueDay('2026-02-28', true, 'monthly')).toBe(28);
    expect(billAnchorDay(bill({ due_date: '2026-02-28' }))).toBeNull();
    expect(billAnchorDay(bill({ due_date: '2026-02-28', due_day: 31 }))).toBe(31);
  });
  it('normalizes only real cadence names', () => {
    expect(billCadence(bill({ recurrence: ' Fortnightly ' }))).toBe('biweekly');
    for (const recurrence of [null, '', 'semimonthly', 'constructor', 'toString'])
      expect(billCadence(bill({ recurrence }))).toBeNull();
  });
  it('forecasts known persisted anchors and refuses ambiguous legacy calendars', () => {
    const forecast = (row: ReturnType<typeof bill>) =>
      buildCashflowTimeline({
        bills: [row],
        goals: [],
        events: [],
        startingBalance: 1000,
        now: new Date('2026-02-20T12:00:00Z'),
        horizonWeeks: 12,
      });
    const dates = forecast(bill({ due_date: '2026-02-28', due_day: 31 }))
      .weeks.flatMap((w) => w.moments)
      .map((m) => m.date);
    expect(dates).toContain('2026-03-31');
    expect(dates).not.toContain('2026-03-28');
    expect(() => forecast(bill({ due_date: '2026-02-28' }))).toThrow(/confirm/i);
    expect(() => forecast(bill({ recurrence: null }))).toThrow(/confirm/i);
  });
  it('recognizes only the exact absent bills anchor column', () => {
    expect(isMissingDueDayColumn({ code: '42703', message: 'column bills.due_day does not exist' })).toBe(
      true,
    );
    for (const error of [
      { code: '42703', message: 'column bills.due_day_backup does not exist' },
      { code: '42501', message: 'bills.due_day denied' },
      { code: '42P01', message: 'relation due_day_history does not exist' },
      { code: '42703', message: 'column "due_day" of relation "subscriptions" does not exist' },
    ])
      expect(isMissingDueDayColumn(error)).toBe(false);
  });
});
