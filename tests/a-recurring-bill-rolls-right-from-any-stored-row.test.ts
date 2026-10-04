import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import {
  billAnchorDay, billCadence, billPaidPatch, isDueDayNotKept, isMissingDueDayColumn, newBillDueDay,
  nextBillDueDate, projectedNextCharge, subscriptionCadence, whereBillIsAsSeen, writeBillPatch, type DueDayNotKept,
} from '@/lib/finance/recurring';
import { buildCashflowTimeline, monthlyEquivalent } from '@/lib/finance/timeline';

/**
 * A RECURRING BILL ROLLS RIGHT FROM ANY ROW THE TABLE CAN HOLD.
 *
 * Two candidates repaired the same bill: this one, and draft #969
 * (codex/audit-goal-followups-20261004 at 745f181dd,
 * tests/recurring-bill-rollover.test.ts). These are #969's cases, run against
 * this implementation, so its evidence is kept with the code that lands. Three
 * of them found defects here, now fixed:
 *
 * - `recurrence` is free text, and a plain object lookup answered for
 *   `constructor` with Object itself; `' Fortnightly '` was not trimmed.
 * - The next due date was found by walking from the anchor with a cap, so a
 *   weekly bill a century stale had none and Mark paid closed it for good.
 * - The Mark paid compare-and-set matched the due date and status only, so a
 *   bill whose cadence changed under the button was rolled on the old one.
 *
 * Where the two designs differ on purpose, this file keeps the case and pins
 * this implementation's answer, with the reason:
 *
 * - #969 reads a stored 28th, 29th or 30th with no `due_day` as ambiguous (it
 *   may be a clamped 31st) and asks. Here the stored day is the anchor:
 *   nothing on main ever rolled `bills.due_date` (its only bill updates were
 *   status, autopay and delete), so a stored day is the day a person typed,
 *   and on a database without 0475 this change never clamps without the
 *   person's yes (a-month-end-bill-moves-only-when-asked.test.ts).
 * - #969 refuses every month-based payment on a database without 0475. Here
 *   only a roll whose day the due date cannot carry is held back; production's
 *   ledger ends at 0176, and refusing all of them would stop every monthly bill
 *   being marked paid there.
 * - #969 asks for a cadence when a recurring bill has none; here it is read as
 *   monthly (a-paid-recurring-bill-comes-due-again.test.ts says why).
 */

const FAMILY = 'family-1';

const bill = (over: Partial<Tables<'bills'>> = {}): Tables<'bills'> => ({
  id: 'bill-1', family_id: FAMILY, name: 'Synthetic rent', amount: 100,
  due_date: '2026-01-31', due_day: null, is_recurring: true, recurrence: 'monthly',
  status: 'upcoming', category: null, autopay: false, created_by: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); });
afterEach(() => { warn.mockRestore(); });

describe('the schedule', () => {
  it('keeps a 31st bill\'s day through consecutive short months', () => {
    let row = bill();
    for (const expected of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
      const patch = billPaidPatch(row, row.due_date);
      expect(patch).toMatchObject({ status: 'upcoming', due_date: expected, due_day: 31 });
      row = { ...row, ...patch };
    }
  });

  it.each([29, 30, 31])('brings day %s back after February instead of leaving it on the 28th', (day) => {
    const first = billPaidPatch(bill({ due_date: `2026-01-${day}`, due_day: day }), '2026-01-01');
    expect(first).toMatchObject({ due_date: '2026-02-28', due_day: day });
    const next = billPaidPatch(bill({ ...first }), '2026-02-28');
    expect(next).toMatchObject({ due_date: `2026-03-${day}`, due_day: day });
  });

  it('brings a yearly leap day back, and catches up a schedule however stale', () => {
    expect(nextBillDueDate('2025-02-28', 'yearly', '2027-03-01', 29)).toBe('2028-02-29');
    expect(nextBillDueDate('2015-01-31', 'monthly', '2026-03-30', 31)).toBe('2026-03-31');
    expect(nextBillDueDate('2026-01-31', 'monthly', '2026-03-31', 31)).toBe('2026-04-30');
    // Over 11,000 weeks: the walk stopped at 5,000 and there was no next date.
    expect(nextBillDueDate('1800-01-01', 'weekly', '2026-01-31')).toBe('2026-02-04');
    expect(billPaidPatch(bill({ due_date: '1800-01-01', recurrence: 'weekly' }), '2026-01-31')).toEqual({ status: 'upcoming', due_date: '2026-02-04' });
    // 1900-01-14 and 2026-10-04 are both Sundays 3,306 fortnights apart: the next is two weeks on.
    expect(nextBillDueDate('1900-01-14', 'biweekly', '2026-10-04')).toBe('2026-10-18');
    // The subscription projection catches up the same way, and a charge due today is still due.
    expect(projectedNextCharge('1800-01-01', 'weekly', '2026-02-04')).toBe('2026-02-04');
    expect(projectedNextCharge('1900-01-15', 'monthly', '2026-10-04')).toBe('2026-10-15');
    expect(projectedNextCharge('1900-01-31', 'monthly', '2026-02-10')).toBe('2026-02-28');
  });

  it('a stored day is the anchor, including a 28th, 29th or 30th (#969 asks here; see above)', () => {
    for (const date of ['2026-02-28', '2028-02-29', '2026-04-30', '2026-03-28', '2026-03-29', '2026-03-30']) {
      const row = bill({ due_date: date });
      expect(billAnchorDay(row)).toBe(Number(date.slice(8)));
      expect(billPaidPatch(row, date)).toMatchObject({ status: 'upcoming', due_day: Number(date.slice(8)) });
    }
  });

  it('records the day a new bill is entered on, even February 28', () => {
    expect(newBillDueDay('2026-02-28', true, 'monthly')).toBe(28);
    expect(newBillDueDay('2026-02-28', true, 'weekly')).toBeNull();
    expect(billAnchorDay(bill({ due_date: '2026-01-31' }))).toBe(31);
  });

  it('reads only the cadence table\'s own names, trimmed and in any case', () => {
    expect(billCadence(bill({ recurrence: ' Fortnightly ' }))).toBe('biweekly');
    expect(billCadence(bill({ recurrence: 'ANNUALLY' }))).toBe('yearly');
    for (const recurrence of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      // Not a cadence: a one-off stays a one-off, a flagged bill reads as monthly.
      expect(billCadence(bill({ recurrence, is_recurring: false }))).toBeNull();
      expect(billCadence(bill({ recurrence }))).toBe('monthly');
      expect(billPaidPatch(bill({ recurrence, is_recurring: false }), '2026-01-31')).toEqual({ status: 'paid' });
      expect(subscriptionCadence(recurrence)).toBe('monthly');
    }
    expect(subscriptionCadence(' Quarterly ')).toBe('quarterly');
  });

  it('forecasts the same anchored dates after the stored row has clamped', () => {
    const timeline = buildCashflowTimeline({ bills: [bill({ due_date: '2026-02-28', due_day: 31 })], goals: [], events: [], startingBalance: 1000, now: new Date('2026-02-23T00:00:00Z'), horizonWeeks: 12 });
    expect(timeline.weeks.flatMap((w) => w.moments).map((m) => m.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
});

/**
 * PostgREST as supabase-js really calls it, over a synthetic transport: each
 * PATCH's filters are applied to one stored row. `oldSchema` refuses a body
 * naming `due_day` the way a database without 0475 does; `overlap` holds two
 * requests until both have arrived.
 */
function store(initial: Tables<'bills'>, options: { oldSchema?: boolean; error?: string; overlap?: boolean } = {}) {
  let row = { ...initial };
  const requests: { url: URL; patch: Record<string, unknown> }[] = [];
  let release!: () => void;
  const bothEntered = new Promise<void>((resolve) => { release = resolve; });
  const client = createClient<Database>('https://synthetic-bills.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const patch = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, patch });
      if (options.overlap) { if (requests.length === 2) release(); await bothEntered; }
      if (options.error || (options.oldSchema && 'due_day' in patch)) return new Response(JSON.stringify({
        code: options.error ?? 'PGRST204', message: options.error ? 'write denied' : "Could not find the 'due_day' column of 'bills' in the schema cache",
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      if (options.oldSchema && url.searchParams.has('due_day')) return new Response(JSON.stringify({
        code: '42703', message: 'column bills.due_day does not exist',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const matches = [...url.searchParams].filter(([key]) => key !== 'select').every(([key, filter]) => {
        const value = row[key as keyof typeof row];
        return filter === 'is.null' ? value === null : filter === `eq.${String(value)}`;
      });
      if (matches) row = { ...row, ...patch };
      return new Response(JSON.stringify(matches ? [{ id: row.id }] : []), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { client, requests, current: () => row };
}

/** A row as a database without 0475 returns it: no `due_day` key at all. */
const readBefore0475 = (row: Tables<'bills'>): Tables<'bills'> => {
  const { due_day: _absent, ...rest } = row;
  return rest as Tables<'bills'>;
};

/**
 * Mark paid exactly as both buttons write it (components/finance/bills-view.tsx,
 * components/modules/billing-module.tsx; the chain is pinned in
 * a-paid-recurring-bill-comes-due-again.test.ts).
 */
function markPaid(client: ReturnType<typeof store>['client'], seen: Tables<'bills'>, today: string, confirmClampedDay?: (refusal: DueDayNotKept) => Promise<boolean>) {
  return writeBillPatch(billPaidPatch(seen, today), (p) => whereBillIsAsSeen(client.from('bills').update(p).eq('id', seen.id).eq('family_id', FAMILY), seen).select('id'),
    confirmClampedDay ? { confirmClampedDay } : {});
}

describe('Mark paid through supabase-js', () => {
  it('lets exactly one of two overlapping payments roll the bill', async () => {
    const original = bill();
    const db = store(original, { overlap: true });
    const results = await Promise.all([markPaid(db.client, original, '2026-01-31'), markPaid(db.client, original, '2026-01-31')]);
    expect(results.map((r) => (r.data as unknown[] | null)?.length).sort()).toEqual([0, 1]);
    expect(db.current()).toMatchObject({ due_date: '2026-02-28', due_day: 31, status: 'upcoming' });
    const filters = Object.fromEntries(db.requests[0].url.searchParams);
    expect(filters).toMatchObject({ due_date: 'eq.2026-01-31', status: 'eq.upcoming', is_recurring: 'eq.true', recurrence: 'eq.monthly' });
  });

  it('does not roll a bill on a cadence it no longer has', async () => {
    for (const edited of [bill({ recurrence: 'quarterly' }), bill({ is_recurring: false, recurrence: null })]) {
      const db = store(edited);
      const result = await markPaid(db.client, bill(), '2026-01-31');
      expect(result.data).toEqual([]);
      expect(db.current()).toEqual(edited);
    }
    // A bill seen with no cadence is matched on its absence.
    const db = store(bill({ recurrence: null }));
    await markPaid(db.client, bill({ recurrence: null }), '2026-01-31');
    expect(db.requests[0].url.searchParams.get('recurrence')).toBe('is.null');
    expect(db.current()).toMatchObject({ due_date: '2026-02-28' });
  });

  it('keeps the family scope on a matching bill id', async () => {
    const db = store(bill({ family_id: 'another-family' }));
    expect((await markPaid(db.client, bill(), '2026-01-31')).data).toEqual([]);
    expect(db.current().due_date).toBe('2026-01-31');
  });

  it('does not roll a bill on an anchor day it no longer has: an edit to due_day alone', async () => {
    // The button saw Feb 28 anchored on the 31st; the row has since been
    // anchored on the 30th. Rolled from what it saw it would land on Mar 31.
    const seen = bill({ due_date: '2026-02-28', due_day: 31 });
    const edited = bill({ due_date: '2026-02-28', due_day: 30 });
    const db = store(edited);
    const result = await markPaid(db.client, seen, '2026-02-28');
    expect(result.data).toEqual([]);
    expect(db.current()).toEqual(edited);
    expect(db.requests[0].url.searchParams.get('due_day')).toBe('eq.31');
    // The row as it now is rolls on its own anchor.
    const fresh = await markPaid(db.client, edited, '2026-02-28');
    expect(fresh.data).toEqual([{ id: 'bill-1' }]);
    expect(db.current()).toMatchObject({ due_date: '2026-03-30', due_day: 30 });
  });

  it('a row read without due_day (no 0475) is not compared on it: the filter would name a column that is not there', async () => {
    const original = readBefore0475(bill({ due_date: '2026-01-15' }));
    const db = store(original, { oldSchema: true });
    const result = await markPaid(db.client, original, '2026-01-15');
    expect(result.error).toBeNull();
    expect(db.requests.map((r) => r.url.searchParams.has('due_day'))).toEqual([false, false]);
    expect(db.current()).toMatchObject({ due_date: '2026-02-15' });
  });

  it('without 0475, holds back a roll only the column could keep, in one request, leaving the row as it was', async () => {
    const original = readBefore0475(bill());
    const db = store(original, { oldSchema: true });
    const result = await markPaid(db.client, original, '2026-01-31');
    expect(isDueDayNotKept(result.error)).toBe(true);
    expect(db.requests).toHaveLength(1);
    expect(db.current()).toEqual(original);
  });

  it('without 0475, a schedule whose date carries its day rolls (#969 refuses the monthly one; see above)', async () => {
    for (const over of [{ is_recurring: false, recurrence: null }, { recurrence: 'weekly' }]) {
      const row = readBefore0475(bill(over));
      const db = store(row, { oldSchema: true });
      const result = await markPaid(db.client, row, '2026-01-31');
      expect(result.error).toBeNull();
      expect(result.data).toEqual([{ id: 'bill-1' }]);
      expect(db.requests).toHaveLength(1);
      expect(db.requests[0].patch).not.toHaveProperty('due_day');
    }
    const fifteenth = readBefore0475(bill({ due_date: '2026-01-15' }));
    const db = store(fifteenth, { oldSchema: true });
    expect((await markPaid(db.client, fifteenth, '2026-01-15')).error).toBeNull();
    expect(db.requests.map((r) => 'due_day' in r.patch)).toEqual([true, false]);
    expect(db.current()).toMatchObject({ due_date: '2026-02-15' });
    expect(db.current()).not.toHaveProperty('due_day');
  });

  it('returns a denied write as it came, without retrying', async () => {
    const db = store(bill(), { error: '42501' });
    const result = await markPaid(db.client, bill(), '2026-01-31');
    expect(result.error).toMatchObject({ code: '42501' });
    expect(db.requests).toHaveLength(1);
    expect(isMissingDueDayColumn({ code: '42501', message: 'due_day denied' })).toBe(false);
  });
});

describe('Mark paid and the forecast read a stored bill the same way', () => {
  // The writer used to read cadence its own way (any name it knew, on any
  // row; a flagged bill with none was monthly) while the forecast only
  // lowercased, required the flag, and showed anything else once at $0 a
  // month. Both now read billCadence, so the date a payment rolls a bill to is
  // the next date the forecast shows, for every row the table can hold.
  const rows: Array<[string, Partial<Tables<'bills'>>]> = [
    ['a padded alias', { recurrence: ' Fortnightly ' }],
    ['a capitalised name', { recurrence: 'MONTHLY' }],
    ['a flagged bill with no cadence (the Bill Manager wrote these)', { recurrence: null }],
    ['a flagged bill with an empty cadence', { recurrence: '' }],
    ['a flagged bill whose cadence is no cadence', { recurrence: 'semimonthly' }],
    ['a flagged bill named after Object.prototype', { recurrence: 'constructor' }],
    ['an unflagged bill with a cadence', { is_recurring: false, recurrence: 'monthly' }],
    ['an unflagged bill with none', { is_recurring: false, recurrence: null }],
  ];
  const forecast = (row: Tables<'bills'>) => buildCashflowTimeline({
    bills: [row], goals: [], events: [], startingBalance: 1000, now: new Date('2026-01-31T00:00:00Z'), horizonWeeks: 12,
  }).weeks.flatMap((w) => w.moments).map((m) => m.date);

  it.each(rows)('%s', (_label, over) => {
    const row = bill(over);
    const patch = billPaidPatch(row, row.due_date);
    const dates = forecast(row);
    expect(dates[0]).toBe('2026-01-31');
    if (billCadence(row) === null) {
      expect(patch).toEqual({ status: 'paid' });
      expect(dates).toEqual(['2026-01-31']);
      expect(monthlyEquivalent(row)).toBe(0);
    } else {
      expect(patch).toMatchObject({ status: 'upcoming' });
      expect(dates[1]).toBe((patch as { due_date: string }).due_date);
      expect(monthlyEquivalent(row)).toBeGreaterThan(0);
    }
  });

  it('each is read as', () => {
    expect(rows.map(([, over]) => billCadence(bill(over)))).toEqual(['biweekly', 'monthly', 'monthly', 'monthly', 'monthly', 'monthly', null, null]);
    expect(monthlyEquivalent(bill({ recurrence: ' Fortnightly ' }))).toBeCloseTo(100 * 26 / 12);
    expect(monthlyEquivalent(bill({ recurrence: null }))).toBe(100);
  });
});
